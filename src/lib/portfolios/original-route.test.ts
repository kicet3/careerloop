/**
 * 포트폴리오 원본 보관·보기(PGlite + 로컬 저장소, 세션은 가짜):
 * multipart 업로드(PDF만)가 원본을 보관하고 GET /api/portfolios/[id]/original이 소유자에게만 그대로 내려준다(헤더 포함),
 * 예전에 올린 PDF 밖 원본(이미지·HTML·DOCX·TXT)은 그대로 보인다, 내용 바꾸기·링크로 바꾸기·지우기가 원본을 지운다,
 * R2 직접 업로드(서명 주소 받기 — PDF만, 마무리 — 바이트 재확인)와 그 격리·거절.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";
import sharp from "sharp";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioInfo } from "@/lib/domain/portfolios";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";
import { makeTestPdf } from "@/test/pdf";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-portfolio-original-")), "storage");

const state = vi.hoisted(() => ({ user: { id: "ua" } as { id: string } | null, crossOrigin: false }));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossOrigin ? Response.json({ error: "다른 출처" }, { status: 403 }) : null),
}));

let tdb: TestDb;
let listRoute: typeof import("@/app/api/portfolios/route");
let itemRoute: typeof import("@/app/api/portfolios/[id]/route");
let originalRoute: typeof import("@/app/api/portfolios/[id]/original/route");
let uploadsRoute: typeof import("@/app/api/portfolios/uploads/route");
let resumePortfolioRoute: typeof import("@/app/api/resumes/[id]/portfolio/route");
let storage: typeof import("@/lib/storage");
let resumes: typeof import("@/lib/resumes/service");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL", "PORTFOLIO_MAX_UPLOAD_MB"]) delete process.env[k];
  tdb = await createTestDb();
  listRoute = await import("@/app/api/portfolios/route");
  itemRoute = await import("@/app/api/portfolios/[id]/route");
  originalRoute = await import("@/app/api/portfolios/[id]/original/route");
  uploadsRoute = await import("@/app/api/portfolios/uploads/route");
  resumePortfolioRoute = await import("@/app/api/resumes/[id]/portfolio/route");
  storage = await import("@/lib/storage");
  resumes = await import("@/lib/resumes/service");
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  state.user = { id: "ua" };
  state.crossOrigin = false;
  delete process.env.PORTFOLIO_MAX_UPLOAD_MB;
});

const BASE = "http://localhost/api/portfolios";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const TEXT = "결제 정산 배치를 Kotlin으로 다시 만들었습니다. 처리 시간을 4시간에서 40분으로 줄였습니다.\n".repeat(3);
const HTML = `<html><body><script>alert(document.cookie)</script><p>${TEXT}</p></body></html>`;

function uploadReq(u: string, method: "POST" | "PUT", name: string, content: BlobPart, extra: Record<string, string> = {}) {
  const fd = new FormData();
  fd.set("file", new File([content], name));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return new Request(u, { method, body: fd });
}
const json = (u: string, method: string, body: unknown) =>
  new Request(u, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function created(res: Response): Promise<{ portfolio: PortfolioInfo; warnings: string[] }> {
  expect(res.status).toBe(201);
  return (await res.json()) as { portfolio: PortfolioInfo; warnings: string[] };
}
const row = (id: string) => tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } });
const getOriginal = (id: string, q = "") => originalRoute.GET(new Request(`${BASE}/${id}/original${q}`), ctx(id));

/** 예전(PDF만 받기 전)에 올린 원본: 업로드 경로를 거치지 않고 서비스로 바로 만든다(지금 업로드는 PDF만 받는다). */
async function legacy(fileName: string, bytes: Uint8Array, ext: string, mime: string, text = ""): Promise<PortfolioInfo> {
  const svc = await import("./service");
  return (await svc.createPortfolioFromFile("ua", { fileName, text, original: { ext, mime, size: bytes.byteLength, source: { bytes } } })).portfolio;
}

let png: Buffer;
beforeAll(async () => {
  png = await sharp({ create: { width: 40, height: 30, channels: 3, background: "#3366aa" } }).png().toBuffer();
});

