/**
 * 경험 그래프 포트폴리오(PGlite + 로컬 저장소 + 메모리 그래프 + 가짜 LLM, 세션은 가짜):
 * POST /api/portfolios/graph → 202 + after() → 실행 → 'graph' 포트폴리오·완료 알림, 지어낸 수치 표시, 링크(그래프·공개 저장소만),
 * 사용자 간 격리(남의 프로젝트 id·공고·포트폴리오·작업, 그래프 로더 버그), 실패 → 다시 시도, 멈춘 작업, 다시 만들기, 버려진 실행,
 * 본문 고치기 라우트, 인증·same-origin·검증, 이력서 첨부 → 면접·진단 경로가 읽는 본문.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph, GraphNode, NodeLabel } from "@/lib/domain/graph";
import type { GraphPortfolioJobView } from "@/lib/domain/graph-portfolio";
import type { LlmClient } from "@/lib/llm";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-graph-portfolio-")), "storage");

const A_MARK = "ALPHAMARK";
const B_MARK = "ZQXBMARK";

const state = vi.hoisted(() => ({
  user: null as { id: string; email: string; name: string | null } | null,
  forbidden: false,
  enabled: true,
  /** 버그 흉내: 그래프 로더가 요청 사용자와 상관없이 이 사용자의 그래프를 돌려준다. */
  leakFrom: null as string | null,
  afterTasks: [] as (() => unknown)[],
  graphs: new Map<string, { nodes: unknown[]; edges: unknown[] }>(),
  calls: [] as { userId: string | null; task: string | undefined; text: string }[],
  client: null as unknown,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.forbidden ? Response.json({ error: "허용되지 않은 요청입니다." }, { status: 403 }) : null),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers/options")>()),
  resolveRequestedProvider: async () => "anthropic",
}));
vi.mock("@/lib/graph/service", async () => {
  const { markGraphOwner } = await import("@/lib/graph/owner");
  const errors = await import("@/lib/graph/errors");
  const text = await import("@/lib/graph/text");
  type G = { nodes: CareerGraph["nodes"]; edges: CareerGraph["edges"] };
  const get = (u: string): G => (state.graphs.get(u) as G | undefined) ?? { nodes: [], edges: [] };
  return {
    ...errors,
    graphToText: text.graphToText,
    graphEnabled: () => state.enabled,
    getCareerGraph: async (userId: string, opts: { personName?: string | null } = {}): Promise<CareerGraph> => {
      const owner = state.leakFrom ?? userId;
      return markGraphOwner<CareerGraph>({ person: { id: "me", name: opts.personName ?? null }, ...structuredClone(get(owner)) }, owner);
    },
  };
});
vi.mock("@/lib/llm", async (orig) => {
  const actual = await orig<typeof import("@/lib/llm")>();
  return {
    ...actual,
    createLlmClient: (_provider: string, usage?: { userId?: string | null }): LlmClient => {
      const inner = state.client as LlmClient;
      return {
        name: inner.name,
        generate: async (req) => {
          state.calls.push({ userId: usage?.userId ?? null, task: req.task, text: `${req.system}\n${req.user}` });
          return inner.generate(req);
        },
      };
    },
  };
});

const A = { id: "ua", email: "ua@x.com", name: "에이" };
const B = { id: "ub", email: "ub@x.com", name: "비" };

function graphOf(mark: string, extra: GraphNode[] = []) {
  const n = (id: string, label: NodeLabel, props: Record<string, unknown>) => ({ id, label, props, createdAt: 1, updatedAt: 1 }) as GraphNode;
  return {
    nodes: [
      n("c1", "Company", { name: `${mark}회사` }),
      n("p1", "Project", {
        name: `${mark}결제개선`,
        summary: `${mark} 정산 배치를 다시 만들었다`,
        myRole: "백엔드 리드",
        result: "정산 시간 6시간→40분",
        url: `https://${mark.toLowerCase()}.dev/pay`,
      }),
      n("p2", "Project", { name: `${mark}사내도구` }),
      n("s1", "Skill", { name: `${mark}Kotlin` }),
      n("a1", "Achievement", { summary: `${mark} 정산 시간 단축`, value: "6시간→40분" }),
      ...extra,
    ],
    edges: [
      { id: "WORKED_ON:me:p1", type: "WORKED_ON", from: "me", to: "p1" },
      { id: "PART_OF:p1:c1", type: "PART_OF", from: "p1", to: "c1" },
      { id: "USED_SKILL:p1:s1", type: "USED_SKILL", from: "p1", to: "s1" },
      { id: "ACHIEVED:p1:a1", type: "ACHIEVED", from: "p1", to: "a1" },
    ],
  };
}

