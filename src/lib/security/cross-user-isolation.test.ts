/**
 * 사용자 간 경험 그래프 격리 회귀 테스트(가장 중요한 보안 규칙: 사용자 A를 위해 부른 LLM은 사용자 B의 그래프 데이터를 받지 않는다).
 *
 * A와 B가 같은 노드 id(p1·c1·s1·a1)를 쓰는 그래프를 갖고, B의 노드 이름·속성, 후속 질문, 대화 메시지, GitHub 저장소 요약에는
 * 고유 표지(B_MARK)를 심는다. 그래프 저장소는 메모리 가짜(실제 서비스처럼 userId로 나누고 소유자 표시를 단다),
 * LLM은 받은 프롬프트(system+user)를 모두 기록하는 가짜다. 그리고
 * ① 그래프를 프롬프트에 넣는 모든 LLM 경로(그래프 채팅 일반·프로젝트·후속 질문 답·자료 가져오기·GitHub 가져오기·그래프에 묻기·이력서 초안·포트폴리오)를
 *    A로 돌려 어떤 프롬프트에도 B_MARK가 없고(A 표지는 있고), LLM 사용자도 A인지 본다.
 * ② 그래프 API 라우트에서 A가 B의 id(스레드·메시지·후속 질문·초안 작업·공고)를 쓰면 404이고 응답에 B_MARK가 없으며 B의 데이터가 그대로인지 본다.
 *    같은 노드 id를 A가 고치거나 지워도 B의 노드·후속 질문·저장소 연결은 그대로여야 한다.
 * ③ 소유자 확인(graph/owner.ts): 그래프 로더가 잘못 B의 그래프를 돌려줘도 LLM을 부르지 않는다.
 * MCP 경로는 cross-user-isolation.mcp.test.ts.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import type { ApplyGraphOpsResult, CareerGraph, GraphNode, GraphOp, NodeLabel } from "@/lib/domain/graph";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-isolation-")), "storage");
for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL"]) delete process.env[k];
// 그래프에 묻기는 기본으로 기존 파이프라인을 본다. 에이전트 경로(GRAPH_RAG=1)는 아래 "그래프에 묻기(에이전트)" 묶음에서 따로 켠다.
process.env.GRAPH_RAG = "0";

/** B의 데이터에만 들어 있는 표지. 어떤 A용 프롬프트·응답에도 나오면 안 된다. */
const B_MARK = "ZQXBMARK";
/** A의 데이터 표지(테스트가 실제로 그래프를 프롬프트에 넣는지 확인용). */
const A_MARK = "ALPHAMARK";

const state = vi.hoisted(() => ({
  afterQueue: [] as (() => Promise<void> | void)[],
  user: null as { id: string; email: string; name: string | null } | null,
  graphs: new Map<string, { nodes: unknown[]; edges: unknown[] }>(),
  calls: [] as { userId: string | null; task: string | undefined; text: string }[],
}));

vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => state.afterQueue.push(fn) }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));
vi.mock("@/lib/providers/options", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers/options")>()),
  resolveRequestedProvider: async () => "anthropic",
}));

// 메모리 그래프 저장소: 실제 서비스처럼 userId별로 나누고(plan.ts 검증), 읽은 그래프에 소유자 표시를 단다.
vi.mock("@/lib/graph/service", async () => {
  const { planGraphOps } = await import("@/lib/graph/plan");
  const { edgeId } = await import("@/lib/domain/graph");
  const { markGraphOwner } = await import("@/lib/graph/owner");
  const errors = await import("@/lib/graph/errors");
  const text = await import("@/lib/graph/text");
  let seq = 0;
  type G = { nodes: CareerGraph["nodes"]; edges: CareerGraph["edges"] };
  const get = (u: string): G => (state.graphs.get(u) as G | undefined) ?? { nodes: [], edges: [] };
  return {
    ...errors,
    graphToText: text.graphToText,
    graphEnabled: () => true,
    getCareerGraph: async (userId: string, opts: { personName?: string | null } = {}): Promise<CareerGraph> =>
      markGraphOwner<CareerGraph>({ person: { id: "me", name: opts.personName ?? null }, ...structuredClone(get(userId)) }, userId),
    applyGraphOps: async (userId: string, ops: GraphOp[]): Promise<ApplyGraphOpsResult> => {
      const g = structuredClone(get(userId));
      const { steps, created } = planGraphOps(new Map(g.nodes.map((n) => [n.id, n.label as NodeLabel])), ops, () => `n${++seq}`);
      for (const s of steps) {
        if (s.kind === "create") g.nodes.push({ id: s.id, label: s.label, props: s.props, createdAt: 0, updatedAt: 0 } as GraphNode);
        if (s.kind === "update") {
          const n = g.nodes.find((x) => x.id === s.id)!;
          n.props = { ...n.props, ...s.props } as GraphNode["props"];
        }
        if (s.kind === "delete") {
          g.nodes = g.nodes.filter((x) => x.id !== s.id);
          g.edges = g.edges.filter((e) => e.from !== s.id && e.to !== s.id);
        }
        if (s.kind === "link") g.edges.push({ id: edgeId(s.type, s.from, s.to), type: s.type, from: s.from, to: s.to });
      }
      state.graphs.set(userId, g);
      return { created, applied: steps.length };
    },
    deleteNode: async () => false,
  };
});