describe("multipart 업로드(PDF만) → 원본 보관·보기", () => {
  it("PDF: 원본을 그대로 보관하고 글을 뽑아 두며, 소유자에게 inline·nosniff로 내려준다", async () => {
    const pdf = makeTestPdf(TEXT);
    const { portfolio: p } = await created(await listRoute.POST(uploadReq(BASE, "POST", "작업.pdf", pdf)));
    expect(p).toMatchObject({ kind: "file", fileName: "작업.pdf", original: { mime: "application/pdf", size: pdf.byteLength, view: "pdf" } });
    expect(p.chars).toBeGreaterThan(50);
    expect((await row(p.id)).originalKey).toMatch(new RegExp(`^users/ua/portfolios/${p.id}/original-[a-z0-9]+\\.pdf$`));
    const res = await getOriginal(p.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("application/pdf");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; filename="portfolio\.pdf"; filename\*=UTF-8''/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(Buffer.from(await res.arrayBuffer()).equals(Buffer.from(pdf))).toBe(true);
  });

  it("PDF 밖 형식(이미지·HTML·DOCX·HWP·MD·GIF)과 확장자만 .pdf인 파일은 415, 아무것도 만들지 않는다", async () => {
    for (const [name, body] of [
      ["작업.png", new Uint8Array(png)],
      ["site.html", HTML],
      ["a.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0])],
      ["a.hwp", new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1])],
      ["a.md", TEXT],
      ["a.gif", "GIF89a"],
    ] as const) {
      const res = await listRoute.POST(uploadReq(BASE, "POST", name, body));
      expect(res.status, name).toBe(415);
      expect(((await res.json()) as { error: string }).error).toContain("PDF만 올릴 수 있습니다");
    }
    const renamed = await listRoute.POST(uploadReq(BASE, "POST", "renamed.pdf", new Uint8Array(png)));
    expect(renamed.status).toBe(415);
    expect(((await renamed.json()) as { error: string }).error).toContain("PDF 형식이 아닙니다");
    expect(await tdb.prisma.portfolio.count()).toBe(0);
  });

  it("예전에 올린 PDF 밖 원본(이미지·HTML·DOCX·TXT)은 그대로 보이고 내려받을 수 있다(데이터를 바꾸지 않는다)", async () => {
    const img = await legacy("작업.png", new Uint8Array(png), "png", "image/png");
    expect(img).toMatchObject({ kind: "file", fileName: "작업.png", original: { mime: "image/png", view: "image" } });
    const res = await getOriginal(img.id);
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toBe("image/png");
    expect(res.headers.get("Content-Disposition")).toMatch(/^inline; filename="portfolio\.png"; filename\*=UTF-8''/);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(res.headers.get("Cache-Control")).toBe("private, no-store");
    expect(res.headers.get("Content-Security-Policy")).toMatch(/^sandbox;/);
    expect(Buffer.from(await res.arrayBuffer()).equals(png)).toBe(true);
    expect((await getOriginal(img.id, "?download=1")).headers.get("Content-Disposition")).toMatch(/^attachment;/);

    // HTML: 실행되지 않게 첨부·octet-stream·sandbox로만, DOCX가 아니면 HTML 보기 400
    const html = await legacy("site.html", new TextEncoder().encode(HTML), "html", "text/html", TEXT);
    expect(html.original).toMatchObject({ mime: "text/html", view: "text" });
    const h = await getOriginal(html.id);
    expect(h.headers.get("Content-Type")).toBe("application/octet-stream");
    expect(h.headers.get("Content-Disposition")).toMatch(/^attachment;/);
    expect(h.headers.get("Content-Security-Policy")).toMatch(/^sandbox;/);
    expect((await getOriginal(html.id, "?view=html")).status).toBe(400);

    // DOCX: 미리보기 HTML(sandbox), TXT: 그대로
    const docxBytes = zipSync({
      "[Content_Types].xml": strToU8(
        '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>',
      ),
      "_rels/.rels": strToU8(
        '<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="r1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
      "word/document.xml": strToU8(
        '<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>예전 DOCX 포트폴리오</w:t></w:r></w:p></w:body></w:document>',
      ),
    });
    const docx = await legacy("옛.docx", docxBytes, "docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", TEXT);
    expect(docx.original?.view).toBe("docx");
    const dv = await getOriginal(docx.id, "?view=html");
    expect(dv.status).toBe(200);
    expect(await dv.text()).toContain("예전 DOCX 포트폴리오");
    const txt = await legacy("메모.txt", new TextEncoder().encode(TEXT), "txt", "text/plain", TEXT);
    expect(await (await getOriginal(txt.id)).text()).toContain("40분");
  });

  it("남의 원본·로그인 안 함·원본 없는 항목(링크·예전 파일)은 404/401", async () => {
    const { portfolio: p } = await created(await listRoute.POST(uploadReq(BASE, "POST", "a.pdf", makeTestPdf(TEXT))));
    state.user = { id: "ub" };
    expect((await getOriginal(p.id)).status).toBe(404);
    expect((await getOriginal(p.id, "?download=1")).status).toBe(404);
    state.user = null;
    expect((await getOriginal(p.id)).status).toBe(401);
    state.user = { id: "ua" };
    expect((await getOriginal(p.id)).status).toBe(200);
    // 원본을 보관하기 전에 올린 항목: 글만 있다
    await tdb.prisma.portfolio.create({ data: { id: "legacy", userId: "ua", title: "옛", kind: "file", fileName: "a.pdf", chars: 10 } });
    expect((await getOriginal("legacy")).status).toBe(404);
    // 행이 남의 키를 가리키도록 조작돼 있어도 내주지 않는다
    await storage.putObject("users/ub/portfolios/x/original-a.png", png);
    await tdb.prisma.portfolio.create({
      data: { id: "forged", userId: "ua", title: "f", kind: "file", fileName: "a.png", originalKey: "users/ub/portfolios/x/original-a.png", originalMime: "image/png" },
    });
    expect((await getOriginal("forged")).status).toBe(404);
  });

  it("내용 바꾸기는 원본도 바꾸고 옛 원본을 지운다(예전 이미지 → PDF), PDF 밖으로는 못 바꾼다, 링크로 바꾸면 원본을 지운다, 지우면 다 지운다", async () => {
    const p = await legacy("a.png", new Uint8Array(png), "png", "image/png");
    const firstKey = (await row(p.id)).originalKey!;
    // PDF 밖 형식으로 바꾸기는 415 — 예전 원본은 그대로
    expect((await itemRoute.PUT(uploadReq(`${BASE}/${p.id}`, "PUT", "b.png", new Uint8Array(png)), ctx(p.id))).status).toBe(415);
    expect((await row(p.id)).originalKey).toBe(firstKey);
    expect(await storage.getObject(firstKey)).not.toBeNull();

    const pdf = makeTestPdf(TEXT);
    const replaced = await itemRoute.PUT(uploadReq(`${BASE}/${p.id}`, "PUT", "b.pdf", pdf), ctx(p.id));
    expect(replaced.status).toBe(200);
    const after = await row(p.id);
    expect(after.originalMime).toBe("application/pdf");
    expect(after.originalKey).not.toBe(firstKey);
    expect(await storage.getObject(firstKey)).toBeNull();
    expect(Buffer.from(await (await getOriginal(p.id)).arrayBuffer()).equals(Buffer.from(pdf))).toBe(true);

    const secondKey = after.originalKey!;
    expect((await itemRoute.PUT(json(`${BASE}/${p.id}`, "PUT", { url: "https://me.dev" }), ctx(p.id))).status).toBe(200);
    expect(await row(p.id)).toMatchObject({ kind: "url", originalKey: null, originalMime: null, originalSize: null });
    expect(await storage.getObject(secondKey)).toBeNull();
    expect((await getOriginal(p.id)).status).toBe(404);

    const { portfolio: q } = await created(await listRoute.POST(uploadReq(BASE, "POST", "c.pdf", makeTestPdf(TEXT))));
    expect((await itemRoute.DELETE(new Request(`${BASE}/${q.id}`, { method: "DELETE" }), ctx(q.id))).status).toBe(200);
    expect(await storage.listByPrefix(storage.userPrefix("ua", "portfolios", q.id))).toEqual([]);
  });

  it("다른 출처의 업로드·바꾸기·지우기는 403", async () => {
    const { portfolio: p } = await created(await listRoute.POST(uploadReq(BASE, "POST", "a.pdf", makeTestPdf(TEXT))));
    state.crossOrigin = true;
    expect((await listRoute.POST(uploadReq(BASE, "POST", "a.pdf", makeTestPdf(TEXT)))).status).toBe(403);
    expect((await itemRoute.PUT(uploadReq(`${BASE}/${p.id}`, "PUT", "b.pdf", makeTestPdf(TEXT)), ctx(p.id))).status).toBe(403);
    expect((await itemRoute.DELETE(new Request(`${BASE}/${p.id}`, { method: "DELETE" }), ctx(p.id))).status).toBe(403);
    expect((await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "a.pdf", size: 10 }))).status).toBe(403);
  });
});

