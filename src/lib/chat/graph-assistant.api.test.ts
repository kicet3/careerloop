/**
 * 이력서·포트폴리오 가져오기 라우트와 그래프에 묻기 라우트 테스트: 인증·after()·그래프 저장소를 가짜로 바꾸고,
 * LLM은 FakeLlmClient를 주입한다(graph-chat.api.test.ts와 같은 방식).
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
let chatThreadsRoute: typeof import("@/app/api/graph/chat/threads/route");
let chatThreadRoute: typeof import("@/app/api/graph/chat/threads/[threadId]/route");
let importRoute: typeof import("@/app/api/graph/chat/threads/[threadId]/import/route");
let applyRoute: typeof import("@/app/api/graph/chat/messages/[messageId]/apply/route");
let qaThreadsRoute: typeof import("@/app/api/graph/qa/threads/route");
let qaThreadRoute: typeof import("@/app/api/graph/qa/threads/[threadId]/route");
let qaMessagesRoute: typeof import("@/app/api/graph/qa/threads/[threadId]/messages/route");
let qaRetryRoute: typeof import("@/app/api/graph/qa/threads/[threadId]/retry/route");

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["a", "b"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x", name: id === "a" ? "에이" : null } });
  chatThreadsRoute = await import("@/app/api/graph/chat/threads/route");
  chatThreadRoute = await import("@/app/api/graph/chat/threads/[threadId]/route");
  importRoute = await import("@/app/api/graph/chat/threads/[threadId]/import/route");
  applyRoute = await import("@/app/api/graph/chat/messages/[messageId]/apply/route");
  qaThreadsRoute = await import("@/app/api/graph/qa/threads/route");
  qaThreadRoute = await import("@/app/api/graph/qa/threads/[threadId]/route");
  qaMessagesRoute = await import("@/app/api/graph/qa/threads/[threadId]/messages/route");
  qaRetryRoute = await import("@/app/api/graph/qa/threads/[threadId]/retry/route");
});
afterAll(() => tdb.close());
beforeEach(() => {
  currentUser = { id: "a", email: "a@x.com", name: "에이" };
  afterQueue.length = 0;
});

const headers = { origin: "http://localhost", host: "localhost" };
const post = (url: string, body?: unknown) =>
  new Request(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const postForm = (form: FormData) => new Request("http://localhost/x", { method: "POST", headers, body: form });
const p = <T extends Record<string, string>>(v: T) => ({ params: Promise.resolve(v) });
const get = () => new Request("http://localhost");

const RESUME = "회사: ㈜페이랩\n직무: 백엔드 개발자\n프로젝트: 결제 개선\n성과: 정산 처리 시간 6시간→40분\nGo와 Kafka로 정산 배치를 다시 만들었다.";

describe("이력서·포트폴리오 가져오기 API", () => {
  async function chatThread(): Promise<string> {
    const res = await chatThreadsRoute.POST(post("/x", {}));
    return ((await res.json()) as { thread: { id: string } }).thread.id;
  }

  it("파일 업로드(202) → 변경안 → 적용, 원본은 저장하지 않는다", async () => {
    const threadId = await chatThread();
    const form = new FormData();
    form.append("file", new File([RESUME], "cv.txt", { type: "text/plain" }));
    form.append("docKind", "resume");
    const res = await importRoute.POST(postForm(form), p({ threadId }));
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body.message.data).toMatchObject({ kind: "document-import", fileName: "cv.txt", text: "" });
    expect(afterQueue).toHaveLength(1);

    const row = await tdb.prisma.chatMessage.findFirst({ where: { threadId, role: "user" } });
    expect(row!.data).toMatchObject({ kind: "document-import", text: RESUME });
    expect(Object.keys(row!.data as object).sort()).toEqual(["chars", "docKind", "fileName", "kind", "text", "truncated", "warnings"]);

    await flushAfter();
    const view = await (await chatThreadRoute.GET(get(), p({ threadId }))).json();
    const proposal = view.messages[1];
    expect(proposal).toMatchObject({ status: "proposed", data: { kind: "graph-proposal", source: "document-import" } });
    expect(proposal.opLines.join("\n")).toContain("페이랩");
    const applied = await applyRoute.POST(post("/x"), p({ messageId: proposal.id }));
    expect((await applied.json()).message.status).toBe("applied");
    expect(graphs.get("a")!.nodes.map((n) => n.label)).toEqual(expect.arrayContaining(["Company", "Role", "Project", "Achievement", "Skill"]));
  });

  it("413(용량)·415(형식)·400(입력 없음·짧음)·404(남의 스레드)", async () => {
    const threadId = await chatThread();
    const big = new FormData();
    big.append("file", new File([new Uint8Array(33 * 1024 * 1024)], "big.pdf", { type: "application/pdf" }));
    expect((await importRoute.POST(postForm(big), p({ threadId }))).status).toBe(413);
    const doc = new FormData();
    doc.append("file", new File(["x".repeat(200)], "old.doc"));
    expect((await importRoute.POST(postForm(doc), p({ threadId }))).status).toBe(415);
    expect((await importRoute.POST(postForm(new FormData()), p({ threadId }))).status).toBe(400);
    const short = new FormData();
    short.append("text", "짧음");
    expect((await importRoute.POST(postForm(short), p({ threadId }))).status).toBe(400);
    currentUser = { id: "b", email: "b@x.com", name: null };
    const ok = new FormData();
    ok.append("text", RESUME);
    expect((await importRoute.POST(postForm(ok), p({ threadId }))).status).toBe(404);
    expect(afterQueue).toHaveLength(0);
  });
});

describe("그래프에 묻기 API", () => {
  async function qaThread(): Promise<string> {
    const res = await qaThreadsRoute.POST(post("/x", {}));
    expect(res.status).toBe(201);
    return ((await res.json()) as { thread: { id: string } }).thread.id;
  }

  it("질문(202) → 대기 409 → 답변(출처·경로) → 목록·이름 바꾸기·삭제", async () => {
    // 앞 테스트에서 적용한 그래프(페이랩·결제 개선…)에 묻는다.
    const threadId = await qaThread();
    const sent = await qaMessagesRoute.POST(post("/x", { message: "결제 개선 성과가 뭐였어?" }), p({ threadId }));
    expect(sent.status).toBe(202);
    expect((await qaMessagesRoute.POST(post("/x", { message: "또" }), p({ threadId }))).status).toBe(409);
    let view = await (await qaThreadRoute.GET(get(), p({ threadId }))).json();
    expect(view.pending).toBe(true);
    await flushAfter();
    view = await (await qaThreadRoute.GET(get(), p({ threadId }))).json();
    const answer = view.messages[1];
    expect(answer.data.kind).toBe("graph-answer");
    expect(answer.data.sources.length).toBeGreaterThan(0);
    const node = graphs.get("a")!.nodes.find((n) => n.id === answer.data.sources[0].nodeId);
    expect(node).toBeDefined();
    expect(answer.data.sources[0].pathText.startsWith("나 → ")).toBe(true);
    expect(answer.data.sources[0].exists).toBe(true);
    expect(answer.data.debug).toBeDefined(); // 개발 환경

    const list = await (await qaThreadsRoute.GET()).json();
    expect(list.threads.map((t: { id: string }) => t.id)).toContain(threadId);
    // 그래프 만들기 목록에는 섞이지 않는다
    const chatList = await (await chatThreadsRoute.GET()).json();
    expect(chatList.threads.map((t: { id: string }) => t.id)).not.toContain(threadId);

    const renamed = await qaThreadRoute.PATCH(
      new Request("http://localhost/x", { method: "PATCH", headers, body: JSON.stringify({ title: "성과 질문" }) }),
      p({ threadId }),
    );
    expect((await renamed.json()).thread.title).toBe("성과 질문");
    currentUser = { id: "b", email: "b@x.com", name: null };
    expect((await qaThreadRoute.GET(get(), p({ threadId }))).status).toBe(404);
    currentUser = { id: "a", email: "a@x.com", name: "에이" };
    expect((await qaThreadRoute.DELETE(new Request("http://localhost/x", { method: "DELETE", headers }), p({ threadId }))).status).toBe(204);
  });

  it("입력 검증: 빈 질문·1000자 초과 400, 재시도할 것이 없으면 409, 그래프 만들기 스레드로는 못 묻는다", async () => {
    const threadId = await qaThread();
    expect((await qaMessagesRoute.POST(post("/x", { message: " " }), p({ threadId }))).status).toBe(400);
    expect((await qaMessagesRoute.POST(post("/x", { message: "가".repeat(1001) }), p({ threadId }))).status).toBe(400);
    expect((await qaRetryRoute.POST(post("/x", {}), p({ threadId }))).status).toBe(409);
    const chat = await chatThreadsRoute.POST(post("/x", {}));
    const chatId = (await chat.json()).thread.id;
    expect((await qaMessagesRoute.POST(post("/x", { message: "성과?" }), p({ threadId: chatId }))).status).toBe(404);
  });
});