// match-service는 graphEnabled를 client에서 직접 읽는다.
vi.mock("@/lib/graph/client", async (orig) => ({ ...(await orig<typeof import("@/lib/graph/client")>()), graphEnabled: () => true }));

// LLM: 결정적 가짜 + 받은 프롬프트 기록. 사용량을 매길 사용자(usage.userId)도 함께 남긴다.
vi.mock("@/lib/llm", async (orig) => {
  const { FakeLlmClient } = await import("@/test/fake-llm");
  type Req = Parameters<InstanceType<typeof FakeLlmClient>["generate"]>[0];
  class RecordingLlmClient extends FakeLlmClient {
    constructor(private readonly owner: string | null) {
      super();
    }
    override async generate<T>(req: Req & { schema: import("zod").ZodType<T> }) {
      state.calls.push({ userId: this.owner, task: req.task, text: `${req.system}\n${req.user}` });
      return super.generate<T>(req);
    }
  }
  return {
    ...(await orig<typeof import("@/lib/llm")>()),
    createLlmClient: (_provider: string, usage?: { userId?: string | null }) => new RecordingLlmClient(usage?.userId ?? null),
  };
});

const A = { id: "ua", email: "ua@x.com", name: "에이" };
const B = { id: "ub", email: "ub@x.com", name: "비" };
const asUser = (u: typeof A) => {
  state.user = u;
};

/** 같은 id(p1·c1·s1·a1)를 쓰는 그래프. mark가 이름·속성에 들어간다. */
function graphOf(mark: string, extra: CareerGraph["nodes"] = []): { nodes: CareerGraph["nodes"]; edges: CareerGraph["edges"] } {
  const n = (id: string, label: NodeLabel, props: Record<string, unknown>) => ({ id, label, props, createdAt: 1, updatedAt: 1 }) as GraphNode;
  return {
    nodes: [
      n("c1", "Company", { name: `${mark}회사` }),
      n("p1", "Project", { name: `${mark}결제개선`, summary: `${mark} 정산 배치를 다시 만들었다`, myRole: `${mark}리드` }),
      n("s1", "Skill", { name: `${mark}Kotlin` }),
      n("a1", "Achievement", { summary: `${mark} 정산 시간 6시간→40분`, metric: "처리 시간", value: "40분" }),
      ...extra,
    ],
    edges: [
      { id: "WORKED_AT:me:c1", type: "WORKED_AT", from: "me", to: "c1" },
      { id: "WORKED_ON:me:p1", type: "WORKED_ON", from: "me", to: "p1" },
      { id: "PART_OF:p1:c1", type: "PART_OF", from: "p1", to: "c1" },
      { id: "USED_SKILL:p1:s1", type: "USED_SKILL", from: "p1", to: "s1" },
      { id: "ACHIEVED:p1:a1", type: "ACHIEVED", from: "p1", to: "a1" },
    ],
  };
}

let tdb: TestDb;
let routes: {
  graph: typeof import("@/app/api/graph/route");
  ops: typeof import("@/app/api/graph/ops/route");
  chatThreads: typeof import("@/app/api/graph/chat/threads/route");
  chatThread: typeof import("@/app/api/graph/chat/threads/[threadId]/route");
  chatMessages: typeof import("@/app/api/graph/chat/threads/[threadId]/messages/route");
  chatRetry: typeof import("@/app/api/graph/chat/threads/[threadId]/retry/route");
  chatImport: typeof import("@/app/api/graph/chat/threads/[threadId]/import/route");
  apply: typeof import("@/app/api/graph/chat/messages/[messageId]/apply/route");
  dismiss: typeof import("@/app/api/graph/chat/messages/[messageId]/dismiss/route");
  followups: typeof import("@/app/api/graph/chat/followups/route");
  followup: typeof import("@/app/api/graph/chat/followups/[followupId]/route");
  qaThreads: typeof import("@/app/api/graph/qa/threads/route");
  qaThread: typeof import("@/app/api/graph/qa/threads/[threadId]/route");
  qaMessages: typeof import("@/app/api/graph/qa/threads/[threadId]/messages/route");
  qaRetry: typeof import("@/app/api/graph/qa/threads/[threadId]/retry/route");
  match: typeof import("@/app/api/postings/[id]/match/route");
  skills: typeof import("@/app/api/insights/skills/route");
  draftJob: typeof import("@/app/api/resumes/drafts/[id]/route");
  draftRetry: typeof import("@/app/api/resumes/drafts/[id]/retry/route");
  portfolioGraph: typeof import("@/app/api/portfolios/graph/route");
  portfolioJob: typeof import("@/app/api/portfolios/graph/jobs/[id]/route");
  portfolioRetry: typeof import("@/app/api/portfolios/graph/jobs/[id]/retry/route");
};
let chat: typeof import("@/lib/chat/graph-chat");
let qa: typeof import("@/lib/chat/graph-qa");
let jobs: typeof import("@/lib/resumes/draft-jobs");
let BRIEF_BUILDER_VERSION: number;

