/**
 * 이력서 포트폴리오·지원 상태·목록 필터 API(PGlite, 세션은 가짜): 보관함에 올리고 붙이기(파일·링크)·보관함 항목 붙이기·떼기·미리보기,
 * 남의 이력서·포트폴리오 404, 업로드 레이트 리밋 429, 상태 PATCH(공용 400), GET /api/resumes?status=.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";
import { makeTestPdf } from "@/test/pdf";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-portfolio-api-")), "storage");

const state = vi.hoisted(() => ({ user: { id: "ua", email: "ua@x.com", name: "가", role: "user" } as { id: string } | null }));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));

let tdb: TestDb;
let portfolioRoute: typeof import("@/app/api/resumes/[id]/portfolio/route");
let statusRoute: typeof import("@/app/api/resumes/[id]/status/route");
let listRoute: typeof import("@/app/api/resumes/route");
let service: typeof import("./service");
let limits: typeof import("@/lib/auth/db-rate-limit");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL"]) delete process.env[k];
  tdb = await createTestDb();
  portfolioRoute = await import("@/app/api/resumes/[id]/portfolio/route");
  statusRoute = await import("@/app/api/resumes/[id]/status/route");
  listRoute = await import("@/app/api/resumes/route");
  service = await import("./service");
  limits = await import("@/lib/auth/db-rate-limit");
});
afterAll(() => tdb.close());

let companyId: string;
let generalId: string;
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  state.user = { id: "ua" };
  const base = { templateId: "classic" as const, document: emptyResumeDocument(), source: "manual" as const };
  companyId = (await service.createResume("ua", { ...base, company: "토스", roleTitle: "백엔드" })).resume.id;
  generalId = (await service.createResume("ua", { ...base, kind: "general", company: "", roleTitle: "" })).resume.id;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const url = (id: string, q = "") => `http://localhost/api/resumes/${id}/portfolio${q}`;
/** .pdf 이름이면 그 글이 든 PDF로 만든다(그 밖은 글 그대로 — 거절 확인용). */
function upload(id: string, name: string, content: string) {
  const fd = new FormData();
  const body = name.endsWith(".pdf") ? makeTestPdf(content) : content;
  fd.set("file", new File([body as BlobPart], name, { type: name.endsWith(".pdf") ? "application/pdf" : "text/plain" }));
  return new Request(url(id), { method: "PUT", body: fd });
}
const putJson = (id: string, body: unknown) =>
  new Request(url(id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const PORTFOLIO = "결제 정산 배치를 Kotlin으로 다시 만들었습니다. 처리 시간을 4시간에서 40분으로 줄였고, 실패 재처리 기준을 정했습니다.\n".repeat(3);

describe("PUT·GET·DELETE /api/resumes/[id]/portfolio", () => {
  it("파일을 올리면 보관함에 추가하고 붙인다 — 미리보기·본문(include=text)을 돌려준다", async () => {
    const fd = new FormData();
    fd.set("file", new File([makeTestPdf(PORTFOLIO)], "포트폴리오.pdf", { type: "application/pdf" }));
    fd.set("title", "정산 개편");
    fd.set("description", "배치 재작성 담당");
    const res = await portfolioRoute.PUT(new Request(url(companyId), { method: "PUT", body: fd }), ctx(companyId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      resume: { portfolio: { id: string; kind: string; fileName: string; title: string; description: string } };
      portfolio: { id: string };
      truncated: boolean;
    };
    expect(body.resume.portfolio).toMatchObject({ kind: "file", fileName: "포트폴리오.pdf", title: "정산 개편", description: "배치 재작성 담당" });
    expect(body.portfolio.id).toBe(body.resume.portfolio.id);
    expect(body.truncated).toBe(false);
    expect(await tdb.prisma.portfolio.count({ where: { userId: "ua" } })).toBe(1);

    const got = (await (await portfolioRoute.GET(new Request(url(companyId)), ctx(companyId))).json()) as Record<string, unknown>;
    expect(got.chars).toBeGreaterThan(50);
    expect(String(got.preview)).toContain("결제 정산");
    expect(got.text).toBeUndefined();
    const full = (await (await portfolioRoute.GET(new Request(url(companyId, "?include=text")), ctx(companyId))).json()) as { text: string; info: { description: string } };
    expect(full.text).toContain("40분");
    expect(full.info.description).toBe("배치 재작성 담당");
  });

  it("링크로 새로 만들어 붙이고(http/https만), 보관함 항목을 다른 이력서에 붙이고, 떼도 보관함에는 남는다", async () => {
    expect((await portfolioRoute.PUT(putJson(companyId, { url: "javascript:alert(1)" }), ctx(companyId))).status).toBe(400);
    const res = await portfolioRoute.PUT(putJson(companyId, { url: "https://me.dev/work" }), ctx(companyId));
    expect(res.status).toBe(200);
    const made = (await res.json()) as { resume: { portfolio: { id: string } }; portfolio: { id: string } };
    expect(made.resume.portfolio).toMatchObject({ kind: "url", url: "https://me.dev/work", title: "me.dev" });

    const again = await portfolioRoute.PUT(putJson(generalId, { portfolioId: made.portfolio.id }), ctx(generalId));
    expect(again.status).toBe(200);
    expect(((await again.json()) as { resume: { portfolio: { id: string } } }).resume.portfolio.id).toBe(made.portfolio.id);

    const del = await portfolioRoute.DELETE(new Request(url(companyId), { method: "DELETE" }), ctx(companyId));
    expect(((await del.json()) as { resume: { portfolio: unknown } }).resume.portfolio).toBeNull();
    const got = (await (await portfolioRoute.GET(new Request(url(companyId)), ctx(companyId))).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ info: null, chars: 0, preview: "" });
    expect(await tdb.prisma.portfolio.count({ where: { userId: "ua" } })).toBe(1);
  });

  it("남의 이력서 404, 남의 포트폴리오 404, 지원하지 않는 형식 415, 빈 폼 400, 잘못된 JSON 400", async () => {
    const theirs = await tdb.prisma.portfolio.create({ data: { id: "theirs", userId: "ub", title: "남의 것", kind: "url", url: "https://b.dev" } });
    expect((await portfolioRoute.PUT(putJson(companyId, { portfolioId: theirs.id }), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.PUT(putJson(companyId, { portfolioId: "nope" }), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.PUT(putJson(companyId, { portfolioId: "x", url: "https://a.dev" }), ctx(companyId))).status).toBe(400);
    state.user = { id: "ub" };
    expect((await portfolioRoute.PUT(upload(companyId, "p.pdf", PORTFOLIO), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.PUT(putJson(companyId, { portfolioId: theirs.id }), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.GET(new Request(url(companyId)), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.DELETE(new Request(url(companyId), { method: "DELETE" }), ctx(companyId))).status).toBe(404);
    state.user = { id: "ua" };
    expect((await portfolioRoute.PUT(upload(companyId, "p.exe", PORTFOLIO), ctx(companyId))).status).toBe(415);
    // 이력서에서 바로 올리기도 PDF만(확장자 + 내용).
    expect((await portfolioRoute.PUT(upload(companyId, "p.md", PORTFOLIO), ctx(companyId))).status).toBe(415);
    expect((await portfolioRoute.PUT(upload(companyId, "p.docx", PORTFOLIO), ctx(companyId))).status).toBe(415);
    const fake = new FormData();
    fake.set("file", new File([PORTFOLIO], "가짜.pdf", { type: "application/pdf" }));
    const fakeRes = await portfolioRoute.PUT(new Request(url(companyId), { method: "PUT", body: fake }), ctx(companyId));
    expect(fakeRes.status).toBe(415);
    expect(((await fakeRes.json()) as { error: string }).error).toContain("PDF 형식이 아닙니다");
    expect(await tdb.prisma.portfolio.count({ where: { userId: "ua" } })).toBe(0);
    expect((await portfolioRoute.PUT(new Request(url(companyId), { method: "PUT", body: new FormData() }), ctx(companyId))).status).toBe(400);
  });

  it("파일 업로드는 사용자당 레이트 리밋(429 + Retry-After)", async () => {
    for (let i = 0; i < limits.PORTFOLIO_UPLOAD_LIMIT.limit; i++) await limits.hitDbLimit(limits.PORTFOLIO_UPLOAD_LIMIT, "ua");
    const res = await portfolioRoute.PUT(upload(companyId, "p.pdf", PORTFOLIO), ctx(companyId));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // 링크 첨부는 막지 않는다.
    expect((await portfolioRoute.PUT(putJson(companyId, { url: "https://me.dev" }), ctx(companyId))).status).toBe(200);
  });

  it("포트폴리오가 많아도 새로 만들어 붙일 수 있고, 있는 항목 붙이기도 된다(개수 제한 없음)", async () => {
    await tdb.prisma.portfolio.createMany({
      data: Array.from({ length: 45 }, (_, i) => ({ id: `p${i}`, userId: "ua", title: `p${i}`, kind: "url", url: "https://a.dev" })),
    });
    expect((await portfolioRoute.PUT(upload(companyId, "p.pdf", PORTFOLIO), ctx(companyId))).status).toBe(200);
    expect((await portfolioRoute.PUT(putJson(companyId, { url: "https://me.dev" }), ctx(companyId))).status).toBe(200);
    expect((await portfolioRoute.PUT(putJson(companyId, { portfolioId: "p0" }), ctx(companyId))).status).toBe(200);
  });
});

describe("PATCH /api/resumes/[id]/status · GET /api/resumes?status=", () => {
  const patch = (id: string, body: unknown) =>
    statusRoute.PATCH(
      new Request(`http://localhost/api/resumes/${id}/status`, { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      ctx(id),
    );

  it("상태 변경·공용 400·잘못된 값 400·남의 이력서 404", async () => {
    const res = await patch(companyId, { status: "applying" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resume: { applyStatus: string } }).resume.applyStatus).toBe("applying");
    expect((await patch(generalId, { status: "submitted" })).status).toBe(400);
    expect((await patch(companyId, { status: "weird" })).status).toBe(400);
    state.user = { id: "ub" };
    expect((await patch(companyId, { status: "draft" })).status).toBe(404);
  });

  it("목록 필터", async () => {
    await patch(companyId, { status: "submitted" });
    const ids = async (q: string) =>
      ((await (await listRoute.GET(new Request(`http://localhost/api/resumes${q}`))).json()) as { items: { id: string }[] }).items.map((i) => i.id);
    expect(await ids("?status=submitted")).toEqual([companyId]);
    expect(await ids("?status=draft")).toEqual([]);
    expect(await ids("?status=general")).toEqual([generalId]);
    expect((await ids("")).sort()).toEqual([companyId, generalId].sort());
    expect((await ids("?status=bogus")).length).toBe(2);
  });
});
