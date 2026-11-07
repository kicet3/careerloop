/**
 * 화면 PDF 보기(?viewer=1) Range 응답(PGlite + 로컬 저장소, 세션은 가짜):
 * 소유자·공개 링크 원본 라우트가 206 조각(Content-Range·Accept-Ranges·보안 헤더)·416·400을 내려주고, 공개를 끄면 조각 요청도 404,
 * ?viewer=1이 없으면 예전 그대로(200 전체, Range 무시). pdf.js 자산 라우트(판·목록 밖은 404).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { PortfolioShareStatus } from "@/lib/domain/portfolio-shares";
import type { PortfolioInfo } from "@/lib/domain/portfolios";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-portfolio-viewer-")), "storage");

const state = vi.hoisted(() => ({ user: { id: "ua" } as { id: string } | null }));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));

let tdb: TestDb;
let listRoute: typeof import("@/app/api/portfolios/route");
let originalRoute: typeof import("@/app/api/portfolios/[id]/original/route");
let shareRoute: typeof import("@/app/api/portfolios/[id]/share/route");
let publicOriginal: typeof import("@/app/api/p/[token]/original/route");
let assetRoute: typeof import("@/app/pdfjs/[version]/[dir]/[file]/route");
let assets: typeof import("@/lib/portfolios/pdfjs-assets");
let serve: typeof import("@/lib/portfolios/original-serve");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL", "PORTFOLIO_MAX_UPLOAD_MB", "TRUSTED_PROXY_HOPS"]) {
    delete process.env[k];
  }
  tdb = await createTestDb();
  listRoute = await import("@/app/api/portfolios/route");
  originalRoute = await import("@/app/api/portfolios/[id]/original/route");
  shareRoute = await import("@/app/api/portfolios/[id]/share/route");
  publicOriginal = await import("@/app/api/p/[token]/original/route");
  assetRoute = await import("@/app/pdfjs/[version]/[dir]/[file]/route");
  assets = await import("@/lib/portfolios/pdfjs-assets");
  serve = await import("@/lib/portfolios/original-serve");
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  await tdb.prisma.user.create({ data: { id: "ua", email: "a@x.com", name: "김에이", status: "approved" } });
  await tdb.prisma.user.create({ data: { id: "ub", email: "b@x.com", status: "approved" } });
  state.user = { id: "ua" };
});

/** 쪽 하나(글 한 줄) + 덧붙인 바이트(padBytes)로 크기를 맞춘 올바른 PDF. */
function makePdf(padBytes = 0): Buffer {
  const content = "BT /F1 18 Tf 72 720 Td (Settlement batch rebuilt in Kotlin) Tj ET";
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Contents 4 0 R /Resources << /Font << /F1 6 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    `<< /Length ${padBytes} >>\nstream\n${"0".repeat(padBytes)}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objs.forEach((o, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const BASE = "http://localhost/api/portfolios";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const tctx = (token: string) => ({ params: Promise.resolve({ token }) });
let ipSeq = 0;
const nextIp = () => `10.9.${Math.floor(++ipSeq / 250)}.${ipSeq % 250}`;

async function pdfPortfolio(bytes: Buffer): Promise<PortfolioInfo> {
  const fd = new FormData();
  fd.set("file", new File([new Uint8Array(bytes)], "portfolio.pdf"));
  const res = await listRoute.POST(new Request(BASE, { method: "POST", body: fd }));
  expect(res.status).toBe(201);
  return ((await res.json()) as { portfolio: PortfolioInfo }).portfolio;
}

async function publish(id: string): Promise<PortfolioShareStatus> {
  const res = await shareRoute.POST(
    new Request(`${BASE}/${id}/share`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-forwarded-for": nextIp() },
      body: JSON.stringify({ includeOriginal: true }),
    }),
    ctx(id),
  );
  expect(res.status).toBe(200);
  return ((await res.json()) as { share: PortfolioShareStatus }).share;
}

const owner = (id: string, q: string, range?: string) =>
  originalRoute.GET(new Request(`${BASE}/${id}/original${q}`, { headers: range ? { range } : {} }), ctx(id));
const pub = (token: string, q: string, range?: string) =>
  publicOriginal.GET(
    new Request(`http://localhost/api/p/${token}/original${q}`, { headers: { "x-forwarded-for": nextIp(), ...(range ? { range } : {}) } }),
    tctx(token),
  );