let tdb: TestDb;
let jobs: typeof import("./graph-jobs");
let svc: typeof import("./service");
let route: typeof import("@/app/api/portfolios/graph/route");
let jobRoute: typeof import("@/app/api/portfolios/graph/jobs/[id]/route");
let retryRoute: typeof import("@/app/api/portfolios/graph/jobs/[id]/retry/route");
let listRoute: typeof import("@/app/api/portfolios/graph/jobs/route");
let textRoute: typeof import("@/app/api/portfolios/[id]/text/route");
let attach: typeof import("@/lib/resumes/portfolio");
let resumes: typeof import("@/lib/resumes/service");
let FakeLlmClient: typeof import("@/test/fake-llm").FakeLlmClient;
let LlmPermanentError: typeof import("@/lib/llm").LlmPermanentError;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL"]) delete process.env[k];
  tdb = await createTestDb();
  jobs = await import("./graph-jobs");
  svc = await import("./service");
  route = await import("@/app/api/portfolios/graph/route");
  jobRoute = await import("@/app/api/portfolios/graph/jobs/[id]/route");
  retryRoute = await import("@/app/api/portfolios/graph/jobs/[id]/retry/route");
  listRoute = await import("@/app/api/portfolios/graph/jobs/route");
  textRoute = await import("@/app/api/portfolios/[id]/text/route");
  attach = await import("@/lib/resumes/portfolio");
  resumes = await import("@/lib/resumes/service");
  ({ FakeLlmClient } = await import("@/test/fake-llm"));
  ({ LlmPermanentError } = await import("@/lib/llm"));
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  state.user = A;
  state.forbidden = false;
  state.enabled = true;
  state.leakFrom = null;
  state.afterTasks = [];
  state.calls = [];
  state.client = new FakeLlmClient();
  state.graphs.clear();
  for (const u of [A, B]) await tdb.prisma.user.create({ data: { id: u.id, email: u.email, name: u.name, status: "approved" } });
  state.graphs.set(A.id, graphOf(A_MARK));
  state.graphs.set(B.id, graphOf(B_MARK, [{ id: "pb_only", label: "Project", props: { name: `${B_MARK}비밀` }, createdAt: 1, updatedAt: 1 } as GraphNode]));
  // GitHub: A는 p1에 공개 저장소, p2에 비공개 저장소를, B는 같은 p1에 공개 저장소를 이어 두었다.
  for (const u of [A, B]) await tdb.prisma.githubAccount.create({ data: { id: `gh_${u.id}`, userId: u.id, githubUserId: `gh_${u.id}`, login: u.id } });
  const snap = (id: string, userId: string, repoId: string, fullName: string, priv: boolean, projectNodeId: string) =>
    tdb.prisma.githubRepoSnapshot.create({
      data: { id, userId, repoId, fullName, htmlUrl: `https://github.com/${fullName}`, private: priv, data: {}, brief: "", builderVersion: 1, fetchedAt: new Date(), projectNodeId },
    });
  await snap("sa", A.id, "1", "ua/pay", false, "p1");
  await snap("sa_priv", A.id, "2", "ua/secret-pay", true, "p2");
  await snap("sb", B.id, "3", `ub/${B_MARK}`, false, "p1");
  await tdb.prisma.jobPosting.create({ data: { id: "post_a", userId: A.id, company: "페이랩", roleTitle: "백엔드", jdText: "Kotlin 정산 경험" } });
  await tdb.prisma.jobPosting.create({ data: { id: "post_b", userId: B.id, company: `${B_MARK}회사`, roleTitle: "백엔드", jdText: `${B_MARK} JD` } });
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const json = (body: unknown, method = "POST") =>
  new Request("http://localhost/api/portfolios/graph", { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
const start = (body: unknown) => route.POST(json(body));
const getJob = (id: string) => jobRoute.GET(new Request(`http://localhost/x/${id}`), ctx(id));
const retry = (id: string) => retryRoute.POST(new Request(`http://localhost/x/${id}/retry`, { method: "POST" }), ctx(id));
const putText = (id: string, body: unknown) =>
  textRoute.PUT(new Request(`http://localhost/api/portfolios/${id}/text`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }), ctx(id));
async function runAfter() {
  const tasks = state.afterTasks.splice(0);
  for (const t of tasks) await t();
}
async function startOk(body: Record<string, unknown> = { projectIds: ["p1"] }): Promise<GraphPortfolioJobView> {
  const res = await start(body);
  expect(res.status).toBe(202);
  return ((await res.json()) as { job: GraphPortfolioJobView }).job;
}
async function viewOf(id: string): Promise<GraphPortfolioJobView> {
  return ((await (await getJob(id)).json()) as { job: GraphPortfolioJobView }).job;
}
const failingClient = (): LlmClient => ({
  name: "fail",
  generate: async () => {
    throw new LlmPermanentError("거절", "refusal");
  },
});

describe("경험 그래프로 포트폴리오 만들기", () => {
  it("202로 바로 돌아가고, 백그라운드에서 'graph' 포트폴리오를 만들어 알린다(링크는 그래프·공개 저장소만, 지어낸 수치는 확인 표시)", async () => {
    const job = await startOk({ projectIds: ["p1"], title: "백엔드 포트폴리오", postingId: "post_a", notes: "성능 개선 강조" });
    expect(job).toMatchObject({ status: "running", stage: "material", label: "백엔드 포트폴리오", portfolioId: null, regenerate: false });
    expect(state.afterTasks).toHaveLength(1);
    expect(await tdb.prisma.portfolio.count()).toBe(0);

    await runAfter();
    const view = await viewOf(job.id);
    expect(view.status).toBe("completed");
    expect(view.portfolioId).toBeTruthy();
    const got = (await svc.getPortfolioText(A.id, view.portfolioId!))!;
    expect(got.portfolio).toMatchObject({ kind: "graph", title: "백엔드 포트폴리오", fileName: null, url: null });
    expect(got.portfolio.graphSource).toMatchObject({ projectIds: ["p1"], postingId: "post_a", notes: "성능 개선 강조", templateId: "project-pdf" });
    const text = got.text!;
    expect(got.portfolio.chars).toBe(text.length);
    expect(text).toContain(`## 1. ${A_MARK}결제개선`);
    expect(text).toContain("정산 시간 6시간→40분");
    // 그래프에 없는 수치(가짜 LLM이 일부러 넣은 999%)는 확인 표시로 바뀌고 채울 정보에 오른다.
    expect(text).toContain("[ADD: 수치 확인 — 전환율 999% 향상]");
    expect(view.missingInfo.some((m) => m.includes("999"))).toBe(true);
    // 링크: 그래프의 Project.url과 공개 저장소만(비공개 저장소·B의 저장소는 없다).
    expect(text).toContain(`https://${A_MARK.toLowerCase()}.dev/pay`);
    expect(text).toContain("https://github.com/ua/pay");
    expect(text).not.toContain("secret-pay");
    expect(text).not.toContain(B_MARK);
    // 프롬프트: A의 p1·공고·메모만, LLM 사용량은 A로.
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]).toMatchObject({ userId: A.id, task: "portfolio-draft" });
    expect(state.calls[0]!.text).toContain(`${A_MARK}결제개선`);
    expect(state.calls[0]!.text).toContain("Kotlin 정산 경험");
    expect(state.calls[0]!.text).not.toContain(`${A_MARK}사내도구`);
    expect(state.calls[0]!.text).not.toContain(B_MARK);

    const notes = await tdb.prisma.notification.findMany({ where: { userId: A.id } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ kind: "portfolio-draft-completed", link: `/app/portfolios/${view.portfolioId}` });
    // 완료하면 입력은 지운다.
    expect((await tdb.prisma.portfolioDraftJob.findUniqueOrThrow({ where: { id: job.id } })).input).toBeNull();
    // 보관함 목록에도 나온다.
    expect((await svc.listPortfolios(A.id)).map((p) => p.kind)).toEqual(["graph"]);
  });

  it("양식: 고른 양식(case-study)의 구역 제목·순서로 쓰고 graphSource에 남기며, 다시 만들 때 양식을 바꿀 수 있다", async () => {
    const job = await startOk({ projectIds: ["p1"], templateId: "case-study" });
    await runAfter();
    const view = await viewOf(job.id);
    expect(view.status).toBe("completed");
    const got = (await svc.getPortfolioText(A.id, view.portfolioId!))!;
    expect(got.portfolio.graphSource?.templateId).toBe("case-study");
    const text = got.text!;
    expect(state.calls[0]!.text).toContain("포트폴리오 양식: 케이스 스터디 [case-study]");
    expect(text).toContain(`## Case 1. ${A_MARK}결제개선`);
    const idx = ["### Problem · 문제", "### Role · 역할", "### Approach · 접근", "### Result · 결과"].map((h) => text.indexOf(h));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect(idx).toEqual([...idx].sort((a, b) => a - b));
    expect(text).toContain("[ADD: 수치 확인 — 전환율 999% 향상]");
    expect(text).not.toContain("양식에 없는 구역");
    expect(text).not.toContain("### 개요");

    const again = await startOk({ projectIds: ["p1"], templateId: "ml-data", portfolioId: view.portfolioId });
    await runAfter();
    expect((await viewOf(again.id)).status).toBe("completed");
    const regen = (await svc.getPortfolioText(A.id, view.portfolioId!))!;
    expect(regen.portfolio.graphSource?.templateId).toBe("ml-data");
    expect(regen.text).toContain("### 문제 정의");
    expect(regen.text).not.toContain("### Problem · 문제");
    expect((await start({ projectIds: ["p1"], templateId: "fancy" })).status).toBe(400);
  });

  it("이력서에 붙이면 면접 질문·진단 경로가 저장한 본문을 읽는다", async () => {
    const job = await startOk();
    await runAfter();
    const portfolioId = (await viewOf(job.id)).portfolioId!;
    const { emptyResumeDocument } = await import("@/lib/domain/resumes");
    const resume = await resumes.createResume(A.id, {
      templateId: "classic",
      document: emptyResumeDocument(),
      source: "manual",
      company: "토스",
      roleTitle: "백엔드",
    });
    expect((await attach.attachPortfolio(A.id, resume.resume.id, portfolioId)).ok).toBe(true);
    const got = (await attach.getResumePortfolioText(A.id, resume.resume.id))!;
    expect(got.info?.kind).toBe("graph");
    expect(got.text).toContain(`${A_MARK}결제개선`);
    const { portfolioReadable } = await import("@/lib/domain/portfolios");
    expect(portfolioReadable(got.info!)).toBe(true);
  });

  it("격리: 남의 프로젝트 id·남의 공고·남의 포트폴리오로는 시작하지 않는다(LLM 호출 없음)", async () => {
    const foreign = await start({ projectIds: ["p1", "pb_only"] });
    expect(foreign.status).toBe(400);
    expect(await foreign.text()).not.toContain(B_MARK);
    expect((await start({ projectIds: ["p1"], postingId: "post_b" })).status).toBe(404);
    const bPortfolio = await svc.createGraphPortfolio(B.id, {
      title: "B",
      text: `${B_MARK} 본문`,
      source: { projectIds: ["p1"], postingId: null, notes: "", missingInfo: [], generatedAt: 1 },
    });
    expect((await start({ projectIds: ["p1"], portfolioId: bPortfolio.portfolio.id })).status).toBe(404);
    expect(await tdb.prisma.portfolioDraftJob.count()).toBe(0);
    await runAfter();
    expect(state.calls).toHaveLength(0);
    // B의 본문은 그대로.
    expect((await svc.getPortfolioText(B.id, bPortfolio.portfolio.id))!.text).toBe(`${B_MARK} 본문`);
  });

  it("격리: 같은 노드 id(p1)여도 A의 그래프만 프롬프트에 들어가고, B의 작업은 A로 실행·조회되지 않는다", async () => {
    await tdb.prisma.portfolioDraftJob.create({
      data: { id: "b_job", userId: B.id, runId: "b_run", status: "running", label: `${B_MARK}`, input: { projectIds: ["p1"], provider: "anthropic" }, provider: "anthropic" },
    });
    const j = await getJob("b_job");
    expect(j.status).toBe(404);
    expect(await j.text()).not.toContain(B_MARK);
    expect((await retry("b_job")).status).toBe(404);
    await jobs.runGraphPortfolioJob(A.id, "b_job", "b_run", "anthropic");
    expect(state.calls).toHaveLength(0);
    expect(await tdb.prisma.portfolioDraftJob.findUniqueOrThrow({ where: { id: "b_job" } })).toMatchObject({ status: "running", portfolioId: null });

    await startOk();
    await runAfter();
    expect(state.calls).toHaveLength(1);
    expect(state.calls[0]!.text).toContain(A_MARK);
    expect(state.calls[0]!.text).not.toContain(B_MARK);
  });

  it("격리: 그래프 로더가 다른 사용자의 그래프를 돌려주면(버그) 시작·실행 모두 LLM을 부르지 않는다", async () => {
    const job = await startOk();
    state.leakFrom = B.id;
    await runAfter();
    expect(state.calls).toHaveLength(0);
    const view = await viewOf(job.id);
    expect(view.status).toBe("failed");
    expect(view.error ?? "").not.toContain(B_MARK);
    expect(await tdb.prisma.portfolio.count()).toBe(0);
    // 시작 요청도 막힌다(500, B 데이터 없음).
    const res = await start({ projectIds: ["p1"] });
    expect(res.status).toBe(500);
    expect(await res.text()).not.toContain(B_MARK);
  });

  it("그래프 저장소 없음 → 503, 목록 GET은 enabled:false. 그래프에 프로젝트가 없으면 409", async () => {
    state.enabled = false;
    expect((await start({ projectIds: ["p1"] })).status).toBe(503);
    expect(await (await route.GET()).json()).toEqual({ enabled: false, projects: [] });
    state.enabled = true;
    const list = (await (await route.GET()).json()) as { enabled: boolean; projects: { id: string; name: string }[] };
    expect(list.projects.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(JSON.stringify(list)).not.toContain(B_MARK);
    state.graphs.set(A.id, { nodes: [], edges: [] });
    expect((await start({ projectIds: ["p1"] })).status).toBe(409);
  });

  it("인증·same-origin·검증", async () => {
    state.user = null;
    expect((await start({ projectIds: ["p1"] })).status).toBe(401);
    expect((await route.GET()).status).toBe(401);
    expect((await getJob("x")).status).toBe(401);
    expect((await putText("x", { text: "a" })).status).toBe(401);
    state.user = A;
    state.forbidden = true;
    expect((await start({ projectIds: ["p1"] })).status).toBe(403);
    expect((await retry("x")).status).toBe(403);
    expect((await putText("x", { text: "a" })).status).toBe(403);
    state.forbidden = false;
    expect((await start({ projectIds: [] })).status).toBe(400);
    expect((await start({ projectIds: Array.from({ length: 13 }, (_, i) => `p${i}`) })).status).toBe(400);
    expect((await start({ projectIds: ["p1"], notes: "가".repeat(1001) })).status).toBe(400);
    expect((await start({})).status).toBe(400);
    expect(await tdb.prisma.portfolioDraftJob.count()).toBe(0);
  });

  it("실패하면 'failed' + 알림, 다시 시도하면 처음부터 실행해 완성한다", async () => {
    state.client = failingClient();
    const job = await startOk();
    await runAfter();
    const failed = await viewOf(job.id);
    expect(failed).toMatchObject({ status: "failed", canRetry: true });
    expect(failed.error).toContain("포트폴리오를 만들지 못했습니다");
    expect(await tdb.prisma.notification.count({ where: { userId: A.id, kind: "portfolio-draft-failed" } })).toBe(1);
    expect((await (await listRoute.GET()).json()).items).toHaveLength(1);

    state.client = new FakeLlmClient();
    const res = await retry(job.id);
    expect(res.status).toBe(202);
    expect(((await res.json()) as { job: GraphPortfolioJobView }).job).toMatchObject({ status: "running", attempts: 2 });
    await runAfter();
    expect(await viewOf(job.id)).toMatchObject({ status: "completed", canRetry: false });
    expect((await retry(job.id)).status).toBe(409);
    expect((await (await listRoute.GET()).json()).items).toHaveLength(0);
  });

  it("멈춘 작업은 읽을 때 실패로 닫고 알리며, 늦게 끝난 실행은 포트폴리오를 남기지 않는다", async () => {
    const job = await startOk();
    await tdb.prisma.portfolioDraftJob.update({ where: { id: job.id }, data: { startedAt: new Date(Date.now() - jobs.graphPortfolioStaleMs() - 1000) } });
    expect(await viewOf(job.id)).toMatchObject({ status: "failed", canRetry: true });
    expect(await tdb.prisma.notification.count({ where: { userId: A.id, kind: "portfolio-draft-failed" } })).toBe(1);
    await runAfter();
    expect(await tdb.prisma.portfolio.count()).toBe(0);
    expect(state.calls.length).toBeLessThanOrEqual(1);
    expect(await tdb.prisma.notification.count({ where: { userId: A.id } })).toBe(1);
  });

  it("동시 작업 상한", async () => {
    await startOk();
    await startOk();
    expect((await start({ projectIds: ["p1"] })).status).toBe(409);
  });

  it("다시 만들기: 같은 포트폴리오의 본문·생성 정보를 바꾸고(이름·첨부 유지), 파일 포트폴리오는 409", async () => {
    const first = await startOk({ projectIds: ["p1"], title: "처음" });
    await runAfter();
    const id = (await viewOf(first.id)).portfolioId!;
    await putText(id, { text: "# 직접 고친 본문" });
    const again = await startOk({ projectIds: ["p1", "p2"], portfolioId: id });
    expect(again).toMatchObject({ label: "처음", portfolioId: id, regenerate: true });
    await runAfter();
    expect(await viewOf(again.id)).toMatchObject({ status: "completed", portfolioId: id, regenerate: true });
    const got = (await svc.getPortfolioText(A.id, id))!;
    expect(got.portfolio.title).toBe("처음");
    expect(got.portfolio.graphSource?.projectIds).toEqual(["p1", "p2"]);
    expect(got.text).toContain(`${A_MARK}사내도구`);
    expect(got.text).not.toContain("직접 고친 본문");
    expect(await tdb.prisma.portfolio.count()).toBe(1);

    const file = await svc.createPortfolioFromFile(A.id, { fileName: "a.md", text: "파일" });
    expect((await start({ projectIds: ["p1"], portfolioId: file.portfolio.id })).status).toBe(409);
  });

  it("본문 고치기 라우트: 내 'graph'만, 파일은 409, 남의 것은 404, 빈 본문은 400", async () => {
    const job = await startOk();
    await runAfter();
    const id = (await viewOf(job.id)).portfolioId!;
    const before = (await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } })).textKey;
    const res = await putText(id, { text: "  # 고친 본문\n- [ADD: 팀 규모]  " });
    expect(res.status).toBe(200);
    const got = (await svc.getPortfolioText(A.id, id))!;
    expect(got.text).toBe("# 고친 본문\n- [ADD: 팀 규모]");
    expect(got.portfolio.chars).toBe(got.text!.length);
    expect(got.portfolio.graphSource?.projectIds).toEqual(["p1"]);
    expect((await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } })).textKey).not.toBe(before);
    expect((await putText(id, { text: "   " })).status).toBe(400);
    // '채워야 할 자리'는 저장한 본문에서 다시 센다 — 남아 있으면 AI 목록을 두고, 다 채우면 목록도 비운다.
    expect(got.portfolio.graphSource).toMatchObject({ addMarkers: 1 });
    expect(got.portfolio.graphSource!.missingInfo.length).toBeGreaterThan(0);
    expect((await putText(id, { text: "# 다 채운 본문" })).status).toBe(200);
    expect((await svc.getPortfolio(A.id, id))!.graphSource).toMatchObject({ addMarkers: 0, missingInfo: [], projectIds: ["p1"] });
    expect((await putText(id, { text: "# 고친 본문\n- [ADD: 팀 규모]" })).status).toBe(200);

    const file = await svc.createPortfolioFromFile(A.id, { fileName: "a.md", text: "파일" });
    expect((await putText(file.portfolio.id, { text: "x" })).status).toBe(409);
    state.user = B;
    expect((await putText(id, { text: "B가 덮어쓰기" })).status).toBe(404);
    expect((await svc.getPortfolioText(A.id, id))!.text).toBe("# 고친 본문\n- [ADD: 팀 규모]");
  });

  it("다시 만드는 중에는 같은 포트폴리오의 두 번째 다시 만들기·본문 고치기를 409로 막는다", async () => {
    const first = await startOk();
    await runAfter();
    const id = (await viewOf(first.id)).portfolioId!;
    const before = (await svc.getPortfolioText(A.id, id))!.text;
    const again = await startOk({ projectIds: ["p1"], portfolioId: id });
    expect((await start({ projectIds: ["p1", "p2"], portfolioId: id })).status).toBe(409);
    expect((await jobs.findActiveRegenerateJob(A.id, id))?.id).toBe(again.id);
    const res = await putText(id, { text: "# 다시 만드는 중에 고친 본문" });
    expect(res.status).toBe(409);
    expect((await svc.getPortfolioText(A.id, id))!.text).toBe(before);
    // 고치기가 되돌려졌으므로 새 본문 객체도 남지 않는다.
    const { listByPrefix, userPrefix } = await import("@/lib/storage");
    expect(await listByPrefix(userPrefix(A.id, "portfolios", id))).toHaveLength(1);
    await runAfter();
    expect(await viewOf(again.id)).toMatchObject({ status: "completed" });
    expect(await jobs.findActiveRegenerateJob(A.id, id)).toBeNull();
    expect((await putText(id, { text: "# 끝난 뒤 고친 본문" })).status).toBe(200);
  });

  it("다시 만들기 실행 중 작업이 멈춤으로 닫히면 본문·생성 정보를 바꾸지 않는다", async () => {
    const first = await startOk({ projectIds: ["p1"] });
    await runAfter();
    const id = (await viewOf(first.id)).portfolioId!;
    const before = await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } });
    const beforeText = (await svc.getPortfolioText(A.id, id))!.text;
    const again = await startOk({ projectIds: ["p1", "p2"], portfolioId: id });
    const fake = new FakeLlmClient();
    state.client = {
      name: fake.name,
      generate: async (req) => {
        // AI 작성 중에 멈춤 판정(closeStale)이 작업을 실패로 닫았다.
        await tdb.prisma.portfolioDraftJob.update({ where: { id: again.id }, data: { startedAt: new Date(Date.now() - jobs.graphPortfolioStaleMs() - 1000) } });
        expect(await viewOf(again.id)).toMatchObject({ status: "failed" });
        return fake.generate(req);
      },
    } satisfies LlmClient;
    await runAfter();
    expect(state.calls).toHaveLength(2);
    const after = await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } });
    expect(after.textKey).toBe(before.textKey);
    expect(after.graphSource).toEqual(before.graphSource);
    expect((await svc.getPortfolioText(A.id, id))!.text).toBe(beforeText);
    expect(await viewOf(again.id)).toMatchObject({ status: "failed", canRetry: true });
    expect(await tdb.prisma.notification.count({ where: { userId: A.id, kind: "portfolio-draft-completed" } })).toBe(1);
    const { listByPrefix, userPrefix } = await import("@/lib/storage");
    expect(await listByPrefix(userPrefix(A.id, "portfolios", id))).toEqual([before.textKey]);
  });

  it("본문 바꾸기의 commit 확인이 거절하면(완료 기록 0행) 행 변경을 되돌리고 새 본문을 지운다", async () => {
    const job = await startOk();
    await runAfter();
    const id = (await viewOf(job.id)).portfolioId!;
    const before = await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } });
    const beforeText = (await svc.getPortfolioText(A.id, id))!.text;
    expect(await svc.replacePortfolioText(A.id, id, "# 버려질 본문", { commit: async () => false })).toBe("aborted");
    const after = await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } });
    expect(after).toMatchObject({ textKey: before.textKey, chars: before.chars });
    expect(after.graphSource).toEqual(before.graphSource);
    expect((await svc.getPortfolioText(A.id, id))!.text).toBe(beforeText);
    const { listByPrefix, userPrefix } = await import("@/lib/storage");
    expect(await listByPrefix(userPrefix(A.id, "portfolios", id))).toEqual([before.textKey]);
  });

  it("본문 바꾸기는 compare-and-swap: 동시에 써도 고아 본문이 남지 않고 행은 남아 있는 본문을 가리킨다", async () => {
    const job = await startOk();
    await runAfter();
    const id = (await viewOf(job.id)).portfolioId!;
    const results = await Promise.all([svc.replacePortfolioText(A.id, id, "# 하나"), svc.replacePortfolioText(A.id, id, "# 둘")]);
    expect(results.some((r) => r !== null && typeof r === "object")).toBe(true);
    expect(results.every((r) => (r !== null && typeof r === "object") || r === "conflict")).toBe(true);
    const row = await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } });
    const { listByPrefix, userPrefix } = await import("@/lib/storage");
    expect(await listByPrefix(userPrefix(A.id, "portfolios", id))).toEqual([row.textKey]);
    expect(["# 하나", "# 둘"]).toContain((await svc.getPortfolioText(A.id, id))!.text);
  });

  it("claim: 워커가 먼저 맡은 runId는 Vercel 실행이 건너뛰고, 같은 runId를 두 번 실행해도 한 번만 쓴다", async () => {
    const job = await startOk();
    const row = await tdb.prisma.portfolioDraftJob.findUniqueOrThrow({ where: { id: job.id } });
    // 워커(worker/app/jobs/portfolio_graph.py)가 같은 SQL로 먼저 맡았다.
    expect(await jobs.claimGraphPortfolioRun(A.id, job.id, row.runId, "worker")).toBe(true);
    expect(await jobs.claimGraphPortfolioRun(A.id, job.id, row.runId)).toBe(false);
    await runAfter();
    expect(state.calls).toHaveLength(0);
    expect(await tdb.prisma.portfolioDraftJob.findUniqueOrThrow({ where: { id: job.id } })).toMatchObject({
      status: "running",
      result: { claimRunId: row.runId, runner: "worker" },
    });
    expect(await viewOf(job.id)).toMatchObject({ status: "running", notes: [], missingInfo: [], regenerate: false });
    // 남의 작업은 맡지 못한다.
    expect(await jobs.claimGraphPortfolioRun(B.id, job.id, row.runId, "worker")).toBe(false);

    const second = await startOk();
    const run2 = (await tdb.prisma.portfolioDraftJob.findUniqueOrThrow({ where: { id: second.id } })).runId;
    await Promise.all([jobs.runGraphPortfolioJob(A.id, second.id, run2, "anthropic"), jobs.runGraphPortfolioJob(A.id, second.id, run2, "anthropic")]);
    expect(state.calls).toHaveLength(1);
    expect(await tdb.prisma.portfolio.count()).toBe(1);
    expect((await viewOf(second.id)).status).toBe("completed");
  });

  it("파일·링크로 내용을 바꾸면 생성 정보를 지운다", async () => {
    const job = await startOk();
    await runAfter();
    const id = (await viewOf(job.id)).portfolioId!;
    const p = await svc.replacePortfolioUrl(A.id, id, "https://me.dev");
    expect(p).toMatchObject({ kind: "url", graphSource: null, chars: null });
    expect((await tdb.prisma.portfolio.findUniqueOrThrow({ where: { id } })).graphSource).toBeNull();
  });
});