beforeAll(async () => {
  tdb = await createTestDb();
  routes = {
    graph: await import("@/app/api/graph/route"),
    ops: await import("@/app/api/graph/ops/route"),
    chatThreads: await import("@/app/api/graph/chat/threads/route"),
    chatThread: await import("@/app/api/graph/chat/threads/[threadId]/route"),
    chatMessages: await import("@/app/api/graph/chat/threads/[threadId]/messages/route"),
    chatRetry: await import("@/app/api/graph/chat/threads/[threadId]/retry/route"),
    chatImport: await import("@/app/api/graph/chat/threads/[threadId]/import/route"),
    apply: await import("@/app/api/graph/chat/messages/[messageId]/apply/route"),
    dismiss: await import("@/app/api/graph/chat/messages/[messageId]/dismiss/route"),
    followups: await import("@/app/api/graph/chat/followups/route"),
    followup: await import("@/app/api/graph/chat/followups/[followupId]/route"),
    qaThreads: await import("@/app/api/graph/qa/threads/route"),
    qaThread: await import("@/app/api/graph/qa/threads/[threadId]/route"),
    qaMessages: await import("@/app/api/graph/qa/threads/[threadId]/messages/route"),
    qaRetry: await import("@/app/api/graph/qa/threads/[threadId]/retry/route"),
    match: await import("@/app/api/postings/[id]/match/route"),
    skills: await import("@/app/api/insights/skills/route"),
    draftJob: await import("@/app/api/resumes/drafts/[id]/route"),
    draftRetry: await import("@/app/api/resumes/drafts/[id]/retry/route"),
    portfolioGraph: await import("@/app/api/portfolios/graph/route"),
    portfolioJob: await import("@/app/api/portfolios/graph/jobs/[id]/route"),
    portfolioRetry: await import("@/app/api/portfolios/graph/jobs/[id]/retry/route"),
  };
  chat = await import("@/lib/chat/graph-chat");
  qa = await import("@/lib/chat/graph-qa");
  jobs = await import("@/lib/resumes/draft-jobs");
  ({ BRIEF_BUILDER_VERSION } = await import("@/lib/github/brief"));
});
afterAll(() => tdb.close());

/** B의 id들(시드가 채운다). */
const bIds = {
  chatThread: "b_chat",
  qaThread: "b_qa",
  message: "b_msg",
  followup: "b_fu_p1",
  followupFree: "b_fu_free",
  job: "b_job",
  posting: "b_post",
  portfolioJob: "b_pf_job",
};
/** A의 id들. */
const aIds = { followup: "a_fu_p1" };