describe("R2 직접 업로드(서명 주소 → 마무리)", () => {
  const stage = async (userId: string, uploadId: string, body: Uint8Array | string) =>
    storage.putObject(storage.uploadStagingKey(userId, `portfolio-${uploadId}`), body);
  const UID = "0123456789abcdef01234567.pdf";
  let pdf: Uint8Array;
  beforeAll(() => {
    pdf = makeTestPdf(TEXT);
  });
  const R2_ENV = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "AKIA_TEST", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" };

  it("로컬 저장소면 서명 주소 대신 409 direct(레이트 리밋을 세지 않는다), 입력 검사 415·413·400·401", async () => {
    const res = await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "큰파일.pdf", size: 20 * 1024 * 1024, type: "application/pdf" }));
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ direct: true });
    expect(await tdb.prisma.rateEvent.count()).toBe(0);
    expect((await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "a.exe", size: 10 }))).status).toBe(415);
    expect((await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "a.pdf", size: 31 * 1024 * 1024 }))).status).toBe(413);
    expect((await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "a.pdf", size: 0 }))).status).toBe(400);
    state.user = null;
    expect((await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "a.pdf", size: 10 }))).status).toBe(401);
  });

  it("서명 주소 받기: PDF가 아닌 이름·MIME은 주소를 주기 전에 415(레이트 리밋도 세지 않는다), PDF는 .pdf 임시 키에 서명", async () => {
    Object.assign(process.env, R2_ENV);
    try {
      for (const body of [
        { fileName: "a.docx", size: 10 },
        { fileName: "a.png", size: 10, type: "image/png" },
        { fileName: "a.hwp", size: 10 },
        { fileName: "a.pdf", size: 10, type: "image/png" },
        { fileName: "a.pdf.png", size: 10 },
      ]) {
        const res = await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", body));
        expect(res.status, body.fileName).toBe(415);
        const out = (await res.json()) as { error: string; url?: string };
        expect(out.error).toContain("PDF만 올릴 수 있습니다");
        expect(out.url).toBeUndefined();
      }
      expect(await tdb.prisma.rateEvent.count()).toBe(0);
      for (const type of ["application/pdf", "", undefined]) {
        const ok = await uploadsRoute.POST(json(`${BASE}/uploads`, "POST", { fileName: "포트폴리오.PDF", size: 10, type }));
        expect(ok.status).toBe(200);
        const out = (await ok.json()) as { uploadId: string; url: string };
        expect(out.uploadId).toMatch(/^[a-z0-9]+\.pdf$/);
        expect(new URL(out.url).pathname).toBe(`/uploads/ua/portfolio-${out.uploadId}`);
      }
    } finally {
      for (const k of Object.keys(R2_ENV)) delete process.env[k];
    }
  });

  it("마무리: 임시 키를 확인해 원본으로 옮기고 임시 파일을 지운다(이름·설명 포함)", async () => {
    await stage("ua", UID, pdf);
    const { portfolio: p } = await created(await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "디자인.pdf", title: "디자인", description: "역할" })));
    expect(p).toMatchObject({ title: "디자인", description: "역할", fileName: "디자인.pdf", original: { mime: "application/pdf", size: pdf.byteLength } });
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ua"))).toEqual([]);
    expect(Buffer.from(await (await getOriginal(p.id)).arrayBuffer()).equals(Buffer.from(pdf))).toBe(true);
  });

  it("마무리는 바이트를 다시 확인한다: .pdf 업로드 id에 PNG를 올렸으면 415 + 임시 파일 삭제, 예전 형식(.png) 업로드 id도 415", async () => {
    await stage("ua", UID, new Uint8Array(png));
    const res = await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "가짜.pdf" }));
    expect(res.status).toBe(415);
    expect(((await res.json()) as { error: string }).error).toContain("PDF 형식이 아닙니다");
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ua"))).toEqual([]);

    const OLD = "0123456789abcdef0123456a.png";
    await stage("ua", OLD, new Uint8Array(png));
    const old = await listRoute.POST(json(BASE, "POST", { uploadId: OLD, fileName: "a.png" }));
    expect(old.status).toBe(415);
    expect(((await old.json()) as { error: string }).error).toContain("PDF만 올릴 수 있습니다");
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ua"))).toEqual([]);
    expect(await tdb.prisma.portfolio.count()).toBe(0);
  });

  it("다른 사용자의 업로드 id로는 마무리할 수 없다(자기 임시 자리에서만 찾는다 — 404, 남의 임시 파일은 그대로)", async () => {
    await stage("ub", UID, pdf);
    expect((await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "a.pdf" }))).status).toBe(404);
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ub"))).toHaveLength(1);
    expect(await tdb.prisma.portfolio.count()).toBe(0);
  });

  it("형식이 틀리면 415·크기 초과면 413이고 임시 파일을 지운다, 업로드 id 형식·이름 불일치는 400", async () => {
    await stage("ua", UID, "not a pdf");
    expect((await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "a.pdf" }))).status).toBe(415);
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ua"))).toEqual([]);

    // 실패한 마무리도 그 업로드 id를 쓴 것으로 센다(임시 파일은 이미 지웠다) — 다시 올리면 새 id를 받는다.
    process.env.PORTFOLIO_MAX_UPLOAD_MB = "1";
    const UID2 = "0123456789abcdef01234568.pdf";
    await stage("ua", UID2, new Uint8Array(1024 * 1024 + 1));
    expect((await listRoute.POST(json(BASE, "POST", { uploadId: UID2, fileName: "a.pdf" }))).status).toBe(413);
    expect(await storage.listByPrefix(storage.uploadStagingPrefix("ua"))).toEqual([]);

    expect((await listRoute.POST(json(BASE, "POST", { uploadId: "../../users/ub/x.pdf", fileName: "a.pdf" }))).status).toBe(400);
    expect((await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "a.png" }))).status).toBe(400);
  });

  it("내용 바꾸기·이력서에 바로 붙이기도 같은 마무리를 쓴다, 남의 포트폴리오는 404", async () => {
    const UID2 = "0123456789abcdef01234568.pdf";
    const UID3 = "0123456789abcdef01234569.pdf";
    const p = await legacy("a.png", new Uint8Array(png), "png", "image/png");
    await stage("ua", UID, pdf);
    const res = await itemRoute.PUT(json(`${BASE}/${p.id}`, "PUT", { uploadId: UID, fileName: "b.pdf" }), ctx(p.id));
    expect(res.status).toBe(200);
    expect((await row(p.id)).originalMime).toBe("application/pdf");

    const rid = (await resumes.createResume("ua", { templateId: "classic", document: emptyResumeDocument(), source: "manual", company: "a", roleTitle: "b" })).resume.id;
    await stage("ua", UID2, pdf);
    const attached = await resumePortfolioRoute.PUT(json(`http://localhost/api/resumes/${rid}/portfolio`, "PUT", { uploadId: UID2, fileName: "c.pdf" }), ctx(rid));
    expect(attached.status).toBe(200);
    const body = (await attached.json()) as { resume: { portfolio: PortfolioInfo } };
    expect(body.resume.portfolio.original?.view).toBe("pdf");

    state.user = { id: "ub" };
    await stage("ub", UID3, pdf);
    expect((await itemRoute.PUT(json(`${BASE}/${p.id}`, "PUT", { uploadId: UID3, fileName: "b.pdf" }), ctx(p.id))).status).toBe(404);
  });

  it("같은 업로드 id는 한 번만 마무리한다(서명 주소로 다시 올려도 409) — 원본은 확인한 바이트 그대로", async () => {
    await stage("ua", UID, pdf);
    const { portfolio: p } = await created(await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "a.pdf" })));
    // 서명 주소가 살아 있는 동안 같은 키에 다시 올리고 다시 마무리해도 받지 않는다(레이트 리밋 1회로 여러 번 만들지 못한다).
    await stage("ua", UID, "not a pdf");
    const again = await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "a.pdf" }));
    expect(again.status).toBe(409);
    expect(await tdb.prisma.portfolio.count({ where: { userId: "ua" } })).toBe(1);
    expect(Buffer.from(await (await getOriginal(p.id)).arrayBuffer()).equals(Buffer.from(pdf))).toBe(true);
    // 다른 사용자의 같은 업로드 id는 따로 센다.
    state.user = { id: "ub" };
    await stage("ub", UID, pdf);
    expect((await listRoute.POST(json(BASE, "POST", { uploadId: UID, fileName: "a.pdf" }))).status).toBe(201);
  });
});

