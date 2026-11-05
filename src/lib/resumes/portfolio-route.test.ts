/**
 * 이력서 포트폴리오·지원 상태·목록 필터 API(PGlite, 세션은 가짜): 파일 업로드(추출 텍스트 저장)·URL·떼기·미리보기,
 * 남의 이력서 404, 업로드 레이트 리밋 429, 상태 PATCH(공용 400), GET /api/resumes?status=.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

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
function upload(id: string, name: string, content: string) {
  const fd = new FormData();
  fd.set("file", new File([content], name, { type: "text/plain" }));
  return new Request(url(id), { method: "PUT", body: fd });
}
const putJson = (id: string, body: unknown) =>
  new Request(url(id), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

const PORTFOLIO = "결제 정산 배치를 Kotlin으로 다시 만들었습니다. 처리 시간을 4시간에서 40분으로 줄였고, 실패 재처리 기준을 정했습니다.\n".repeat(3);

describe("PUT·GET·DELETE /api/resumes/[id]/portfolio", () => {
  it("파일을 올리면 뽑은 글을 저장하고, 미리보기·본문(include=text)을 돌려준다", async () => {
    const res = await portfolioRoute.PUT(upload(companyId, "포트폴리오.md", PORTFOLIO), ctx(companyId));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { resume: { portfolio: { kind: string; fileName: string; chars: number } }; truncated: boolean; warnings: string[] };
    expect(body.resume.portfolio).toMatchObject({ kind: "file", fileName: "포트폴리오.md" });
    expect(body.truncated).toBe(false);

    const got = (await (await portfolioRoute.GET(new Request(url(companyId)), ctx(companyId))).json()) as Record<string, unknown>;
    expect(got.chars).toBeGreaterThan(50);
    expect(String(got.preview)).toContain("결제 정산");
    expect(got.text).toBeUndefined();
    const full = (await (await portfolioRoute.GET(new Request(url(companyId, "?include=text")), ctx(companyId))).json()) as { text: string };
    expect(full.text).toContain("40분");
  });

  it("URL로 바꾸고(http/https만) 떼기", async () => {
    expect((await portfolioRoute.PUT(putJson(companyId, { url: "javascript:alert(1)" }), ctx(companyId))).status).toBe(400);
    const res = await portfolioRoute.PUT(putJson(companyId, { url: "https://me.dev/work" }), ctx(companyId));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { resume: { portfolio: unknown } }).resume.portfolio).toMatchObject({ kind: "url", url: "https://me.dev/work" });
    const del = await portfolioRoute.DELETE(new Request(url(companyId), { method: "DELETE" }), ctx(companyId));
    expect(((await del.json()) as { resume: { portfolio: unknown } }).resume.portfolio).toBeNull();
    const got = (await (await portfolioRoute.GET(new Request(url(companyId)), ctx(companyId))).json()) as Record<string, unknown>;
    expect(got).toMatchObject({ info: null, chars: 0, preview: "" });
  });

  it("남의 이력서 404, 지원하지 않는 형식 415, 빈 폼 400", async () => {
    state.user = { id: "ub" };
    expect((await portfolioRoute.PUT(upload(companyId, "p.md", PORTFOLIO), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.GET(new Request(url(companyId)), ctx(companyId))).status).toBe(404);
    expect((await portfolioRoute.DELETE(new Request(url(companyId), { method: "DELETE" }), ctx(companyId))).status).toBe(404);
    state.user = { id: "ua" };
    expect((await portfolioRoute.PUT(upload(companyId, "p.exe", PORTFOLIO), ctx(companyId))).status).toBe(415);
    expect((await portfolioRoute.PUT(new Request(url(companyId), { method: "PUT", body: new FormData() }), ctx(companyId))).status).toBe(400);
  });

  it("파일 업로드는 사용자당 레이트 리밋(429 + Retry-After)", async () => {
    for (let i = 0; i < limits.RESUME_PORTFOLIO_UPLOAD_LIMIT.limit; i++) await limits.hitDbLimit(limits.RESUME_PORTFOLIO_UPLOAD_LIMIT, "ua");
    const res = await portfolioRoute.PUT(upload(companyId, "p.md", PORTFOLIO), ctx(companyId));
    expect(res.status).toBe(429);
    expect(Number(res.headers.get("Retry-After"))).toBeGreaterThan(0);
    // URL 첨부는 막지 않는다.
    expect((await portfolioRoute.PUT(putJson(companyId, { url: "https://me.dev" }), ctx(companyId))).status).toBe(200);
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