async function seed() {
  for (const u of [A, B]) await tdb.prisma.user.create({ data: { id: u.id, email: u.email, name: u.name, status: "approved" } });
  state.graphs.set(A.id, graphOf(A_MARK));
  state.graphs.set(
    B.id,
    graphOf(B_MARK, [{ id: "pb_only", label: "Project", props: { name: `${B_MARK}비밀프로젝트` }, createdAt: 1, updatedAt: 1 } as GraphNode]),
  );

  // GitHub: 두 사람 모두 같은 저장소 id(4242)를 p1에 이어 두었다. B만 9999도 있다.
  for (const [u, mark] of [
    [A, A_MARK],
    [B, B_MARK],
  ] as const) {
    await tdb.prisma.githubAccount.create({ data: { id: `gh_${u.id}`, userId: u.id, githubUserId: `gh_${u.id}`, login: `login_${u.id}` } });
    await tdb.prisma.githubRepoSnapshot.create({
      data: {
        id: `snap_${u.id}`,
        userId: u.id,
        repoId: "4242",
        fullName: `${u.id}/career-app`,
        htmlUrl: `https://github.com/${u.id}/career-app`,
        data: {},
        brief: `저장소: ${u.id}/career-app\n설명: ${mark}저장소요약 커리어 앱\n언어 비율: TypeScript 80%`,
        builderVersion: BRIEF_BUILDER_VERSION,
        fetchedAt: new Date(),
        projectNodeId: "p1",
      },
    });
  }
  await tdb.prisma.githubRepoSnapshot.create({
    data: {
      id: "snap_b_only",
      userId: B.id,
      repoId: "9999",
      fullName: "ub/secret",
      htmlUrl: "https://github.com/ub/secret",
      data: {},
      brief: `저장소: ub/secret\n설명: ${B_MARK}비밀저장소`,
      builderVersion: BRIEF_BUILDER_VERSION,
      fetchedAt: new Date(),
    },
  });

  // 후속 질문: A·B 모두 p1에 열린 질문, B는 미지정 질문도.
  const fu = (id: string, userId: string, projectNodeId: string | null, text: string) =>
    tdb.prisma.graphFollowup.create({ data: { id, userId, projectNodeId, kind: "question", text, dedupeKey: text, status: "open" } });
  await fu(aIds.followup, A.id, "p1", `${A_MARK} 이 프로젝트에서 맡은 역할은?`);
  await fu(bIds.followup, B.id, "p1", `${B_MARK} 이 프로젝트의 팀 규모는?`);
  await fu(bIds.followupFree, B.id, null, `${B_MARK} 다른 경험도 있나요?`);

  // B의 대화: 그래프 채팅(p1 프로젝트 대화) — 사용자 메시지와 변경안 / 그래프에 묻기.
  const t0 = Date.now() - 60_000;
  await tdb.prisma.chatThread.create({ data: { id: bIds.chatThread, userId: B.id, kind: "graph", title: `${B_MARK}대화`, focusNodeId: "p1" } });
  await tdb.prisma.chatMessage.create({
    data: { id: "b_msg_user", threadId: bIds.chatThread, role: "user", content: `${B_MARK} 제 연봉은 9000이에요`, createdAt: new Date(t0) },
  });
  await tdb.prisma.chatMessage.create({
    data: { id: bIds.message, threadId: bIds.chatThread, role: "assistant", content: `${B_MARK} 변경안`, status: "proposed", createdAt: new Date(t0 + 1) },
  });
  await tdb.prisma.chatThread.create({ data: { id: bIds.qaThread, userId: B.id, kind: "graph-qa", title: `${B_MARK}질문` } });
  await tdb.prisma.chatMessage.create({
    data: { id: "b_qa_user", threadId: bIds.qaThread, role: "user", content: `${B_MARK} 내 성과는?`, createdAt: new Date(t0) },
  });

  await tdb.prisma.jobPosting.create({ data: { id: bIds.posting, userId: B.id, company: `${B_MARK}회사`, roleTitle: "백엔드" } });
  await tdb.prisma.resumeDraftJob.create({
    data: {
      id: bIds.job,
      userId: B.id,
      runId: "b_run",
      status: "running",
      label: `${B_MARK} 초안`,
      input: { kind: "general", templateId: "developer", source: { kind: "graph" }, provider: "anthropic" },
      provider: "anthropic",
    },
  });
  await tdb.prisma.portfolioDraftJob.create({
    data: {
      id: bIds.portfolioJob,
      userId: B.id,
      runId: "b_pf_run",
      status: "running",
      label: `${B_MARK} 포트폴리오`,
      input: { projectIds: ["p1"], provider: "anthropic" },
      provider: "anthropic",
    },
  });
}

beforeEach(async () => {
  await tdb.reset();
  state.afterQueue.length = 0;
  state.calls.length = 0;
  state.graphs.clear();
  await seed();
  asUser(A);
});

async function flushAfter() {
  while (state.afterQueue.length) await state.afterQueue.shift()!();
}

