/**
 * 프로젝트 단위 그래프 채팅: 스레드 생성(focusNodeId), 프롬프트(프로젝트 주변 그래프·구조화 체크리스트), 변경안 범위 검사,
 * 화면용 진행도. DB는 PGlite, 그래프·LLM은 가짜(deps).
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { CHAT_TAGS, type GraphChatOutput } from "@/lib/domain/chat";
import type { CareerGraph, GraphOp, LlmGraphOp } from "@/lib/domain/graph";
import { qaGraph } from "@/lib/graph/__fixtures__/qa-graph";
import { FakeLlmClient } from "@/test/fake-llm";
import { splitUserPrompt } from "@/lib/panel/prompts";
import type { LlmClient } from "@/lib/llm/types";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));

process.env.NEO4J_URI ??= "bolt://unused"; // graphEnabled() — 그래프 저장소는 가짜(deps)

let gc: typeof import("./graph-chat");
let store: typeof import("./store");
let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["u1", "u2", "u3", "u4"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  gc = await import("./graph-chat");
  store = await import("./store");
});
afterAll(() => tdb.close());

const blank: Omit<LlmGraphOp, "op"> = { ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };

function deps(overrides: Partial<import("./graph-chat").GraphChatDeps> & { graph?: () => CareerGraph } = {}) {
  const applied: GraphOp[][] = [];
  const prompts: { system: string; user: string }[] = [];
  const { graph = qaGraph, ...rest } = overrides;
  const d: import("./graph-chat").GraphChatDeps = {
    getGraph: async () => graph(),
    applyOps: async (_u, ops) => {
      applied.push(ops);
      return { created: {}, applied: ops.length };
    },
    createClient: () => {
      const fake = new FakeLlmClient();
      return {
        name: "spy",
        generate: (req) => {
          prompts.push({ system: req.system, user: req.user });
          return fake.generate(req);
        },
      } as LlmClient;
    },
    now: () => Date.now(),
    ...rest,
  };
  return { deps: d, applied, prompts };
}

describe("프로젝트 단위 대화 프롬프트", () => {
  it("구조화할 프로젝트·주변 그래프·체크리스트를 캐시 구분자 앞에 넣고, 시스템 프롬프트에 집중 규칙을 더한다", () => {
    const { system, user } = gc.buildGraphChatPrompt({ graph: qaGraph(), messages: [], latestMessage: "배운 점을 말할게요", focusProjectId: "p_payment" });
    expect(system).toContain(gc.GRAPH_CHAT_FOCUS_RULES);
    expect(system).toContain("질문은 한 번에 하나만");
    const [shared] = splitUserPrompt(user);
    const focus = shared.slice(shared.indexOf(`<${CHAT_TAGS.focusProject}>`), shared.indexOf(`</${CHAT_TAGS.focusProject}>`));
    expect(focus).toContain("구조화할 프로젝트: [p_payment] 결제 개선");
    expect(focus).toContain("[c_paylab] 페이랩");
    expect(focus).toContain("다음에 물을 항목: 배운 점");
    expect(focus).not.toContain("주문 대시보드");
    // 전체 그래프 요약(중복 방지용)은 그대로 있다
    expect(shared).toContain(`<${CHAT_TAGS.careerGraph}>`);
  });

  it("일반 대화나 없는 프로젝트면 집중 블록·규칙이 없다", () => {
    for (const focusProjectId of [null, "gone"]) {
      const { system, user } = gc.buildGraphChatPrompt({ graph: qaGraph(), messages: [], latestMessage: "x", focusProjectId });
      expect(system).toBe(gc.GRAPH_CHAT_SYSTEM);
      expect(user).not.toContain(`<${CHAT_TAGS.focusProject}>`);
    }
  });
});

describe("프로젝트 단위 변경안", () => {
  it("proposalFromOutput(focusNodeId): 프로젝트와 무관한 연산은 빼고 사유를 남긴다", () => {
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "배운 점",
      followUpQuestions: ["팀은 몇 명이었나요?"],
      ops: [
        { ...blank, op: "updateNode", id: "p_payment", label: "Project", props: [{ key: "learned", value: "이벤트 기반 설계의 장단점을 배웠다" }] },
        { ...blank, op: "updateNode", id: "p_dashboard", label: "Project", props: [{ key: "learned", value: "무관한 수정입니다" }] },
        { ...blank, op: "addNode", ref: "new:x", label: "Experience", props: [{ key: "title", value: "다른 경험" }] },
        { ...blank, op: "addEdge", type: "HAS_EXPERIENCE", from: "me", to: "new:x" },
      ],
    };
    const p = gc.proposalFromOutput(output, qaGraph(), { focusNodeId: "p_payment" });
    expect(p.status).toBe("proposed");
    expect(p.data.ops).toEqual([{ op: "updateNode", id: "p_payment", label: "Project", props: { learned: "이벤트 기반 설계의 장단점을 배웠다" } }]);
    expect(p.data.droppedOps!.filter((d) => d.includes("관련 없는") || d.includes("연결되지 않아"))).toHaveLength(3);
    // 일반 대화에서는 같은 출력이 모두 남는다
    expect(gc.proposalFromOutput(output, qaGraph()).data.ops).toHaveLength(4);
  });

  it("프로젝트 대화는 질문을 하나만 남기고, 인젝션 방어 규칙이 프로젝트 블록 태그를 데이터로 선언한다", () => {
    const output: GraphChatOutput = { reply: "네", summary: "", followUpQuestions: ["역할은?", "팀 규모는?", "기간은?"], ops: [] };
    expect(gc.proposalFromOutput(output, qaGraph(), { focusNodeId: "p_payment" }).data.followUpQuestions).toEqual(["역할은?"]);
    expect(gc.proposalFromOutput(output, qaGraph()).data.followUpQuestions).toHaveLength(3);
    expect(gc.GRAPH_CHAT_SYSTEM).toContain(`<${CHAT_TAGS.focusProject}>`);
  });
});

describe("프로젝트 단위 대화 서비스", () => {
  it("스레드 생성 → 메시지 → 프로젝트에 붙은 변경안 → 적용, 화면에 구조화 진행도", async () => {
    const { deps: d, applied, prompts } = deps();
    const t = await gc.createFocusedGraphThread("u1", "p_wiki", d);
    expect(t).toMatchObject({ kind: "graph", focusNodeId: "p_wiki", title: "사내 위키 검색" });
    expect((await gc.listGraphThreads("u1")).find((x) => x.id === t.id)?.focusNodeId).toBe("p_wiki");

    let view = await gc.getGraphThreadView("u1", t.id, null, d);
    expect(view.focus).toMatchObject({ nodeId: "p_wiki", exists: true, structure: { done: 4, total: 7, next: "role" } });

    await gc.startGraphChatMessage("u1", t.id, "검색 API는 FastAPI로 만들고 색인 파이프라인을 직접 짰어요", d);
    // 프로젝트 제목은 첫 메시지로 바뀌지 않는다
    expect((await store.getThread("u1", t.id))!.title).toBe("사내 위키 검색");
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    expect(prompts[0]!.user).toContain("구조화할 프로젝트: [p_wiki] 사내 위키 검색");
    expect(prompts[0]!.system).toContain(gc.GRAPH_CHAT_FOCUS_RULES);
    expect(reply!.status).toBe("proposed");
    const data = reply!.data as import("@/lib/domain/chat").GraphProposalData;
    expect(data.ops[0]).toMatchObject({ op: "updateNode", id: "p_wiki", label: "Project" });
    expect(data.ops.some((op) => op.op === "addEdge" && op.from === "p_wiki" && op.type === "USED_SKILL")).toBe(true);
    // 질문은 하나: 체크리스트의 다음 항목(내 역할)
    expect(data.followUpQuestions).toHaveLength(1);
    expect(data.followUpQuestions[0]).toContain("역할");

    await gc.applyGraphProposal("u1", reply!.id, d);
    expect(applied).toHaveLength(1);

    // 그래프가 바뀌면 진행도도 다시 계산된다(화면은 GRAPH_CHANGED_EVENT 뒤 다시 읽는다)
    const after = qaGraph();
    Object.assign(after.nodes.find((n) => n.id === "p_wiki")!.props, { myRole: "검색 백엔드" });
    view = await gc.getGraphThreadView("u1", t.id, null, deps({ graph: () => after }).deps);
    expect(view.focus!.structure).toMatchObject({ done: 5, next: "actions" });
  });

  it("openFocusedGraphThread: 그 프로젝트의 최근 대화를 다시 쓰고, 없을 때만 만든다(목록 50개 밖이어도)", async () => {
    const { deps: d } = deps();
    const first = await gc.openFocusedGraphThread("u3", "p_shop", d);
    expect(first).toMatchObject({ created: true, thread: { focusNodeId: "p_shop" } });
    // 그 뒤로 일반 대화가 50개 넘게 쌓여도 같은 프로젝트 대화를 찾는다
    for (let i = 0; i < 51; i++) await gc.createGraphThread("u3", `일반 ${i}`);
    expect((await gc.listGraphThreads("u3")).some((t) => t.id === first.thread.id)).toBe(false);
    const again = await gc.openFocusedGraphThread("u3", "p_shop", d);
    expect(again).toMatchObject({ created: false, thread: { id: first.thread.id } });
    // 다른 사용자·없는 프로젝트
    expect((await gc.openFocusedGraphThread("u4", "p_shop", d)).created).toBe(true);
    await expect(gc.openFocusedGraphThread("u3", "nope", d)).rejects.toMatchObject({ status: 404 });
  });

  it("없는 프로젝트·Project가 아닌 노드는 404, 남의 스레드는 404", async () => {
    const { deps: d } = deps();
    await expect(gc.createFocusedGraphThread("u1", "nope", d)).rejects.toMatchObject({ status: 404 });
    await expect(gc.createFocusedGraphThread("u1", "e_club", d)).rejects.toMatchObject({ status: 404 });
    const t = await gc.createFocusedGraphThread("u1", "p_payment", d);
    await expect(gc.getGraphThreadView("u2", t.id, null, d)).rejects.toMatchObject({ status: 404 });
  });

  it("프로젝트가 지워지면 LLM을 부르지 않고 안내를 남기고, 화면은 exists=false", async () => {
    const { deps: d, prompts } = deps();
    const t = await gc.createFocusedGraphThread("u1", "p_shop", d);
    const gone = deps({ graph: () => ({ ...qaGraph(), nodes: qaGraph().nodes.filter((n) => n.id !== "p_shop") }) });
    await gc.startGraphChatMessage("u1", t.id, "이어서 이야기할게요", gone.deps);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, gone.deps);
    expect(reply).toMatchObject({ content: gc.FOCUS_MISSING_REPLY, status: null });
    expect(prompts).toHaveLength(0);
    expect(gone.prompts).toHaveLength(0);
    expect((await gc.getGraphThreadView("u1", t.id, null, gone.deps)).focus).toMatchObject({ exists: false, structure: null });
    // 그래프를 읽지 못하면 알 수 없음(null)
    const down = deps({ getGraph: () => Promise.reject(new Error("down")) });
    expect((await gc.getGraphThreadView("u1", t.id, null, down.deps)).focus).toMatchObject({ exists: null });
  });

  it("프로젝트 대화에서는 문서 가져오기를 막는다", async () => {
    const t = await gc.createFocusedGraphThread("u1", "p_payment", deps().deps);
    await expect(
      gc.startGraphImportMessage("u1", t.id, { docKind: "resume", fileName: null, text: "이력서", truncated: false, warnings: [] }),
    ).rejects.toMatchObject({ status: 400 });
  });

  it("일반 대화는 focus가 없다", async () => {
    const t = await gc.createGraphThread("u1");
    expect(t.focusNodeId).toBeNull();
    expect((await gc.getGraphThreadView("u1", t.id, null, deps().deps)).focus).toBeUndefined();
  });
});