function expectSecurityHeaders(res: Response) {
  expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  expect(res.headers.get("cache-control")).toBe("private, no-store");
  expect(res.headers.get("content-security-policy")).toBe("frame-ancestors 'self'");
  expect(res.headers.get("cross-origin-resource-policy")).toBe("same-origin");
  expect(res.headers.get("referrer-policy")).toBe("no-referrer");
}

describe("소유자 원본 라우트 ?viewer=1", () => {
  it("206 조각: Content-Range·Content-Length·Accept-Ranges·보안 헤더, 내용은 그 구간 바이트", async () => {
    const pdf = makePdf(5000);
    const p = await pdfPortfolio(pdf);
    const res = await owner(p.id, "?viewer=1&v=1", "bytes=0-99");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-99/${pdf.length}`);
    expect(res.headers.get("content-length")).toBe("100");
    expect(res.headers.get("accept-ranges")).toBe("bytes");
    expect(res.headers.get("content-type")).toBe("application/pdf");
    expect(res.headers.get("content-disposition")).toMatch(/^inline;/);
    expectSecurityHeaders(res);
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf.subarray(0, 100))).toBe(true);

    const tail = await owner(p.id, "?viewer=1", "bytes=-50");
    expect(tail.status).toBe(206);
    expect(tail.headers.get("content-range")).toBe(`bytes ${pdf.length - 50}-${pdf.length - 1}/${pdf.length}`);
    expect(Buffer.from(await tail.arrayBuffer()).equals(pdf.subarray(pdf.length - 50))).toBe(true);

    const over = await owner(p.id, "?viewer=1", `bytes=100-${pdf.length + 1000}`);
    expect(over.status).toBe(206);
    expect(over.headers.get("content-range")).toBe(`bytes 100-${pdf.length - 1}/${pdf.length}`);
  });

  it("파일 밖 구간은 416(Content-Range: bytes */크기), 문법이 틀린 Range는 무시하고 작은 파일은 200 전체", async () => {
    const pdf = makePdf(100);
    const p = await pdfPortfolio(pdf);
    const bad = await owner(p.id, "?viewer=1", `bytes=${pdf.length}-`);
    expect(bad.status).toBe(416);
    expect(bad.headers.get("content-range")).toBe(`bytes */${pdf.length}`);
    expect(bad.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await owner(p.id, "?viewer=1", "bytes=-0")).status).toBe(416);

    for (const range of [undefined, "bytes=5-1", "bytes=0-1,4-9", "items=0-1"]) {
      const full = await owner(p.id, "?viewer=1", range);
      expect(full.status).toBe(200);
      expect(full.headers.get("accept-ranges")).toBe("bytes");
      expectSecurityHeaders(full);
      expect(Buffer.from(await full.arrayBuffer()).equals(pdf)).toBe(true);
    }
  });

  it("큰 PDF(> 4MB): 조각은 4MB로 잘리고, Range 없는 viewer 요청은 400", async () => {
    const pdf = makePdf(4 * 1024 * 1024 + 2000);
    const p = await pdfPortfolio(pdf);
    const res = await owner(p.id, "?viewer=1", "bytes=0-");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 0-${serve.ORIGINAL_VIEWER_RANGE_MAX_BYTES - 1}/${pdf.length}`);
    expect((await res.arrayBuffer()).byteLength).toBe(serve.ORIGINAL_VIEWER_RANGE_MAX_BYTES);
    expect((await owner(p.id, "?viewer=1")).status).toBe(400);
  });

  it("viewer가 없으면 예전 그대로: Range를 무시하고 200 전체", async () => {
    const pdf = makePdf(100);
    const p = await pdfPortfolio(pdf);
    const res = await owner(p.id, "", "bytes=0-9");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-range")).toBeNull();
    expect((await res.arrayBuffer()).byteLength).toBe(pdf.length);
  });

  it("남의 포트폴리오 조각은 404, 로그인이 없으면 401", async () => {
    const p = await pdfPortfolio(makePdf(100));
    state.user = { id: "ub" };
    expect((await owner(p.id, "?viewer=1", "bytes=0-9")).status).toBe(404);
    state.user = null;
    expect((await owner(p.id, "?viewer=1", "bytes=0-9")).status).toBe(401);
  });
});