const headers = { origin: "http://localhost", host: "localhost" };
const post = (body?: unknown, method = "POST") =>
  new Request("http://localhost/x", {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const get = (url = "http://localhost/x") => new Request(url, { headers });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

/** LLM 호출이 있었고, 모두 A로 매겼으며, 어떤 프롬프트에도 B 표지가 없고, A 표지는 있다. */
function expectOnlyAData(tasks: string[]) {
  expect(state.calls.map((c) => c.task)).toEqual(expect.arrayContaining(tasks));
  for (const c of state.calls) {
    expect(c.userId).toBe(A.id);
    expect(c.text).not.toContain(B_MARK);
  }
  expect(state.calls.some((c) => c.text.includes(A_MARK))).toBe(true);
}

/** 응답 본문에 B 표지가 없다. */
async function expectNoBMark(res: Response) {
  expect(await res.clone().text()).not.toContain(B_MARK);
}

async function newChatThread(body: Record<string, unknown> = {}): Promise<string> {
  const res = await routes.chatThreads.POST(post(body));
  expect(res.status).toBeLessThan(300);
  return ((await res.json()) as { thread: { id: string } }).thread.id;
}

async function bUntouched() {
  const g = state.graphs.get(B.id)!;
  expect(g.nodes).toHaveLength(5);
  expect(JSON.stringify(g)).toContain(`${B_MARK}결제개선`);
  const fus = await tdb.prisma.graphFollowup.findMany({ where: { userId: B.id }, orderBy: { id: "asc" } });
  expect(fus.map((f) => [f.id, f.status, f.projectNodeId])).toEqual([
    [bIds.followupFree, "open", null],
    [bIds.followup, "open", "p1"],
  ]);
  const snap = await tdb.prisma.githubRepoSnapshot.findUniqueOrThrow({ where: { id: `snap_${B.id}` } });
  expect(snap.projectNodeId).toBe("p1");
  expect(await tdb.prisma.chatMessage.count({ where: { threadId: bIds.chatThread } })).toBe(2);
  expect((await tdb.prisma.chatMessage.findUniqueOrThrow({ where: { id: bIds.message } })).status).toBe("proposed");
  expect(await tdb.prisma.chatMessage.count({ where: { threadId: bIds.qaThread } })).toBe(1);
}

// ---------------------------------------------------------------------------
// ① LLM 프롬프트
// ---------------------------------------------------------------------------

describe("LLM 프롬프트에는 요청 사용자의 그래프만 들어간다", () => {
  it("그래프 채팅(일반): 같은 프로젝트 id를 언급해도 B의 그래프·후속 질문·대화가 프롬프트에 없다", async () => {
    const threadId = await newChatThread();
    const res = await routes.chatMessages.POST(post({ message: `${A_MARK}결제개선 프로젝트에 기간을 더하고 싶어요` }), p({ threadId }));
    expect(res.status).toBe(202);
    await flushAfter();
    expectOnlyAData(["graph-chat"]);
    // 대화 화면 응답에도 B 표지가 없다.
    await expectNoBMark(await routes.chatThread.GET(get(), p({ threadId })));
    await bUntouched();
  });

  it("그래프 채팅(프로젝트 p1): A의 후속 질문·저장소 요약만 들어가고, 같은 p1의 B 질문·저장소는 없다", async () => {
    const threadId = await newChatThread({ focusNodeId: "p1" });
    expect((await routes.chatMessages.POST(post({ message: "팀은 4명이었어요" }), p({ threadId }))).status).toBe(202);
    await flushAfter();
    expectOnlyAData(["graph-chat"]);
    const prompt = state.calls.find((c) => c.task === "graph-chat")!.text;
    expect(prompt).toContain(`${A_MARK}저장소요약`);
    expect(prompt).toContain(`${A_MARK} 이 프로젝트에서 맡은 역할은?`);
    await expectNoBMark(await routes.chatThread.GET(get(), p({ threadId })));
    await bUntouched();
  });

  it("후속 질문에 답하기: B의 질문 id로는 404(LLM 호출 없음), A의 질문으로는 A 데이터만", async () => {
    const threadId = await newChatThread({ focusNodeId: "p1" });
    const denied = await routes.chatMessages.POST(post({ message: "4명", followupId: bIds.followup }), p({ threadId }));
    expect(denied.status).toBe(404);
    await expectNoBMark(denied);
    await flushAfter();
    expect(state.calls).toHaveLength(0);

    expect((await routes.chatMessages.POST(post({ message: "리드였어요", followupId: aIds.followup }), p({ threadId }))).status).toBe(202);
    await flushAfter();
    expectOnlyAData(["graph-chat"]);
    await bUntouched();
  });

  it("이력서·포트폴리오 가져오기: B 데이터 없음", async () => {
    const threadId = await newChatThread();
    const form = new FormData();
    form.append("text", `회사: ㈜페이랩\n직무: 백엔드 개발자\n프로젝트: ${A_MARK} 결제 개선\n성과: 정산 처리 시간 6시간→40분\nGo와 Kafka로 정산 배치를 다시 만들었다.`);
    const res = await routes.chatImport.POST(new Request("http://localhost/x", { method: "POST", headers, body: form }), p({ threadId }));
    expect(res.status).toBe(202);
    await flushAfter();
    expectOnlyAData(["graph-import"]);
    await bUntouched();
  });

  it("GitHub 저장소 가져오기: 같은 저장소 id라도 A의 요약만, B만 가진 저장소 id면 LLM을 부르지 않는다", async () => {
    const repoMessage = async (repoId: string) => {
      const thread = await chat.createFocusedGraphThread(A.id, "p1");
      await tdb.prisma.chatMessage.create({
        data: {
          id: `a_repo_${repoId}`,
          threadId: thread.id,
          role: "user",
          content: "GitHub 저장소로 이 프로젝트 정리",
          data: { kind: "repo-import", repoId, fullName: "x/y", htmlUrl: "https://github.com/x/y", private: false, fetchedAt: Date.now(), chars: 10, briefSha256: "0" },
        },
      });
      return thread.id;
    };
    const t1 = await repoMessage("4242");
    await chat.runGraphChatReply(A.id, t1, "anthropic", A.name);
    expectOnlyAData(["graph-repo-import"]);
    expect(state.calls[0]!.text).toContain(`${A_MARK}저장소요약`);

    state.calls.length = 0;
    const t2 = await repoMessage("9999");
    const reply = await chat.runGraphChatReply(A.id, t2, "anthropic", A.name);
    expect(reply).toMatchObject({ role: "assistant", content: chat.REPO_MISSING_REPLY });
    expect(state.calls).toHaveLength(0);
    await bUntouched();
  });

  it("그래프에 묻기(리랭크 포함): B 데이터 없음", async () => {
    const res = await routes.qaThreads.POST(post({}));
    const threadId = ((await res.json()) as { thread: { id: string } }).thread.id;
    expect((await routes.qaMessages.POST(post({ message: "결제 개선 프로젝트에서 낸 성과와 쓴 기술은?" }), p({ threadId }))).status).toBe(202);
    await flushAfter();
    expectOnlyAData(["graph-qa"]);
    await expectNoBMark(await routes.qaThread.GET(get(), p({ threadId })));
    await bUntouched();
  });

  it("이력서 초안(경험 그래프 출처): A의 그래프만, B의 초안 작업은 A로 실행되지 않는다", async () => {
    await tdb.prisma.resumeDraftJob.create({
      data: {
        id: "a_job",
        userId: A.id,
        runId: "a_run",
        status: "running",
        label: "공용 이력서",
        input: { kind: "general", templateId: "developer", source: { kind: "graph" }, provider: "anthropic" },
        provider: "anthropic",
      },
    });
    await jobs.runResumeDraftJob(A.id, "a_job", "a_run", "anthropic");
    expectOnlyAData(["resume-draft"]);
    expect((await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: "a_job" } })).status).toBe("completed");

    state.calls.length = 0;
    await jobs.runResumeDraftJob(A.id, bIds.job, "b_run", "anthropic");
    expect(state.calls).toHaveLength(0);
    expect(await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: bIds.job } })).toMatchObject({ status: "running", resumeId: null });
    expect(await tdb.prisma.companyResume.count({ where: { userId: B.id } })).toBe(0);
  });
});

