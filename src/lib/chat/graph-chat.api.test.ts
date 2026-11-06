/**
 * 그래프 채팅 API 라우트 테스트: 인증·after()·그래프 저장소를 가짜로 바꾸고, LLM은 FakeLlmClient를 주입한다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import type { ApplyGraphOpsResult, CareerGraph, GraphOp, NodeLabel } from "@/lib/domain/graph";

vi.mock("server-only", () => ({}));

// after(): 응답 뒤 실행 대신 모아 두었다가 테스트가 직접 돌린다.
const afterQueue: (() => Promise<void> | void)[] = [];
vi.mock("next/server", () => ({ after: (fn: () => Promise<void> | void) => afterQueue.push(fn) }));
async function flushAfter() {
  while (afterQueue.length) await afterQueue.shift()!();
}

let currentUser: { id: string; email: string; name: string | null } | null = null;
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => currentUser ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: (req: Request) =>
    req.headers.get("origin") === "https://evil.example" ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null,
}));

// 메모리 그래프 저장소(실제 서비스와 같은 검증 규칙 plan.ts를 쓴다).
const graphs = new Map<string, { nodes: CareerGraph["nodes"]; edges: CareerGraph["edges"] }>();
vi.mock("@/lib/graph/service", async () => {
  const { planGraphOps } = await import("@/lib/graph/plan");
  const { edgeId } = await import("@/lib/domain/graph");
  const errors = await import("@/lib/graph/errors");
  const text = await import("@/lib/graph/text");
  let seq = 0;
  const get = (u: string) => graphs.get(u) ?? { nodes: [], edges: [] };
  return {
    ...errors,
    graphToText: text.graphToText,
    graphEnabled: () => true,
    getCareerGraph: async (userId: string, opts: { personName?: string | null } = {}): Promise<CareerGraph> => ({
      person: { id: "me", name: opts.personName ?? null },
      ...structuredClone(get(userId)),
    }),
    applyGraphOps: async (userId: string, ops: GraphOp[]): Promise<ApplyGraphOpsResult> => {
      const g = structuredClone(get(userId));
      const { steps, created } = planGraphOps(new Map(g.nodes.map((n) => [n.id, n.label as NodeLabel])), ops, () => `n${++seq}`);
      for (const s of steps) {
        if (s.kind === "create") g.nodes.push({ id: s.id, label: s.label, props: s.props, createdAt: 0, updatedAt: 0 } as CareerGraph["nodes"][number]);
        if (s.kind === "link") g.edges.push({ id: edgeId(s.type, s.from, s.to), type: s.type, from: s.from, to: s.to });
        if (s.kind === "update") {
          const n = g.nodes.find((x) => x.id === s.id);
          if (n) n.props = { ...n.props, ...s.props } as typeof n.props;
        }
      }
      graphs.set(userId, g);
      return { created, applied: steps.length };
    },
  };
});

// 엔진: API 키만 있는 서버로 보이게 하고(CLI 상태 확인 없음), 클라이언트는 결정적 가짜로 바꿔 실제 호출을 막는다.
process.env.ANTHROPIC_API_KEY = "test-key";
delete process.env.CLI_PROVIDERS;
vi.mock("@/lib/llm", async (importOriginal) => {
  const { FakeLlmClient } = await import("@/test/fake-llm");
  return { ...(await importOriginal<typeof import("@/lib/llm")>()), createLlmClient: () => new FakeLlmClient() };
});

let tdb: TestDb;
let threadsRoute: typeof import("@/app/api/graph/chat/threads/route");
let threadRoute: typeof import("@/app/api/graph/chat/threads/[threadId]/route");
let messagesRoute: typeof import("@/app/api/graph/chat/threads/[threadId]/messages/route");
let retryRoute: typeof import("@/app/api/graph/chat/threads/[threadId]/retry/route");
let applyRoute: typeof import("@/app/api/graph/chat/messages/[messageId]/apply/route");
let dismissRoute: typeof import("@/app/api/graph/chat/messages/[messageId]/dismiss/route");
let followupsRoute: typeof import("@/app/api/graph/chat/followups/route");
let followupRoute: typeof import("@/app/api/graph/chat/followups/[followupId]/route");

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["a", "b"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x", name: id === "a" ? "에이" : null } });
  threadsRoute = await import("@/app/api/graph/chat/threads/route");
  threadRoute = await import("@/app/api/graph/chat/threads/[threadId]/route");
  messagesRoute = await import("@/app/api/graph/chat/threads/[threadId]/messages/route");
  retryRoute = await import("@/app/api/graph/chat/threads/[threadId]/retry/route");
  applyRoute = await import("@/app/api/graph/chat/messages/[messageId]/apply/route");
  dismissRoute = await import("@/app/api/graph/chat/messages/[messageId]/dismiss/route");
  followupsRoute = await import("@/app/api/graph/chat/followups/route");
  followupRoute = await import("@/app/api/graph/chat/followups/[followupId]/route");
});
afterAll(() => tdb.close());
beforeEach(() => {
  currentUser = { id: "a", email: "a@x.com", name: "에이" };
  afterQueue.length = 0;
});

const post = (url: string, body?: unknown, headers: Record<string, string> = {}) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });

async function newThread(): Promise<string> {
  const res = await threadsRoute.POST(post("/api/graph/chat/threads", {}));
  expect(res.status).toBe(201);
  return ((await res.json()) as { thread: { id: string } }).thread.id;
}

describe("그래프 채팅 API", () => {
  it("인증·출처 검사", async () => {
    currentUser = null;
    expect((await threadsRoute.GET()).status).toBe(401);
    currentUser = { id: "a", email: "a@x.com", name: null };
    expect((await threadsRoute.POST(post("/api/graph/chat/threads", {}, { origin: "https://evil.example" }))).status).toBe(403);
  });

  it("스레드 생성 → 메시지(202) → 백그라운드 답변 → 적용 → 그래프 반영", async () => {
    const threadId = await newThread();
    const sent = await messagesRoute.POST(
      post(`/api/graph/chat/threads/${threadId}/messages`, { message: "교내 창업 동아리에서 Python으로 추천 서비스를 만들었어요" }),
      p({ threadId }),
    );
    expect(sent.status).toBe(202);

    // 답변 전: pending, 두 번째 메시지는 409
    let view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).json();
    expect(view.pending).toBe(true);
    expect((await messagesRoute.POST(post(`/x`, { message: "또" }), p({ threadId }))).status).toBe(409);

    await flushAfter();
    view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).json();
    expect(view.pending).toBe(false);
    expect(view.thread.title).toContain("교내 창업 동아리");
    const proposal = view.messages[1];
    expect(proposal).toMatchObject({ role: "assistant", status: "proposed", data: { kind: "graph-proposal" } });
    expect(proposal.opLines.some((l: string) => l.includes("Python"))).toBe(true);

    // 다른 사용자는 적용할 수 없다
    currentUser = { id: "b", email: "b@x.com", name: null };
    expect((await applyRoute.POST(post("/x"), p({ messageId: proposal.id }))).status).toBe(404);
    expect((await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).status).toBe(404);
    currentUser = { id: "a", email: "a@x.com", name: "에이" };

    const applied = await applyRoute.POST(post("/x"), p({ messageId: proposal.id }));
    expect(applied.status).toBe(200);
    const body = await applied.json();
    expect(body.message.status).toBe("applied");
    expect(Object.keys(body.result.created)).toContain("new:exp");
    expect(graphs.get("a")!.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(["Experience", "Skill"]));
    expect((await applyRoute.POST(post("/x"), p({ messageId: proposal.id }))).status).toBe(409);

    // 두 번째 대화: 같은 기술은 중복 노드를 만들지 않는다
    await messagesRoute.POST(post("/x", { message: "Python으로 사내 자동화 스크립트도 만들었어요" }), p({ threadId }));
    await flushAfter();
    view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).json();
    const second = view.messages.at(-1);
    expect(second.data.ops.filter((o: GraphOp) => o.op === "addNode" && o.label === "Skill")).toHaveLength(0);
    expect(second.data.droppedOps.join(" ")).toContain("이미 있어");
    expect((await dismissRoute.POST(post("/x"), p({ messageId: second.id }))).status).toBe(200);
  });

  it("입력 검증: 빈 메시지·너무 긴 메시지·알 수 없는 엔진·없는 스레드", async () => {
    const threadId = await newThread();
    const send = (body: unknown) => messagesRoute.POST(post("/x", body), p({ threadId }));
    expect((await send({ message: "   " })).status).toBe(400);
    expect((await send({ message: "가".repeat(4001) })).status).toBe(400);
    expect((await send({ message: "안녕", provider: "gpt-9" })).status).toBe(400);
    expect((await messagesRoute.POST(post("/x", { message: "안녕" }), p({ threadId: "nope" }))).status).toBe(404);
    const bad = new Request("http://localhost/x", { method: "POST", headers: { origin: "http://localhost", host: "localhost" }, body: "{not json" });
    expect((await messagesRoute.POST(bad, p({ threadId }))).status).toBe(400);
    expect(afterQueue).toHaveLength(0);
  });

  it("프로젝트 단위 대화: focusNodeId로 스레드를 만들고, 변경안은 그 프로젝트에 붙는다", async () => {
    graphs.set("a", {
      nodes: [{ id: "p1", label: "Project", props: { name: "결제 개선" }, createdAt: 0, updatedAt: 0 }],
      edges: [{ id: "WORKED_ON:me:p1", type: "WORKED_ON", from: "me", to: "p1" }],
    });
    expect((await threadsRoute.POST(post("/api/graph/chat/threads", { focusNodeId: "nope" }))).status).toBe(404);
    const created = await threadsRoute.POST(post("/api/graph/chat/threads", { focusNodeId: "p1" }));
    expect(created.status).toBe(201);
    const { thread } = (await created.json()) as { thread: { id: string; title: string; focusNodeId: string } };
    expect(thread).toMatchObject({ title: "결제 개선", focusNodeId: "p1" });
    const threadId = thread.id;
    // reuse=true: 그 프로젝트의 최근 대화를 돌려준다(200, created=false)
    const reused = await threadsRoute.POST(post("/api/graph/chat/threads", { focusNodeId: "p1", reuse: true }));
    expect(reused.status).toBe(200);
    expect(await reused.json()).toMatchObject({ created: false, thread: { id: threadId } });

    let view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).json();
    expect(view.focus).toMatchObject({ nodeId: "p1", exists: true, structure: { done: 0, total: 7, next: "background" } });

    await messagesRoute.POST(post("/x", { message: "Go와 Kafka로 정산 배치를 스트리밍으로 바꿨어요" }), p({ threadId }));
    await flushAfter();
    view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).json();
    const proposal = view.messages.at(-1);
    expect(proposal.status).toBe("proposed");
    expect(proposal.data.ops.every((o: GraphOp) => (o.op === "addEdge" ? o.from === "p1" : o.op === "updateNode" ? o.id === "p1" : true))).toBe(true);
    expect(proposal.data.followUpQuestions).toHaveLength(1);
    expect((await applyRoute.POST(post("/x"), p({ messageId: proposal.id }))).status).toBe(200);
    view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId }))).json();
    // 한 일 + 사용 기술이 채워졌다
    expect(view.focus.structure.done).toBe(2);
    graphs.delete("a");
  });

  it("다시 시도할 것이 없으면 409, 이름 바꾸기·삭제", async () => {
    const threadId = await newThread();
    expect((await retryRoute.POST(post("/x", {}), p({ threadId }))).status).toBe(409);
    const req = new Request("http://localhost/x", {
      method: "PATCH",
      headers: { origin: "http://localhost", host: "localhost" },
      body: JSON.stringify({ title: "  학부 시절  " }),
    });
    const renamed = await threadRoute.PATCH(req, p({ threadId }));
    expect((await renamed.json()).thread.title).toBe("학부 시절");
    const del = await threadRoute.DELETE(new Request("http://localhost/x", { method: "DELETE", headers: { origin: "http://localhost", host: "localhost" } }), p({ threadId }));
    expect(del.status).toBe(204);
    const list = await (await threadsRoute.GET()).json();
    expect(list.graphEnabled).toBe(true);
    expect(list.threads.some((t: { id: string }) => t.id === threadId)).toBe(false);
  });

  it("후속 질문 API: 쌓인 질문 수·목록, 상태·프로젝트 지정, 답으로 보내고 적용하면 answered, 인증·출처·소유권", async () => {
    graphs.set("a", {
      nodes: [{ id: "p1", label: "Project", props: { name: "결제 개선" }, createdAt: 0, updatedAt: 0 }],
      edges: [{ id: "WORKED_ON:me:p1", type: "WORKED_ON", from: "me", to: "p1" }],
    });
    const get = (q = "") => followupsRoute.GET(new Request(`http://localhost/api/graph/chat/followups${q}`));
    const patch = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      followupRoute.PATCH(
        new Request("http://localhost/x", {
          method: "PATCH",
          headers: { "content-type": "application/json", origin: "http://localhost", host: "localhost", ...headers },
          body: JSON.stringify(body),
        }),
        p({ followupId: id }),
      );

    await tdb.prisma.graphFollowup.deleteMany(); // 앞 테스트(프로젝트 대화)가 쌓은 질문
    // 일반 대화의 변경안(가짜 LLM: 경험 + 후속 질문 2개) → 프로젝트 미지정 질문 2개
    const threadId = await newThread();
    await messagesRoute.POST(post("/x", { message: "동아리에서 Python으로 추천 서비스를 만들었어요" }), p({ threadId }));
    await flushAfter();
    let res = await get("?unassigned=1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    let body = await res.json();
    expect(body.counts).toEqual({ byProject: {}, unassigned: 2 });
    expect(body.items).toHaveLength(2);
    const [q1, q2] = body.items as { id: string; text: string }[];
    // 수만 달라고 하면 items가 없다
    expect((await (await get()).json()).items).toBeUndefined();
    expect((await get("?status=bogus")).status).toBe(400);

    // 프로젝트 지정(없는 프로젝트는 404) → 프로젝트별 수
    expect((await patch(q1!.id, { projectNodeId: "nope" })).status).toBe(404);
    res = await patch(q1!.id, { projectNodeId: "p1" });
    expect(res.status).toBe(200);
    expect((await res.json()).counts).toEqual({ byProject: { p1: 1 }, unassigned: 1 });
    expect((await (await get("?projectNodeId=p1")).json()).items.map((f: { id: string }) => f.id)).toEqual([q1!.id]);
    // 건너뛰기 → 다시 열기
    expect((await (await patch(q2!.id, { status: "skipped" })).json()).followup.status).toBe("skipped");
    expect((await (await patch(q2!.id, { status: "open" })).json()).followup.status).toBe("open");
    expect((await patch(q2!.id, {})).status).toBe(400);
    expect((await patch(q2!.id, { status: "done" })).status).toBe(400);

    // 인증·출처·소유권
    expect((await patch(q2!.id, { status: "skipped" }, { origin: "https://evil.example" })).status).toBe(403);
    currentUser = { id: "b", email: "b@x.com", name: null };
    expect((await patch(q2!.id, { status: "skipped" })).status).toBe(404);
    expect((await (await get("?unassigned=1")).json()).items).toEqual([]);
    const otherThread = await newThread();
    expect((await messagesRoute.POST(post("/x", { message: "답", followupId: q1!.id }), p({ threadId: otherThread }))).status).toBe(404);
    currentUser = null;
    expect((await get()).status).toBe(401);
    expect((await patch(q2!.id, { status: "skipped" })).status).toBe(401);
    currentUser = { id: "a", email: "a@x.com", name: "에이" };

    // 프로젝트 대화에서 그 질문에 답한다 → 변경안 적용 → answered, 수가 줄어든다
    const opened = await threadsRoute.POST(post("/api/graph/chat/threads", { focusNodeId: "p1", reuse: true }));
    const focusThread = ((await opened.json()) as { thread: { id: string } }).thread.id;
    let view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId: focusThread }))).json();
    expect(view.followups.map((f: { id: string }) => f.id)).toEqual([q1!.id]);
    const sent = await messagesRoute.POST(post("/x", { message: "Go로 정산 배치를 다시 만들었어요", followupId: q1!.id }), p({ threadId: focusThread }));
    expect(sent.status).toBe(202);
    await flushAfter();
    view = await (await threadRoute.GET(new Request("http://localhost"), p({ threadId: focusThread }))).json();
    const proposal = view.messages.at(-1);
    expect(proposal.data.followupId).toBe(q1!.id);
    expect((await applyRoute.POST(post("/x"), p({ messageId: proposal.id }))).status).toBe(200);
    body = await (await get("?projectNodeId=p1&status=all")).json();
    expect(body.items.find((f: { id: string }) => f.id === q1!.id).status).toBe("answered");
    // 프로젝트 대화의 새 질문(체크리스트)이 쌓여 그 프로젝트의 열린 질문으로 센다
    expect(body.counts.byProject.p1).toBe(body.items.filter((f: { status: string }) => f.status === "open").length);
    graphs.delete("a");
  });
});
