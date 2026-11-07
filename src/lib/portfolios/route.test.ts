/** /api/portfolios·/api/portfolios/[id] (PGlite, 세션은 가짜): 만들기(파일·링크)·목록·상세·고치기·내용 바꾸기·지우기, 남의 것 404, 상한 409, 레이트 리밋 429. */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type PortfolioInfo, type PortfolioListItem } from "@/lib/domain/portfolios";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";
import { makeTestPdf } from "@/test/pdf";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-portfolios-api-")), "storage");

const state = vi.hoisted(() => ({ user: { id: "ua" } as { id: string } | null }));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));

let tdb: TestDb;
let listRoute: typeof import("@/app/api/portfolios/route");
let itemRoute: typeof import("@/app/api/portfolios/[id]/route");
let resumes: typeof import("@/lib/resumes/service");
let attach: typeof import("@/lib/resumes/portfolio");
let limits: typeof import("@/lib/auth/db-rate-limit");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL"]) delete process.env[k];
  tdb = await createTestDb();
  listRoute = await import("@/app/api/portfolios/route");
  itemRoute = await import("@/app/api/portfolios/[id]/route");
  resumes = await import("@/lib/resumes/service");
  attach = await import("@/lib/resumes/portfolio");
  limits = await import("@/lib/auth/db-rate-limit");
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  state.user = { id: "ua" };
});

const BASE = "http://localhost/api/portfolios";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const TEXT = "결제 정산 배치를 Kotlin으로 다시 만들었습니다. 처리 시간을 4시간에서 40분으로 줄였습니다.\n".repeat(3);

/** .pdf 이름에 글을 주면 그 글이 든 PDF로 만든다(그 밖은 받은 바이트 그대로 — 거절 확인용). */
function uploadReq(u: string, method: "POST" | "PUT", name: string, content: string | Uint8Array, extra: Record<string, string> = {}) {
  const fd = new FormData();
  const body = typeof content === "string" && name.endsWith(".pdf") ? makeTestPdf(content) : content;
  fd.set("file", new File([body as BlobPart], name, { type: name.endsWith(".pdf") ? "application/pdf" : "text/plain" }));
  for (const [k, v] of Object.entries(extra)) fd.set(k, v);
  return new Request(u, { method, body: fd });
}
const json = (u: string, method: string, body: unknown) =>
  new Request(u, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

async function create(body: Request): Promise<PortfolioInfo> {
  const res = await listRoute.POST(body);
  expect(res.status).toBe(201);
  return ((await res.json()) as { portfolio: PortfolioInfo }).portfolio;
}

describe("/api/portfolios", () => {
  it("파일·링크로 만들고 목록에 붙인 이력서와 함께 보인다", async () => {
    const file = await create(uploadReq(BASE, "POST", "정산.pdf", TEXT, { title: "정산 개편", description: "배치 담당" }));
    expect(file).toMatchObject({ title: "정산 개편", kind: "file", fileName: "정산.pdf", description: "배치 담당" });
    const link = await create(json(BASE, "POST", { url: "https://me.dev", description: "개인 사이트" }));
    expect(link).toMatchObject({ title: "me.dev", kind: "url", url: "https://me.dev" });

    const rid = (await resumes.createResume("ua", { templateId: "classic", document: emptyResumeDocument(), source: "manual", company: "토스", roleTitle: "백엔드" })).resume.id;
    await attach.attachPortfolio("ua", rid, file.id);
    const list = (await (await listRoute.GET()).json()) as { items: PortfolioListItem[] };
    expect(list.items.map((p) => p.id).sort()).toEqual([file.id, link.id].sort());
    expect(list.items.find((p) => p.id === file.id)!.resumes.map((r) => r.id)).toEqual([rid]);
  });

  it("입력 검증: 잘못된 주소·긴 이름 400, 지원하지 않는 형식 415, 빈 폼 400", async () => {
    expect((await listRoute.POST(json(BASE, "POST", { url: "ftp://x" }))).status).toBe(400);
    expect((await listRoute.POST(json(BASE, "POST", { url: "https://x.dev", title: "가".repeat(121) }))).status).toBe(400);
    expect((await listRoute.POST(uploadReq(BASE, "POST", "a.pdf", TEXT, { title: "가".repeat(121) }))).status).toBe(400);
    expect((await listRoute.POST(uploadReq(BASE, "POST", "a.exe", TEXT))).status).toBe(415);
    expect((await listRoute.POST(new Request(BASE, { method: "POST", body: new FormData() }))).status).toBe(400);
  });

  it("새 업로드는 PDF만: DOCX·PNG·HWP·MD는 415(PDF만 안내), 확장자만 .pdf로 바꾼 PNG는 매직 바이트로 415, 진짜 PDF는 201", async () => {
    const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
    const DOCX = new Uint8Array([0x50, 0x4b, 0x03, 0x04, 0, 0, 0, 0]);
    const HWP = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    for (const [name, bytes] of [
      ["a.docx", DOCX],
      ["a.png", PNG],
      ["a.hwp", HWP],
      ["a.md", new TextEncoder().encode(TEXT)],
    ] as const) {
      const res = await listRoute.POST(uploadReq(BASE, "POST", name, bytes));
      expect(res.status, name).toBe(415);
      expect(((await res.json()) as { error: string }).error).toContain("포트폴리오 파일은 PDF만 올릴 수 있습니다");
    }
    const renamed = await listRoute.POST(uploadReq(BASE, "POST", "renamed.pdf", PNG));
    expect(renamed.status).toBe(415);
    expect(((await renamed.json()) as { error: string }).error).toContain("PDF 형식이 아닙니다");
    expect(await tdb.prisma.portfolio.count({ where: { userId: "ua" } })).toBe(0);
    expect(await create(uploadReq(BASE, "POST", "진짜.pdf", TEXT))).toMatchObject({ kind: "file", fileName: "진짜.pdf", original: { mime: "application/pdf" } });
  });

  it("내용 바꾸기도 PDF만(415), 기존 내용은 그대로", async () => {
    const p = await create(uploadReq(BASE, "POST", "a.pdf", TEXT));
    const u = `${BASE}/${p.id}`;
    expect((await itemRoute.PUT(uploadReq(u, "PUT", "b.docx", new Uint8Array([0x50, 0x4b, 0x03, 0x04])), ctx(p.id))).status).toBe(415);
    expect((await itemRoute.PUT(uploadReq(u, "PUT", "b.pdf", new TextEncoder().encode("<html>")), ctx(p.id))).status).toBe(415);
    const got = (await (await itemRoute.GET(new Request(u), ctx(p.id))).json()) as { portfolio: PortfolioInfo };
    expect(got.portfolio).toMatchObject({ fileName: "a.pdf" });
  });

  it("개수 제한 없음(많이 있어도 201), 파일 업로드는 레이트 리밋 429", async () => {
    await tdb.prisma.portfolio.createMany({
      data: Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, userId: "ua", title: `p${i}`, kind: "url", url: "https://a.dev" })),
    });
    expect((await listRoute.POST(json(BASE, "POST", { url: "https://x.dev" }))).status).toBe(201);
    expect((await listRoute.POST(uploadReq(BASE, "POST", "a.pdf", TEXT))).status).toBe(201);
    state.user = { id: "ub" };
    for (let i = 0; i < limits.PORTFOLIO_UPLOAD_LIMIT.limit; i++) await limits.hitDbLimit(limits.PORTFOLIO_UPLOAD_LIMIT, "ub");
    const res = await listRoute.POST(uploadReq(BASE, "POST", "a.pdf", TEXT));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
  });

  it("401: 로그인 안 함", async () => {
    state.user = null;
    expect((await listRoute.GET()).status).toBe(401);
    expect((await listRoute.POST(json(BASE, "POST", { url: "https://x.dev" }))).status).toBe(401);
  });
});