describe("공개 원본 라우트 ?viewer=1", () => {
  it("206 조각 + noindex, 공개를 끄면 다음 조각 요청부터 404", async () => {
    const pdf = makePdf(3000);
    const p = await pdfPortfolio(pdf);
    const share = await publish(p.id);
    const res = await pub(share.token, "?viewer=1", "bytes=10-19");
    expect(res.status).toBe(206);
    expect(res.headers.get("content-range")).toBe(`bytes 10-19/${pdf.length}`);
    expect(res.headers.get("x-robots-tag")).toContain("noindex");
    expect(res.headers.get("content-disposition")).toBe(`inline; filename="portfolio.pdf"; filename*=UTF-8''portfolio.pdf`);
    expectSecurityHeaders(res);
    expect(Buffer.from(await res.arrayBuffer()).equals(pdf.subarray(10, 20))).toBe(true);
    expect((await pub(share.token, "?viewer=1", `bytes=${pdf.length + 5}-`)).status).toBe(416);

    const del = await shareRoute.DELETE(
      new Request(`${BASE}/${p.id}/share`, { method: "DELETE", headers: { "x-forwarded-for": nextIp() } }),
      ctx(p.id),
    );
    expect(del.status).toBe(204);
    const after = await pub(share.token, "?viewer=1", "bytes=20-29");
    expect(after.status).toBe(404);
    expect(after.headers.get("content-range")).toBeNull();
    expect((await pub("z".repeat(43), "?viewer=1", "bytes=0-9")).status).toBe(404);
  });

  it("조각 요청은 페이지 리미터(1분 30회)와 따로 센다", async () => {
    const p = await pdfPortfolio(makePdf(100));
    const share = await publish(p.id);
    const ip = "10.250.0.1";
    const req = (q: string) =>
      publicOriginal.GET(new Request(`http://localhost/api/p/${share.token}/original${q}`, { headers: { "x-forwarded-for": ip, range: "bytes=0-9" } }), tctx(share.token));
    for (let i = 0; i < 40; i++) expect((await req("?viewer=1")).status).toBe(206);
    expect((await req("")).status).toBe(200);
  });
});

describe("pdf.js 자산 라우트", () => {
  const asset = (version: string, dir: string, file: string) =>
    assetRoute.GET(new Request(`http://localhost/pdfjs/${version}/${dir}/${file}`), { params: Promise.resolve({ version, dir, file }) });

  it("워커·CMap·wasm을 오래 캐시해 내려준다", async () => {
    const v = assets.PDFJS_VERSION;
    const worker = await asset(v, "build", "pdf.worker.min.mjs");
    expect(worker.status).toBe(200);
    expect(worker.headers.get("content-type")).toContain("text/javascript");
    expect(worker.headers.get("cache-control")).toContain("immutable");
    expect(worker.headers.get("x-content-type-options")).toBe("nosniff");
    expect((await asset(v, "cmaps", "UniKS-UCS2-H.bcmap")).status).toBe(200);
    const wasm = await asset(v, "wasm", "openjpeg.wasm");
    expect(wasm.headers.get("content-type")).toBe("application/wasm");
    expect(assets.PDFJS_WORKER_URL).toBe(`/pdfjs/${v}/build/pdf.worker.min.mjs`);
  });

  it("판이 다르거나 목록 밖·경로 탈출은 404", async () => {
    const v = assets.PDFJS_VERSION;
    expect((await asset("0.0.1", "build", "pdf.worker.min.mjs")).status).toBe(404);
    expect((await asset(v, "build", "pdf.mjs")).status).toBe(404);
    expect((await asset(v, "cmaps", "..%2F..%2Fpackage.json")).status).toBe(404);
    expect((await asset(v, "cmaps", "../package.json")).status).toBe(404);
    expect((await asset(v, "legacy", "pdf.worker.min.mjs")).status).toBe(404);
    expect((await asset(v, "cmaps", "Missing.bcmap")).status).toBe(404);
    expect((await asset(v, "__proto__", "x.bcmap")).status).toBe(404);
  });
});