describe("포트폴리오(경험 그래프): A의 그래프·저장소만 들어간다", () => {
  it("같은 p1이어도 A의 그래프와 A의 저장소 링크만, B에만 있는 프로젝트 id는 400(LLM 호출 없음), B의 작업은 A로 실행되지 않는다", async () => {
    const res = await routes.portfolioGraph.POST(post({ projectIds: ["p1"] }));
    expect(res.status).toBe(202);
    await flushAfter();
    expectOnlyAData(["portfolio-draft"]);
    const pf = await tdb.prisma.portfolio.findFirstOrThrow({ where: { userId: A.id, kind: "graph" } });
    const { getObject } = await import("@/lib/storage");
    const text = (await getObject(pf.textKey!))!.toString("utf8");
    expect(text).toContain(A_MARK);
    expect(text).toContain("https://github.com/ua/career-app");
    expect(text).not.toContain(B_MARK);
    expect(text).not.toContain("ub/");

    state.calls.length = 0;
    const foreign = await routes.portfolioGraph.POST(post({ projectIds: ["pb_only"] }));
    expect(foreign.status).toBe(400);
    await expectNoBMark(foreign);
    const list = await routes.portfolioGraph.GET();
    await expectNoBMark(list);
    const { runGraphPortfolioJob } = await import("@/lib/portfolios/graph-jobs");
    await runGraphPortfolioJob(A.id, bIds.portfolioJob, "b_pf_run", "anthropic");
    await flushAfter();
    expect(state.calls).toHaveLength(0);
    expect(await tdb.prisma.portfolio.count({ where: { userId: B.id } })).toBe(0);
    expect((await tdb.prisma.portfolioDraftJob.findUniqueOrThrow({ where: { id: bIds.portfolioJob } })).status).toBe("running");
    await bUntouched();
  });
});

// ---------------------------------------------------------------------------
// ② API 라우트
// ---------------------------------------------------------------------------

