/**
 * 공고 찾기 API·가져오기 재사용·이력서 종류(PGlite, 세션·엔진·after()는 가짜):
 * 목록·필터 400·담기 201/200·관리자만 숨기기, 공고 찾기에 있는 링크는 엔진 없이 200 { fromShared },
 * 공용 이력서(kind general)·공용 이력서 내용으로 시작(sourceResumeId).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-shared-api-")), "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "가", role: "user" } as { id: string; email: string; name: string | null; role: string } | null,
  noEngine: false,
  afterTasks: [] as (() => unknown)[],
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  requireAdminApiUser: async () =>
    !state.user ? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }) : state.user.role === "admin" ? state.user : Response.json({ error: "관리자만", code: "admin_only" }, { status: 403 }),
  assertSameOrigin: () => null,
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", () => ({
  resolveRequestedProvider: async () => {
    if (state.noEngine) {
      const { FeatureError } = await import("@/lib/api/errors");
      throw new FeatureError("엔진 없음", 409);
    }
    return "anthropic";
  },
}));

let tdb: TestDb;
let list: typeof import("./route");
let item: typeof import("./[id]/route");
let save: typeof import("./[id]/save/route");
let importRoute: typeof import("@/app/api/postings/import/route");
let resumes: typeof import("@/app/api/resumes/route");
let shared: typeof import("@/lib/postings/shared");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  tdb = await createTestDb();
  list = await import("./route");
  item = await import("./[id]/route");
  save = await import("./[id]/save/route");
  importRoute = await import("@/app/api/postings/import/route");
  resumes = await import("@/app/api/resumes/route");
  shared = await import("@/lib/postings/shared");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  state.user = { id: "ua", email: "ua@x.com", name: "가", role: "user" };
  state.noEngine = false;
  state.afterTasks = [];
});

const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const seed = (url = "https://jobs.example/s/1", over: Record<string, unknown> = {}) =>
  shared.upsertSharedPosting({
    url,
    posting: PostingCreateInputSchema.parse({ company: "토스", roleTitle: "백엔드", url, jdText: "JD", ...over }),
    structure: null,
    sourceText: "원문",
    extractedBy: "fake",
    createdBy: "ub",
  });

describe("/api/shared-postings", () => {
  it("목록(내 보관함 표시) → 담기 201 → 다시 담기 200", async () => {
    const s = await seed();
    const res = await list.GET(new Request("http://localhost/api/shared-postings?company=토스&deadline=all"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string; myPostingId: string | null }[]; total: number };
    expect(body.total).toBe(1);
    expect(body.items[0]).toMatchObject({ id: s.id, myPostingId: null });
    expect(JSON.stringify(body)).not.toContain("createdBy");

    const first = await save.POST(json(`/api/shared-postings/${s.id}/save`, "POST", {}), ctx(s.id));
    expect(first.status).toBe(201);
    const { posting } = (await first.json()) as { posting: { id: string; sharedPostingId: string } };
    expect(posting.sharedPostingId).toBe(s.id);
    const again = await save.POST(json(`/api/shared-postings/${s.id}/save`, "POST", {}), ctx(s.id));
    expect(again.status).toBe(200);
    expect(await again.json()).toMatchObject({ created: false, posting: { id: posting.id } });

    const detail = await item.GET(new Request(`http://localhost/api/shared-postings/${s.id}`), ctx(s.id));
    expect(await detail.json()).toMatchObject({ posting: { id: s.id, myPostingId: posting.id, sourceText: "원문" } });
  });

  it("잘못된 필터는 400, 없는 공고는 404, 로그인 없으면 401", async () => {
    expect((await list.GET(new Request("http://localhost/api/shared-postings?deadline=xx"))).status).toBe(400);
    expect((await item.GET(new Request("http://localhost/api/shared-postings/nope"), ctx("nope"))).status).toBe(404);
    expect((await save.POST(json("/api/shared-postings/nope/save", "POST", {}), ctx("nope"))).status).toBe(404);
    state.user = null;
    expect((await list.GET(new Request("http://localhost/api/shared-postings"))).status).toBe(401);
  });

  it("숨기기는 관리자만", async () => {
    const s = await seed();
    const denied = await item.PATCH(json(`/api/shared-postings/${s.id}`, "PATCH", { hidden: true }), ctx(s.id));
    expect(denied.status).toBe(403);
    state.user = { id: "ua", email: "ua@x.com", name: null, role: "admin" };
    const ok = await item.PATCH(json(`/api/shared-postings/${s.id}`, "PATCH", { hidden: true }), ctx(s.id));
    expect(ok.status).toBe(200);
    // 관리자는 숨긴 공고도 열어(다시 공개) 볼 수 있고, 일반 사용자에게는 404.
    const adminView = await item.GET(new Request("http://localhost"), ctx(s.id));
    expect(adminView.status).toBe(200);
    expect(await adminView.json()).toMatchObject({ posting: { hidden: true } });
    state.user = { id: "ua", email: "ua@x.com", name: null, role: "user" };
    expect((await item.GET(new Request("http://localhost"), ctx(s.id))).status).toBe(404);
    state.user = { id: "ua", email: "ua@x.com", name: null, role: "admin" };
    expect((await item.PATCH(json(`/api/shared-postings/${s.id}`, "PATCH", { hidden: false }), ctx(s.id))).status).toBe(200);
    state.user = { id: "ua", email: "ua@x.com", name: null, role: "user" };
    expect((await item.GET(new Request("http://localhost"), ctx(s.id))).status).toBe(200);
    state.user = { id: "ua", email: "ua@x.com", name: null, role: "admin" };
    expect((await item.PATCH(json("/api/shared-postings/nope", "PATCH", { hidden: true }), ctx("nope"))).status).toBe(404);
  });
});

describe("POST /api/postings/import와 공고 찾기", () => {
  it("공고 찾기에 있는 링크는 엔진 없이 200 { fromShared }, 실행 예약 없음", async () => {
    await seed("https://jobs.example/s/2");
    state.noEngine = true;
    const res = await importRoute.POST(json("/api/postings/import", "POST", { url: "https://www.jobs.example/s/2?utm_source=a" }));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { fromShared: boolean; job: { status: string; postingId: string } };
    expect(body).toMatchObject({ fromShared: true, job: { status: "completed" } });
    expect(state.afterTasks).toHaveLength(0);
    // 다시 가져오기는 엔진이 필요하다.
    const refresh = await importRoute.POST(json("/api/postings/import", "POST", { url: "https://jobs.example/s/2", refresh: true }));
    expect(refresh.status).toBe(409);
    state.noEngine = false;
    const ok = await importRoute.POST(json("/api/postings/import", "POST", { url: "https://jobs.example/s/2", refresh: true }));
    expect(ok.status).toBe(202);
    expect(await ok.json()).toMatchObject({ job: { status: "queued", refresh: true, postingId: body.job.postingId } });
    expect(state.afterTasks).toHaveLength(1);
  });
});

describe("POST /api/resumes 종류", () => {
  it("공용 이력서는 회사·공고 없이 만들고(보낸 postingId 무시), 그 내용으로 공고용 이력서를 시작한다", async () => {
    const posting = await tdb.prisma.jobPosting.create({ data: { id: "p1", userId: "ua", company: "카카오", roleTitle: "서버", jdText: "JD 원문" } });
    const g = await resumes.POST(json("/api/resumes", "POST", { kind: "general", templateId: "classic", source: { kind: "blank" }, postingId: "p1" }));
    expect(g.status).toBe(201);
    const { id: gid } = (await g.json()) as { id: string };
    expect(await tdb.prisma.companyResume.findUnique({ where: { id: gid } })).toMatchObject({ kind: "general", company: "", postingId: null, title: "공용 이력서" });

    const c = await resumes.POST(
      json("/api/resumes", "POST", { kind: "company", templateId: "performance", source: { kind: "graph" }, postingId: posting.id, sourceResumeId: gid }),
    );
    expect(c.status).toBe(201);
    const { id: cid } = (await c.json()) as { id: string };
    const row = await tdb.prisma.companyResume.findUnique({ where: { id: cid } });
    // 복사본은 원본 양식(classic)을 따르고 공고 값으로 채워진다(AI 호출 없음).
    expect(row).toMatchObject({ kind: "company", company: "카카오", roleTitle: "서버", jdText: "JD 원문", postingId: "p1", sourceResumeId: gid, templateId: "classic" });

    // 남의 이력서로는 시작할 수 없다.
    state.user = { id: "ub", email: "ub@x.com", name: null, role: "user" };
    const denied = await resumes.POST(json("/api/resumes", "POST", { kind: "general", templateId: "classic", source: { kind: "blank" }, sourceResumeId: gid }));
    expect(denied.status).toBe(404);
    // 공고 없이 회사도 없으면 400.
    const bad = await resumes.POST(json("/api/resumes", "POST", { templateId: "classic", source: { kind: "blank" } }));
    expect(bad.status).toBe(400);
  });
});