describe("큰 원본 내려주기(R2)", () => {
  const R2_ENV = { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "AKIA_TEST", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" };
  const withR2 = async <T,>(fn: () => Promise<T>): Promise<T> => {
    Object.assign(process.env, R2_ENV);
    try {
      return await fn();
    } finally {
      for (const k of Object.keys(R2_ENV)) delete process.env[k];
    }
  };
  const bigRow = (id: string, userId: string, mime: string, fileName: string) =>
    tdb.prisma.portfolio.create({
      data: {
        id,
        userId,
        title: "큰 원본",
        kind: "file",
        fileName,
        originalKey: `users/${userId}/portfolios/${id}/original-x.${fileName.split(".").pop()}`,
        originalMime: mime,
        originalSize: 20 * 1024 * 1024,
      },
    });

  it("4MB를 넘는 원본은 본문을 싣지 않고 소유자 확인 뒤 짧은 서명 GET 주소로 302(Vercel 응답 4.5MB 상한)", async () => {
    await bigRow("big1", "ua", "application/pdf", "포트폴리오.pdf");
    const res = await withR2(() => getOriginal("big1"));
    expect(res.status).toBe(302);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    const loc = new URL(res.headers.get("location")!);
    expect(loc.hostname).toBe("bucket.acc.r2.cloudflarestorage.com");
    expect(loc.pathname).toBe("/users/ua/portfolios/big1/original-x.pdf");
    expect(Number(loc.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(60);
    expect(loc.searchParams.get("response-content-type")).toBe("application/pdf");
    expect(loc.searchParams.get("response-content-disposition")).toMatch(/^inline; .*filename\*=UTF-8''/);
    expect(loc.searchParams.get("response-cache-control")).toBe("private, no-store");

    const dl = new URL((await withR2(() => getOriginal("big1", "?download=1"))).headers.get("location")!);
    expect(dl.searchParams.get("response-content-disposition")).toMatch(/^attachment;/);
  });

  it("큰 HTML은 서명 주소에서도 octet-stream 첨부, 큰 TXT도 첨부(다른 출처에서도 inline으로 열지 않는다)", async () => {
    await bigRow("big2", "ua", "text/html", "a.html");
    await bigRow("big3", "ua", "text/plain", "a.txt");
    const html = new URL((await withR2(() => getOriginal("big2"))).headers.get("location")!);
    expect(html.searchParams.get("response-content-type")).toBe("application/octet-stream");
    expect(html.searchParams.get("response-content-disposition")).toMatch(/^attachment;/);
    const txt = new URL((await withR2(() => getOriginal("big3"))).headers.get("location")!);
    expect(txt.searchParams.get("response-content-disposition")).toMatch(/^attachment;/);
  });

  it("남의 큰 원본은 서명 주소를 만들지 않고 404", async () => {
    await bigRow("big4", "ub", "application/pdf", "b.pdf");
    const res = await withR2(() => getOriginal("big4"));
    expect(res.status).toBe(404);
    expect(res.headers.get("location")).toBeNull();
  });
});

describe("서명 주소(R2)", () => {
  it("세션 사용자의 임시 키에 크기·내용 유형을 서명한 PUT 주소를 만든다", async () => {
    const saved = { ...process.env };
    Object.assign(process.env, { R2_ACCOUNT_ID: "acc", R2_ACCESS_KEY_ID: "AKIA_TEST", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" });
    try {
      const url = await storage.presignPutObject(storage.uploadStagingKey("ua", "portfolio-abc.pdf"), {
        contentType: "application/octet-stream",
        contentLength: 1234,
      });
      const u = new URL(url!);
      expect(u.hostname).toBe("bucket.acc.r2.cloudflarestorage.com");
      expect(u.pathname).toBe("/uploads/ua/portfolio-abc.pdf");
      expect(u.searchParams.get("X-Amz-SignedHeaders")?.split(";")).toEqual(expect.arrayContaining(["content-length", "content-type", "host"]));
      expect(Number(u.searchParams.get("X-Amz-Expires"))).toBeLessThanOrEqual(600);
      // 빈 본문의 체크섬을 주소에 넣지 않는다(넣으면 실제 파일이 체크섬 불일치로 거절된다).
      expect([...u.searchParams.keys()].some((k) => k.toLowerCase().startsWith("x-amz-checksum"))).toBe(false);
    } finally {
      for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) {
        if (saved[k] === undefined) delete process.env[k];
        else process.env[k] = saved[k];
      }
    }
  });
});