describe("그래프 API: A는 B의 데이터를 읽거나 바꿀 수 없다", () => {
  it("GET /api/graph·스킬 갭: A의 그래프만", async () => {
    const res = await routes.graph.GET();
    expect(res.status).toBe(200);
    await expectNoBMark(res);
    expect(((await res.json()) as { graph: CareerGraph }).graph.nodes.map((n) => n.id).sort()).toEqual(["a1", "c1", "p1", "s1"]);
    const skills = await routes.skills.GET();
    await expectNoBMark(skills);
  });

  it("B의 그래프 채팅 스레드: 보기·이름 바꾸기·삭제·메시지·재시도·가져오기 모두 404", async () => {
    const t = p({ threadId: bIds.chatThread });
    const form = new FormData();
    form.append("text", "가져올 이력서 내용입니다. ".repeat(10));
    const responses = [
      await routes.chatThread.GET(get(), t),
      await routes.chatThread.PATCH(post({ title: "탈취" }, "PATCH"), t),
      await routes.chatThread.DELETE(post(undefined, "DELETE"), t),
      await routes.chatMessages.POST(post({ message: "내 질문" }), t),
      await routes.chatRetry.POST(post({}), t),
      await routes.chatImport.POST(new Request("http://localhost/x", { method: "POST", headers, body: form }), t),
    ];
    for (const r of responses) {
      expect(r.status).toBe(404);
      await expectNoBMark(r);
    }
    const list = await routes.chatThreads.GET();
    await expectNoBMark(list);
    await flushAfter();
    expect(state.calls).toHaveLength(0);
    expect((await tdb.prisma.chatThread.findUniqueOrThrow({ where: { id: bIds.chatThread } })).title).toBe(`${B_MARK}대화`);
    await bUntouched();
  });

  it("B의 변경안 메시지: 적용·거절 404, B 그래프는 그대로", async () => {
    const m = p({ messageId: bIds.message });
    for (const r of [await routes.apply.POST(post(), m), await routes.dismiss.POST(post(), m)]) {
      expect(r.status).toBe(404);
      await expectNoBMark(r);
    }
    await bUntouched();
  });

  it("B의 그래프에 묻기 스레드: 보기·이름 바꾸기·삭제·질문·재시도 404", async () => {
    const t = p({ threadId: bIds.qaThread });
    const responses = [
      await routes.qaThread.GET(get(), t),
      await routes.qaThread.PATCH(post({ title: "탈취" }, "PATCH"), t),
      await routes.qaThread.DELETE(post(undefined, "DELETE"), t),
      await routes.qaMessages.POST(post({ message: "질문" }), t),
      await routes.qaRetry.POST(post({}), t),
    ];
    for (const r of responses) {
      expect(r.status).toBe(404);
      await expectNoBMark(r);
    }
    await expectNoBMark(await routes.qaThreads.GET());
    await flushAfter();
    expect(state.calls).toHaveLength(0);
    await bUntouched();
  });

  it("후속 질문: 목록·개수는 A 것만, B의 질문 수정 404", async () => {
    for (const url of ["http://localhost/x?projectNodeId=p1&status=all", "http://localhost/x?unassigned=1&status=all", "http://localhost/x"]) {
      const res = await routes.followups.GET(get(url));
      expect(res.status).toBe(200);
      await expectNoBMark(res);
      expect(JSON.stringify(await res.json())).not.toContain(bIds.followup);
    }
    for (const body of [{ status: "skipped" }, { projectNodeId: null }]) {
      const r = await routes.followup.PATCH(post(body, "PATCH"), p({ followupId: bIds.followup }));
      expect(r.status).toBe(404);
      await expectNoBMark(r);
    }
    await bUntouched();
  });

  it("프로젝트 대화: B에만 있는 Project id로는 만들 수 없다(404)", async () => {
    for (const body of [{ focusNodeId: "pb_only" }, { focusNodeId: "pb_only", reuse: true }]) {
      const r = await routes.chatThreads.POST(post(body));
      expect(r.status).toBe(404);
      await expectNoBMark(r);
    }
  });

  it("직접 편집: 같은 노드 id(p1)를 A가 고치고 지워도 B의 노드·후속 질문·저장소 연결은 그대로", async () => {
    const upd = await routes.ops.POST(post({ ops: [{ op: "updateNode", id: "p1", label: "Project", props: { summary: "A가 고침" } }] }));
    expect(upd.status).toBe(200);
    await expectNoBMark(upd);
    const del = await routes.ops.POST(post({ ops: [{ op: "deleteNode", id: "p1" }] }));
    expect(del.status).toBe(200);
    await expectNoBMark(del);
    expect(state.graphs.get(A.id)!.nodes.map((n) => (n as GraphNode).id)).not.toContain("p1");
    // A 쪽 정리는 A 것만: A의 p1 질문은 미지정으로, A의 저장소 연결은 끊긴다.
    expect((await tdb.prisma.graphFollowup.findUniqueOrThrow({ where: { id: aIds.followup } })).projectNodeId).toBeNull();
    expect((await tdb.prisma.githubRepoSnapshot.findUniqueOrThrow({ where: { id: `snap_${A.id}` } })).projectNodeId).toBeNull();
    // B에만 있는 노드는 A가 고칠 수 없다(A 그래프에 없는 노드 → 400).
    const other = await routes.ops.POST(post({ ops: [{ op: "updateNode", id: "pb_only", label: "Project", props: { summary: "x" } }] }));
    expect(other.status).toBe(400);
    await expectNoBMark(other);
    await bUntouched();
  });

  it("B의 공고 대조·초안 작업: 404", async () => {
    const m = await routes.match.GET(get(), p({ id: bIds.posting }));
    expect(m.status).toBe(404);
    await expectNoBMark(m);
    const j = await routes.draftJob.GET(get(), p({ id: bIds.job }));
    expect(j.status).toBe(404);
    await expectNoBMark(j);
    const r = await routes.draftRetry.POST(post(), p({ id: bIds.job }));
    expect(r.status).toBe(404);
    await expectNoBMark(r);
    const pj = await routes.portfolioJob.GET(get(), p({ id: bIds.portfolioJob }));
    expect(pj.status).toBe(404);
    await expectNoBMark(pj);
    const pr = await routes.portfolioRetry.POST(post(), p({ id: bIds.portfolioJob }));
    expect(pr.status).toBe(404);
    await expectNoBMark(pr);
    await flushAfter();
    expect(state.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 그래프에 묻기(에이전트, src/lib/rag): 같은 id(p1)·같은 저장소를 쓰는 B가 있어도 A의 근거만
// ---------------------------------------------------------------------------

describe("그래프에 묻기(에이전트): 프롬프트·도구 결과·저장·조회에 B 데이터 없음", () => {
  beforeEach(async () => {
    process.env.GRAPH_RAG = "1";
    const { CONSENT_DOCS, REQUIRED_CONSENT_TYPES } = await import("@/lib/legal/consents");
    for (const u of [A, B]) {
      await tdb.prisma.userConsent.createMany({
        data: REQUIRED_CONSENT_TYPES.map((type) => ({ userId: u.id, type, version: CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
      });
    }
    const { syncSource } = await import("@/lib/rag/chunks/sync");
    for (const [u, id] of [
      [A.id, `snap_${A.id}`],
      [B.id, `snap_${B.id}`],
      [B.id, "snap_b_only"],
    ] as const) {
      await syncSource(u, "repo-brief", id);
    }
  });
  afterEach(() => {
    process.env.GRAPH_RAG = "0";
  });

  it("라우트 → after() → 에이전트 루프: A의 그래프·저장소 요약만", async () => {
    const res = await routes.qaThreads.POST(post({}));
    const threadId = ((await res.json()) as { thread: { id: string } }).thread.id;
    expect((await routes.qaMessages.POST(post({ message: "결제개선 프로젝트 저장소요약과 성과는?" }), p({ threadId }))).status).toBe(202);
    await flushAfter();
    expectOnlyAData(["graph-agent-step"]);
    const view = await routes.qaThread.GET(get(), p({ threadId }));
    await expectNoBMark(view);
    const body = (await view.json()) as { messages: { data: { kind: string; citations?: unknown[] } | null }[] };
    expect(body.messages.at(-1)!.data).toMatchObject({ kind: "graph-agent-answer" });
    expect(JSON.stringify(body)).not.toContain("sourceKey");
    await bUntouched();
  });

  it("그래프 로더가 B의 그래프를 돌려주면 차단(graph-agent-blocked), LLM 호출 없음", async () => {
    const service = await import("@/lib/graph/service");
    const thread = await qa.createQaThread(A.id);
    await qa.startQaMessage(A.id, thread.id, "성과는?");
    const reply = await qa.runQaReply(A.id, thread.id, "anthropic", A.name, {
      ...chat.defaultGraphChatDeps,
      getGraph: () => service.getCareerGraph(B.id, { personName: B.name }),
    });
    expect(reply).toMatchObject({ role: "assistant", status: "failed", data: { kind: "graph-agent-blocked" } });
    expect(reply!.content).not.toContain(B_MARK);
    expect(state.calls).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ③ 소유자 확인(graph/owner.ts)
// ---------------------------------------------------------------------------

describe("소유자 확인: 그래프 로더가 다른 사용자의 그래프를 돌려줘도 LLM에 넣지 않는다", () => {
  async function buggyDeps() {
    const service = await import("@/lib/graph/service");
    return {
      ...chat.defaultGraphChatDeps,
      // 버그 흉내: 요청 사용자와 상관없이 B의 그래프를 돌려준다.
      getGraph: () => service.getCareerGraph(B.id, { personName: B.name }),
    };
  }

  it("그래프 채팅: 실패로 남기고 LLM 호출 없음", async () => {
    const threadId = await newChatThread();
    await chat.startGraphChatMessage(A.id, threadId, "안녕하세요");
    const reply = await chat.runGraphChatReply(A.id, threadId, "anthropic", A.name, await buggyDeps());
    expect(reply).toMatchObject({ role: "assistant", status: "failed" });
    expect(reply!.content).not.toContain(B_MARK);
    expect(state.calls).toHaveLength(0);
  });

  it("그래프에 묻기: 실패로 남기고 LLM 호출 없음", async () => {
    const thread = await qa.createQaThread(A.id);
    await qa.startQaMessage(A.id, thread.id, "성과는?");
    const reply = await qa.runQaReply(A.id, thread.id, "anthropic", A.name, await buggyDeps());
    expect(reply).toMatchObject({ role: "assistant", status: "failed" });
    expect(reply!.content).not.toContain(B_MARK);
    expect(state.calls).toHaveLength(0);
  });

  it("assertGraphOwner: 표시가 같거나 없으면 통과, 다르면 GraphOwnerMismatchError", async () => {
    const { assertGraphOwner, markGraphOwner, GraphOwnerMismatchError, graphOwnerOf } = await import("@/lib/graph/owner");
    const g = markGraphOwner({ nodes: [] }, B.id);
    expect(graphOwnerOf(g)).toBe(B.id);
    expect(assertGraphOwner(g, B.id)).toBe(g);
    expect(() => assertGraphOwner(g, A.id)).toThrow(GraphOwnerMismatchError);
    expect(assertGraphOwner({ nodes: [] }, A.id)).toEqual({ nodes: [] });
    // 표시는 객체 밖에 있어 직렬화(API 응답)에 실리지 않는다.
    expect(JSON.stringify(g)).toBe('{"nodes":[]}');
  });
});
