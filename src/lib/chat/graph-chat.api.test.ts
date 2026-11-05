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

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["a", "b"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x", name: id === "a" ? "에이" : null } });
  threadsRoute = await import("@/app/api/graph/chat/threads/route");
  threadRoute = await import("@/app/api/graph/chat/threads/[threadId]/route");
  messagesRoute = await import("@/app/api/graph/chat/threads/[threadId]/messages/route");
  retryRoute = await import("@/app/api/graph/chat/threads/[threadId]/retry/route");
  applyRoute = await import("@/app/api/graph/chat/messages/[messageId]/apply/route");
  dismissRoute = await import("@/app/api/graph/chat/messages/[messageId]/dismiss/route");
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
});
