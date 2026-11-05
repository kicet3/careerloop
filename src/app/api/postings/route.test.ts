/**
 * 공고 API·진단/이력서 생성의 postingId(실제 SQLite, 세션·엔진·after()는 가짜): 인증·출처, 409 existingId,
 * 남의 공고 거절, 가져오기 202, 진단이 공고 JD로 만들어지는지.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-postings-api-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.STORAGE_DIR = path.join(dir, "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "가" } as { id: string; email: string; name: string | null } | null,
  crossSite: false,
  afterTasks: [] as (() => unknown)[],
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossSite ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
// 진단 실행은 이 테스트의 관심 밖이다(LLM을 부르지 않게).
vi.mock("@/lib/panel/runner", () => ({ runDiagnosis: vi.fn(async () => {}), stageErrorMessage: () => "" }));

let db: typeof import("@/lib/db/client").db;
let schema: typeof import("@/lib/db/client").schema;
let postings: typeof import("./route");
let item: typeof import("./[id]/route");
let importRoute: typeof import("./import/route");
let importJob: typeof import("./import/[jobId]/route");
let diagnosesRoute: typeof import("@/app/api/diagnoses/route");

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  ({ db, schema } = await import("@/lib/db/client"));
  for (const id of ["ua", "ub"]) await db.insert(schema.users).values({ id, email: `${id}@x.com`, passwordHash: "x" });
  postings = await import("./route");
  item = await import("./[id]/route");
  importRoute = await import("./import/route");
  importJob = await import("./import/[jobId]/route");
  diagnosesRoute = await import("@/app/api/diagnoses/route");
});

beforeEach(() => {
  state.user = { id: "ua", email: "ua@x.com", name: "가" };
  state.crossSite = false;
  state.afterTasks = [];
});

const json = (url: string, method: string, body: unknown) =>
  new Request(`http://localhost${url}`, { method, headers: { "Content-Type": "application/json", Origin: "http://localhost" }, body: JSON.stringify(body) });
const ctx = <T extends string>(key: T, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<T, string>) });

describe("/api/postings", () => {
  it("만들기 201 → 목록 → 같은 URL은 409 { existingId }", async () => {
    const res = await postings.POST(json("/api/postings", "POST", { company: "토스", roleTitle: "Server", url: "https://toss.im/job/1", jdText: "자격 요건\nKotlin" }));
    expect(res.status).toBe(201);
    const { posting } = (await res.json()) as { posting: { id: string } };
    const list = (await (await postings.GET(new Request("http://localhost/api/postings"))).json()) as { items: { id: string }[] };
    expect(list.items.map((p) => p.id)).toContain(posting.id);
    const dup = await postings.POST(json("/api/postings", "POST", { company: "토스", roleTitle: "Server", url: "toss.im/job/1/" }));
    expect(dup.status).toBe(409);
    expect(await dup.json()).toEqual({ error: "이미 보관함에 있는 공고입니다.", existingId: posting.id });
  });

  it("입력 오류는 한국어 400, 로그인 없으면 401, 다른 출처면 403", async () => {
    const bad = await postings.POST(json("/api/postings", "POST", { company: "", roleTitle: "x" }));
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toBe("회사 이름을 입력하세요.");
    state.user = null;
    expect((await postings.GET(new Request("http://localhost/api/postings"))).status).toBe(401);
    state.user = { id: "ua", email: "ua@x.com", name: null };
    state.crossSite = true;
    expect((await postings.POST(json("/api/postings", "POST", { company: "a", roleTitle: "b" }))).status).toBe(403);
  });

  it("남의 공고는 조회·수정·삭제 모두 404", async () => {
    const res = await postings.POST(json("/api/postings", "POST", { company: "비밀", roleTitle: "x" }));
    const { posting } = (await res.json()) as { posting: { id: string } };
    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await item.GET(new Request("http://localhost"), ctx("id", posting.id))).status).toBe(404);
    expect((await item.PATCH(json("/x", "PATCH", { status: "closed" }), ctx("id", posting.id))).status).toBe(404);
    expect((await item.DELETE(json("/x", "DELETE", {}), ctx("id", posting.id))).status).toBe(404);
    state.user = { id: "ua", email: "ua@x.com", name: null };
    const detail = (await (await item.GET(new Request("http://localhost"), ctx("id", posting.id))).json()) as { posting: { company: string }; links: unknown };
    expect(detail).toMatchObject({ posting: { company: "비밀" }, links: { diagnoses: [], resumes: [] } });
  });
});

describe("/api/postings/import", () => {
  it("202 { jobId }로 작업을 만들고 실행은 after()에 예약한다. 남의 작업은 404", async () => {
    const res = await importRoute.POST(json("/api/postings/import", "POST", { url: "https://jobs.example/new/1" }));
    expect(res.status).toBe(202);
    const { jobId, job } = (await res.json()) as { jobId: string; job: { status: string } };
    expect(job.status).toBe("queued");
    expect(state.afterTasks).toHaveLength(1);
    expect((await importJob.GET(new Request("http://localhost"), ctx("jobId", jobId))).status).toBe(200);
    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await importJob.GET(new Request("http://localhost"), ctx("jobId", jobId))).status).toBe(404);
  });
});

describe("POST /api/diagnoses의 postingId", () => {
  const resume = "홍길동 백엔드 개발자. 결제 API 응답 시간 40% 단축. Python, SQL, AWS 운영 경험 5년.";
  const form = (fields: Record<string, string>) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    return new Request("http://localhost/api/diagnoses", { method: "POST", headers: { Origin: "http://localhost" }, body: fd });
  };

  it("내 공고면 공고 JD·직무로 진단을 만들고 연결한다", async () => {
    const res = await postings.POST(json("/api/postings", "POST", { company: "페이랩", roleTitle: "백엔드 개발자", jdText: "자격 요건\nPython 3년 이상, SQL 능숙" }));
    const { posting } = (await res.json()) as { posting: { id: string } };
    const created = await diagnosesRoute.POST(form({ resumeText: resume, postingId: posting.id }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(schema.diagnoses).where(eq(schema.diagnoses.id, id));
    expect(row).toMatchObject({ postingId: posting.id, targetRole: "백엔드 개발자", jdText: "자격 요건\nPython 3년 이상, SQL 능숙" });
    await db.delete(schema.diagnoses).where(eq(schema.diagnoses.id, id)); // 진행 중 1건 제한을 다음 테스트에서 피한다
  });

  it("남의 공고 id면 404이고 진단을 만들지 않는다", async () => {
    state.user = { id: "ub", email: "ub@x.com", name: null };
    const res = await postings.POST(json("/api/postings", "POST", { company: "남", roleTitle: "백엔드" }));
    const { posting } = (await res.json()) as { posting: { id: string } };
    state.user = { id: "ua", email: "ua@x.com", name: null };
    const created = await diagnosesRoute.POST(form({ resumeText: resume, targetRole: "백엔드", postingId: posting.id }));
    expect(created.status).toBe(404);
  });
});

describe("POST /api/resumes의 postingId", () => {
  it("비운 회사·직무·JD를 공고 값으로 채워 이력서를 만들고, 남의 공고는 404", async () => {
    for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
    const resumes = await import("@/app/api/resumes/route");
    const res = await postings.POST(json("/api/postings", "POST", { company: "카카오", roleTitle: "서버 개발자", jdText: "JD 원문" }));
    const { posting } = (await res.json()) as { posting: { id: string } };
    const created = await resumes.POST(json("/api/resumes", "POST", { company: "", roleTitle: "", templateId: "classic", source: { kind: "blank" }, postingId: posting.id }));
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: string };
    const { eq } = await import("drizzle-orm");
    const [row] = await db.select().from(schema.companyResumes).where(eq(schema.companyResumes.id, id));
    expect(row).toMatchObject({ company: "카카오", roleTitle: "서버 개발자", jdText: "JD 원문", postingId: posting.id });

    state.user = { id: "ub", email: "ub@x.com", name: null };
    const denied = await resumes.POST(json("/api/resumes", "POST", { company: "x", roleTitle: "y", templateId: "classic", source: { kind: "blank" }, postingId: posting.id }));
    expect(denied.status).toBe(404);
  });
});