describe("/api/portfolios/[id]", () => {
  it("상세(미리보기·include=text) → 이름·설명 고치기 → 내용 바꾸기(파일 → 링크) → 지우기(이력서에서 떨어짐)", async () => {
    const p = await create(uploadReq(BASE, "POST", "a.pdf", TEXT));
    const u = `${BASE}/${p.id}`;
    const got = (await (await itemRoute.GET(new Request(u), ctx(p.id))).json()) as { portfolio: PortfolioListItem; chars: number; preview: string; text?: string };
    expect(got.portfolio.id).toBe(p.id);
    expect(got.chars).toBeGreaterThan(50);
    expect(got.preview).toContain("결제 정산");
    expect(got.text).toBeUndefined();
    expect(((await (await itemRoute.GET(new Request(`${u}?include=text`), ctx(p.id))).json()) as { text: string }).text).toContain("40분");

    const patched = await itemRoute.PATCH(json(u, "PATCH", { title: "새 이름", description: "역할 메모" }), ctx(p.id));
    expect(((await patched.json()) as { portfolio: PortfolioInfo }).portfolio).toMatchObject({ title: "새 이름", description: "역할 메모" });
    expect((await itemRoute.PATCH(json(u, "PATCH", { title: "" }), ctx(p.id))).status).toBe(400);
    expect((await itemRoute.PATCH(json(u, "PATCH", {}), ctx(p.id))).status).toBe(400);

    const replaced = await itemRoute.PUT(uploadReq(u, "PUT", "b.pdf", `두 번째 ${TEXT}`), ctx(p.id));
    expect(((await replaced.json()) as { portfolio: PortfolioInfo }).portfolio).toMatchObject({ fileName: "b.pdf", title: "새 이름" });
    const toUrl = await itemRoute.PUT(json(u, "PUT", { url: "https://me.dev" }), ctx(p.id));
    expect(((await toUrl.json()) as { portfolio: PortfolioInfo }).portfolio).toMatchObject({ kind: "url", url: "https://me.dev", description: "역할 메모" });

    const rid = (await resumes.createResume("ua", { templateId: "classic", document: emptyResumeDocument(), source: "manual", company: "a", roleTitle: "b" })).resume.id;
    await attach.attachPortfolio("ua", rid, p.id);
    const del = await itemRoute.DELETE(new Request(u, { method: "DELETE" }), ctx(p.id));
    expect(await del.json()).toEqual({ ok: true, detached: 1 });
    expect((await resumes.getResumeMeta("ua", rid))!.portfolio).toBeNull();
    expect((await itemRoute.GET(new Request(u), ctx(p.id))).status).toBe(404);
  });

  it("남의 포트폴리오는 모두 404", async () => {
    const p = await create(json(BASE, "POST", { url: "https://me.dev" }));
    const u = `${BASE}/${p.id}`;
    state.user = { id: "ub" };
    expect((await itemRoute.GET(new Request(u), ctx(p.id))).status).toBe(404);
    expect((await itemRoute.PATCH(json(u, "PATCH", { title: "x" }), ctx(p.id))).status).toBe(404);
    expect((await itemRoute.PUT(json(u, "PUT", { url: "https://x.dev" }), ctx(p.id))).status).toBe(404);
    expect((await itemRoute.PUT(uploadReq(u, "PUT", "a.pdf", TEXT), ctx(p.id))).status).toBe(404);
    expect((await itemRoute.DELETE(new Request(u, { method: "DELETE" }), ctx(p.id))).status).toBe(404);
    state.user = { id: "ua" };
    expect((await itemRoute.GET(new Request(u), ctx(p.id))).status).toBe(200);
  });
});
