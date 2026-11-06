/**
 * 후속 질문 저장·상태 전이(PGlite)와 그래프 채팅 연동: 변경안에서 쌓기, 프로젝트 대화의 현재 질문 프롬프트, 적용하면 answered,
 * 거절하면 열린 채로. 그래프·LLM은 가짜(deps).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { CHAT_TAGS, type GraphChatOutput, type GraphProposalData } from "@/lib/domain/chat";
import type { CareerGraph, GraphOp, LlmGraphOp } from "@/lib/domain/graph";
import { MAX_OPEN_FOLLOWUPS } from "@/lib/domain/followups";
import { qaGraph } from "@/lib/graph/__fixtures__/qa-graph";
import { PROJECT_STRUCTURE_ITEMS } from "@/lib/graph/project-structure";
import { FakeLlmClient } from "@/test/fake-llm";
import type { LlmClient } from "@/lib/llm/types";
import type { FollowupCandidate } from "./followup-extract";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));

process.env.NEO4J_URI ??= "bolt://unused"; // graphEnabled() — 그래프 저장소는 가짜(deps)

let gc: typeof import("./graph-chat");
let fu: typeof import("./followups");
let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  gc = await import("./graph-chat");
  fu = await import("./followups");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["u1", "u2"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
});

const blank: Omit<LlmGraphOp, "op"> = { ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };
const cand = (text: string, projectNodeId: string | null, extra: Partial<FollowupCandidate> = {}): FollowupCandidate => ({
  kind: "question",
  text,
  detail: null,
  targetItem: null,
  projectNodeId,
  projectRef: null,
  ...extra,
});

/** 출력을 정해 둔 LLM(없으면 FakeLlmClient). 프롬프트를 모은다. */
function deps(opts: { graph?: () => CareerGraph; output?: GraphChatOutput } = {}) {
  const prompts: { system: string; user: string }[] = [];
  const applied: GraphOp[][] = [];
  const graph = opts.graph ?? qaGraph;
  const d: import("./graph-chat").GraphChatDeps = {
    getGraph: async () => graph(),
    applyOps: async (_u, ops) => {
      applied.push(ops);
      const created = Object.fromEntries(ops.flatMap((o, i) => (o.op === "addNode" ? [[o.ref, `n${i}`]] : [])));
      return { created, applied: ops.length };
    },
    createClient: () => {
      const fake = new FakeLlmClient();
      return {
        name: "spy",
        generate: async (req) => {
          prompts.push({ system: req.system, user: req.user });
          if (opts.output) return { output: opts.output, usage: undefined } as never;
          return fake.generate(req);
        },
      } as LlmClient;
    },
    now: () => Date.now(),
  };
  return { deps: d, prompts, applied };
}

describe("후속 질문 저장", () => {
  it("같은 프로젝트의 열린 질문과 글이 같으면 쌓지 않고, 프로젝트별·미지정 수를 센다", async () => {
    const a = await fu.saveProposalFollowups("u1", {
      threadId: null,
      messageId: null,
      candidates: [cand("기간은 언제였나요?", "p1"), cand("기간은 언제였나요", "p1"), cand("기간은 언제였나요?", "p2"), cand("팀 규모는?", null)],
    });
    expect(a.map((f) => f.projectNodeId)).toEqual(["p1", "p2", null]);
    const again = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("기간은 언제 였나요 ?", "p1")] });
    expect(again).toEqual([]);
    expect(await fu.followupCounts("u1")).toEqual({ byProject: { p1: 1, p2: 1 }, unassigned: 1 });
    // 다른 사용자에게는 보이지 않는다
    expect(await fu.followupCounts("u2")).toEqual({ byProject: {}, unassigned: 0 });
    expect(await fu.getFollowup("u2", a[0]!.id)).toBeNull();
  });

  it("열린 질문 상한을 넘으면 더 쌓지 않는다", async () => {
    const many = Array.from({ length: MAX_OPEN_FOLLOWUPS + 5 }, (_, i) => cand(`질문 ${i}`, "p1"));
    const saved = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: many });
    expect(saved).toHaveLength(MAX_OPEN_FOLLOWUPS);
    expect(await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("하나 더", "p2")] })).toEqual([]);
  });

  it("상태 전이: 건너뛰기 → 다시 열기, 같은 열린 질문이 있으면 다시 열기는 409, 남의 질문은 404", async () => {
    const [q] = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("역할은?", "p1")] });
    const skipped = await fu.setFollowupStatus("u1", q!.id, "skipped");
    expect(skipped).toMatchObject({ status: "skipped" });
    expect(skipped.resolvedAt).not.toBeNull();
    expect((await fu.followupCounts("u1")).byProject).toEqual({});
    const reopened = await fu.setFollowupStatus("u1", q!.id, "open");
    expect(reopened).toMatchObject({ status: "open", resolvedAt: null });

    await fu.setFollowupStatus("u1", q!.id, "skipped");
    await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("역할은", "p1")] });
    await expect(fu.setFollowupStatus("u1", q!.id, "open")).rejects.toMatchObject({ status: 409 });
    await expect(fu.setFollowupStatus("u2", q!.id, "skipped")).rejects.toMatchObject({ status: 404 });
    const answered = await fu.setFollowupStatus("u1", q!.id, "answered");
    expect(answered.status).toBe("answered");
  });

  it("프로젝트 지정: 그래프에 있는 Project만, 옮길 곳에 같은 열린 질문이 있으면 409", async () => {
    const [x, y] = await fu.saveProposalFollowups("u1", {
      threadId: null,
      messageId: null,
      candidates: [cand(PROJECT_STRUCTURE_ITEMS[1]!.question, null), cand("기간은?", null)],
    });
    expect(x!.targetItem).toBeNull();
    await expect(fu.assignFollowupProject("u1", x!.id, "nope", qaGraph())).rejects.toMatchObject({ status: 404 });
    const moved = await fu.assignFollowupProject("u1", x!.id, "p_payment", qaGraph());
    // 체크리스트 질문이면 구조화 항목을 다시 단다
    expect(moved).toMatchObject({ projectNodeId: "p_payment", targetItem: "role" });
    expect(await fu.followupCounts("u1")).toEqual({ byProject: { p_payment: 1 }, unassigned: 1 });
    await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("기간은?", "p_wiki")] });
    await expect(fu.assignFollowupProject("u1", y!.id, "p_wiki", qaGraph())).rejects.toMatchObject({ status: 409 });
    expect(await fu.assignFollowupProject("u1", moved.id, null, null)).toMatchObject({ projectNodeId: null, targetItem: null });
  });
});

describe("그래프 채팅 연동", () => {
  it("일반 대화: 후속 질문·뺀 항목(기간 형식)을 쌓고, 뺀 항목 중 질문으로 바꾼 줄을 표시한다", async () => {
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "결제 개선 보강",
      followUpQuestions: ["결제 개선에서 팀은 몇 명이었나요?", "다른 경험도 있나요?"],
      ops: [
        { ...blank, op: "updateNode", id: "p_payment", label: "Project", props: [{ key: "learned", value: "이벤트 설계를 배웠다" }, { key: "endDate", value: "언젠가" }] },
        { ...blank, op: "updateNode", id: "nope", label: "Project", props: [{ key: "learned", value: "없는 노드" }] },
      ],
    };
    const { deps: d } = deps({ output });
    const t = await gc.createGraphThread("u1");
    await gc.startGraphChatMessage("u1", t.id, "결제 개선 이야기", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    const data = reply!.data as GraphProposalData;
    // 없는 노드 수정(기술적 사유)은 질문이 되지 않고, 기간 형식 오류만 질문이 된다
    expect(data.droppedOps!.length).toBe(2);
    expect(data.droppedFollowups).toEqual([data.droppedOps!.findIndex((x) => x.includes("endDate"))]);
    const items = await fu.listFollowups("u1");
    expect(items.map((f) => [f.kind, f.projectNodeId, f.sourceMessageId, f.threadId])).toEqual([
      ["question", "p_payment", reply!.id, t.id],
      ["question", "p_payment", reply!.id, t.id], // 이름은 없지만 변경안 전체가 결제 개선에 붙는다
      ["dropped", "p_payment", reply!.id, t.id],
    ]);
    expect(items[2]!.text).toContain("종료 시점");
    // 화면: 일반 대화는 프로젝트 미지정 질문만
    expect((await gc.getGraphThreadView("u1", t.id, null, d)).followups).toEqual([]);
  });

  it("프로젝트 대화: 현재 질문을 프롬프트에 넣고, 적용하면 answered, 거절하면 열린 채로", async () => {
    const { deps: d, prompts } = deps();
    const t = await gc.createFocusedGraphThread("u1", "p_wiki", d);
    const [q1, q2] = await fu.saveProposalFollowups("u1", {
      threadId: t.id,
      messageId: null,
      candidates: [cand("검색 품질은 어떻게 쟀나요?", "p_wiki"), cand("팀은 몇 명이었나요?", "p_wiki")],
    });
    // 남의 질문·다른 프로젝트의 질문으로는 보낼 수 없다
    const [other] = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("기간은?", "p_payment")] });
    await expect(gc.startGraphChatMessage("u2", t.id, "x", d, { followupId: q1!.id })).rejects.toMatchObject({ status: 404 });
    await expect(gc.startGraphChatMessage("u1", t.id, "x", d, { followupId: other!.id })).rejects.toMatchObject({ status: 400 });
    await expect(gc.startGraphChatMessage("u1", t.id, "x", d, { followupId: "nope" })).rejects.toMatchObject({ status: 404 });

    const msg = await gc.startGraphChatMessage("u1", t.id, "검색 결과 클릭률을 Python으로 집계했어요", d, { followupId: q1!.id });
    expect(msg.data).toMatchObject({ kind: "followup-answer", followupId: q1!.id, question: q1!.text });
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    const block = prompts[0]!.user.slice(prompts[0]!.user.indexOf(`<${CHAT_TAGS.followupQuestions}>`));
    expect(block).toContain(`지금 답하는 질문: ${q1!.text}`);
    expect(block).toContain(`1. ${q2!.text}`);
    expect(prompts[0]!.system).toContain("P6.");
    const data = reply!.data as GraphProposalData;
    expect(data.followupId).toBe(q1!.id);
    // 가짜 LLM은 남은 첫 질문을 그대로 묻는다 → 같은 질문이라 새로 쌓이지 않는다
    expect(data.followUpQuestions).toEqual([q2!.text]);

    let view = await gc.getGraphThreadView("u1", t.id, null, d);
    expect(view.followups.map((f) => f.id)).toEqual([q1!.id, q2!.id]);
    expect(view.messages[0]!.data).toMatchObject({ kind: "followup-answer" });

    await gc.applyGraphProposal("u1", reply!.id, d);
    expect((await fu.getFollowup("u1", q1!.id))!.status).toBe("answered");

    // 두 번째 질문에 답한 변경안을 거절하면 질문은 열린 채로
    await gc.startGraphChatMessage("u1", t.id, "팀은 4명이었고 Elasticsearch를 썼어요", d, { followupId: q2!.id });
    const second = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    await gc.dismissGraphProposal("u1", second!.id);
    expect((await fu.getFollowup("u1", q2!.id))!.status).toBe("open");
    // 이미 답한 질문으로는 다시 보낼 수 없다(다시 열어야 한다)
    await expect(gc.startGraphChatMessage("u1", t.id, "x", d, { followupId: q1!.id })).rejects.toMatchObject({ status: 409 });
    view = await gc.getGraphThreadView("u1", t.id, null, d);
    expect(view.followups.map((f) => f.id)).not.toContain(q1!.id);
  });

  it("새 Project에 귀속한 질문은 적용하면 실제 id로 바뀌고, 목표 구조화 항목이 완료되면 자동으로 answered", async () => {
    const empty: CareerGraph = { person: { id: "me", name: null }, nodes: [], edges: [] };
    // 적용 뒤 그래프: 가짜 applyOps는 new:p → n0. 역할이 이미 채워진 것으로 둔다(자동 해결 확인).
    const after: CareerGraph = {
      person: { id: "me", name: null },
      nodes: [{ id: "n0", label: "Project", props: { name: "추천 서비스", myRole: "백엔드" }, createdAt: 0, updatedAt: 0 } as CareerGraph["nodes"][number]],
      edges: [{ id: "WORKED_ON:me:n0", type: "WORKED_ON", from: "me", to: "n0" }],
    };
    const output: GraphChatOutput = {
      reply: "프로젝트를 만들었어요",
      summary: "추천 서비스 추가",
      followUpQuestions: [PROJECT_STRUCTURE_ITEMS.find((x) => x.id === "role")!.question],
      ops: [
        { ...blank, op: "addNode", ref: "new:p", label: "Project", props: [{ key: "name", value: "추천 서비스" }] },
        { ...blank, op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
      ],
    };
    const { deps: d, applied } = deps({ graph: () => (applied.length > 0 ? after : empty), output });
    const t = await gc.createGraphThread("u1");
    await gc.startGraphChatMessage("u1", t.id, "추천 서비스를 만들었어요", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    // 적용 전에는 목록·수에 보이지 않는다(프로젝트가 아직 없다)
    expect(await fu.followupCounts("u1")).toEqual({ byProject: {}, unassigned: 0 });
    await gc.applyGraphProposal("u1", reply!.id, d);
    const [item] = await fu.listFollowups("u1");
    expect(item).toMatchObject({ projectNodeId: "n0", targetItem: "role", status: "answered" });
  });

  it("문서 가져오기: 문서에 없는 항목을 질문으로 쌓는다", async () => {
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "가져오기",
      followUpQuestions: [],
      ops: [
        { ...blank, op: "addNode", ref: "new:a", label: "Achievement", props: [{ key: "summary", value: "매출 300% 증가" }] },
        { ...blank, op: "addEdge", type: "ACHIEVED", from: "p_payment", to: "new:a" },
      ],
    };
    const p = gc.proposalFromOutput(output, qaGraph(), { sourceText: "결제 개선 프로젝트에서 정산 배치를 개선했습니다.", maxOps: 150 });
    expect(p.followups).toHaveLength(1);
    expect(p.followups[0]).toMatchObject({ kind: "dropped", projectNodeId: "p_payment", targetItem: null });
    expect(p.data.droppedFollowups).toEqual([p.data.droppedOps!.findIndex((x) => x.includes("문서에서 찾지 못한"))]);
  });
});

describe("후속 질문 정리(적용·거절·삭제)", () => {
  const withProps = (g: CareerGraph, id: string, props: Record<string, unknown>): CareerGraph => ({
    ...g,
    nodes: g.nodes.map((n) => (n.id === id ? ({ ...n, props: { ...n.props, ...props } } as typeof n) : n)),
  });

  it("뺀 성과 질문은 같은 적용으로 '성과' 항목이 완료돼도 열린 채로 남는다", async () => {
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "가져오기",
      followUpQuestions: [],
      ops: [
        { ...blank, op: "addNode", ref: "new:a", label: "Achievement", props: [{ key: "summary", value: "정산 시간 40분으로 단축" }, { key: "value", value: "40분" }] },
        { ...blank, op: "addEdge", type: "ACHIEVED", from: "p_shop", to: "new:a" },
        { ...blank, op: "addNode", ref: "new:b", label: "Achievement", props: [{ key: "summary", value: "처리 속도 3배" }] },
        { ...blank, op: "addEdge", type: "ACHIEVED", from: "p_shop", to: "new:b" },
      ],
    };
    const p = gc.proposalFromOutput(output, qaGraph(), { sourceText: "쇼핑몰 프론트 리뉴얼에서 정산 시간을 40분으로 단축했습니다.", maxOps: 150 });
    const dropped = p.followups.filter((c) => c.kind === "dropped");
    expect(dropped.length).toBeGreaterThan(0);
    expect(dropped.every((c) => c.targetItem === null)).toBe(true);
    const saved = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: p.followups });
    const resolved = await fu.onProposalApplied("u1", { messageId: "m1", created: {}, touchedNodeIds: ["p_shop"], loadGraph: async () => qaGraph() });
    expect(resolved).toEqual([]);
    for (const f of saved) expect((await fu.getFollowup("u1", f.id))!.status).toBe("open");
  });

  it("체크리스트 질문의 자동 해결은 이 변경안이 건드린 프로젝트만, 이미 완료된 항목에는 달지 않는다", async () => {
    const roleQ = PROJECT_STRUCTURE_ITEMS.find((x) => x.id === "role")!.question;
    // p_payment는 역할이 이미 있다 → 그 질문에는 구조화 항목을 달지 않는다
    const ops: GraphOp[] = [{ op: "updateNode", id: "p_payment", label: "Project", props: { learned: "x" } }];
    const [c] = (await import("./followup-extract")).questionsFromFollowUps([roleQ], ops, { graph: qaGraph(), batch: ops }, "p_payment");
    expect(c).toMatchObject({ projectNodeId: "p_payment", targetItem: null });

    const after = withProps(withProps(qaGraph(), "p_wiki", { myRole: "검색 개발" }), "p_dashboard", { teamSize: 3 });
    const [wiki, dash] = await fu.saveProposalFollowups("u1", {
      threadId: null,
      messageId: null,
      candidates: [cand(roleQ, "p_wiki", { targetItem: "role" }), cand(roleQ, "p_dashboard", { targetItem: "role" })],
    });
    const resolved = await fu.onProposalApplied("u1", { messageId: "m2", created: {}, touchedNodeIds: ["p_wiki"], loadGraph: async () => after });
    expect(resolved).toEqual([wiki!.id]);
    expect((await fu.getFollowup("u1", dash!.id))!.status).toBe("open");
  });

  it("적용 때 중복이 합쳐지면 '후속 질문에 추가' 번호도 그만큼 민다", async () => {
    let graph = qaGraph();
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "결제 개선 보강",
      followUpQuestions: [],
      ops: [
        { ...blank, op: "updateNode", id: "p_payment", label: "Project", props: [{ key: "learned", value: "배웠다" }, { key: "endDate", value: "언젠가" }] },
        { ...blank, op: "addNode", ref: "new:s", label: "Skill", props: [{ key: "name", value: "Zig" }] },
        { ...blank, op: "addEdge", type: "USED_SKILL", from: "p_payment", to: "new:s" },
      ],
    };
    const { deps: d } = deps({ graph: () => graph, output });
    const t = await gc.createGraphThread("u1");
    await gc.startGraphChatMessage("u1", t.id, "결제 개선", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    const before = reply!.data as GraphProposalData;
    expect(before.droppedFollowups).toHaveLength(1);
    // 제안 뒤 다른 변경안이 Zig를 먼저 만들었다
    graph = { ...qaGraph(), nodes: [...qaGraph().nodes, { id: "s_zig", label: "Skill", props: { name: "Zig" }, createdAt: 0, updatedAt: 0 } as CareerGraph["nodes"][number]] };
    const { message } = await gc.applyGraphProposal("u1", reply!.id, d);
    const data = message.data as GraphProposalData;
    expect(data.droppedOps!.length).toBe(before.droppedOps!.length + 1);
    expect(data.droppedFollowups).toHaveLength(1);
    expect(data.droppedOps![data.droppedFollowups![0]!]).toContain("endDate");
  });

  it("새 Project를 만드는 변경안을 거절하면 그 Project에 귀속한 질문은 미지정으로 보이고, 숨은 질문은 상한에 세지 않는다", async () => {
    const output: GraphChatOutput = {
      reply: "프로젝트를 만들었어요",
      summary: "추천 서비스 추가",
      followUpQuestions: ["추천 서비스의 기간은 언제였나요?"],
      ops: [
        { ...blank, op: "addNode", ref: "new:p", label: "Project", props: [{ key: "name", value: "추천 서비스" }] },
        { ...blank, op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
      ],
    };
    const { deps: d } = deps({ output });
    const t = await gc.createGraphThread("u1");
    await gc.startGraphChatMessage("u1", t.id, "추천 서비스", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    expect(await fu.listFollowups("u1")).toEqual([]);
    // 숨은(ref) 질문은 열린 질문 상한을 깎지 않는다
    const many = Array.from({ length: MAX_OPEN_FOLLOWUPS }, (_, i) => cand(`질문 ${i}번`, "p1"));
    expect(await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: many })).toHaveLength(MAX_OPEN_FOLLOWUPS);
    await tdb.prisma.graphFollowup.deleteMany({ where: { userId: "u1", projectNodeId: "p1" } });

    await gc.dismissGraphProposal("u1", reply!.id);
    const items = await fu.listFollowups("u1", { projectNodeId: null });
    expect(items.map((f) => [f.text, f.status])).toEqual([["추천 서비스의 기간은 언제였나요?", "open"]]);
  });

  it("적용 직전 새 Project가 기존 Project로 합쳐지면 그 id로 귀속한다", async () => {
    let graph: CareerGraph = { person: { id: "me", name: null }, nodes: [], edges: [] };
    const output: GraphChatOutput = {
      reply: "프로젝트를 만들었어요",
      summary: "추천 서비스 추가",
      followUpQuestions: ["추천 서비스의 기간은 언제였나요?"],
      ops: [
        { ...blank, op: "addNode", ref: "new:p", label: "Project", props: [{ key: "name", value: "추천 서비스" }] },
        { ...blank, op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
      ],
    };
    const { deps: d } = deps({ graph: () => graph, output });
    const t = await gc.createGraphThread("u1");
    await gc.startGraphChatMessage("u1", t.id, "추천 서비스", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    graph = {
      person: { id: "me", name: null },
      nodes: [{ id: "p_rec", label: "Project", props: { name: "추천 서비스" }, createdAt: 0, updatedAt: 0 } as CareerGraph["nodes"][number]],
      edges: [],
    };
    await gc.applyGraphProposal("u1", reply!.id, d);
    expect((await fu.listFollowups("u1")).map((f) => f.projectNodeId)).toEqual(["p_rec"]);
  });

  it("Project를 지우면 그 프로젝트의 질문은 미지정으로 옮긴다(미지정에 같은 열린 질문이 있으면 건너뜀)", async () => {
    const [a, b] = await fu.saveProposalFollowups("u1", {
      threadId: null,
      messageId: null,
      candidates: [cand("기간은 언제였나요?", "p_wiki"), cand("팀은 몇 명이었나요?", "p_wiki")],
    });
    const [u] = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("팀은 몇 명이었나요?", null)] });
    await fu.onProposalApplied("u1", { messageId: "m3", created: {}, deletedNodeIds: ["p_wiki"] });
    expect(await fu.getFollowup("u1", a!.id)).toMatchObject({ projectNodeId: null, status: "open" });
    expect(await fu.getFollowup("u1", b!.id)).toMatchObject({ projectNodeId: null, status: "skipped" });
    expect((await fu.getFollowup("u1", u!.id))!.status).toBe("open");
    expect(await fu.followupCounts("u1")).toEqual({ byProject: {}, unassigned: 2 });
    // 그래프 직접 편집 경로도 같은 함수를 쓴다
    const [c] = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("성과는?", "p_shop")] });
    await fu.releaseDeletedProjectFollowups("u2", ["p_shop"]);
    expect((await fu.getFollowup("u1", c!.id))!.projectNodeId).toBe("p_shop");
    await fu.releaseDeletedProjectFollowups("u1", ["p_shop"]);
    expect((await fu.getFollowup("u1", c!.id))!.projectNodeId).toBeNull();
  });

  it("프로젝트 대화: 이 대화에서 이미 답으로 보낸 질문은 '남은 후속 질문'에 다시 넣지 않는다", async () => {
    const t0 = await gc.createFocusedGraphThread("u1", "p_wiki", deps().deps);
    const [q1, q2, q3] = await fu.saveProposalFollowups("u1", {
      threadId: t0.id,
      messageId: null,
      candidates: [cand("검색 품질은 어떻게 쟀나요?", "p_wiki"), cand("팀은 몇 명이었나요?", "p_wiki"), cand("기간은?", "p_wiki")],
    });
    const { deps: d, prompts } = deps({ output: { reply: "알겠어요", summary: "", followUpQuestions: [], ops: [] } });
    await gc.startGraphChatMessage("u1", t0.id, "모르겠어요", d, { followupId: q1!.id });
    await gc.runGraphChatReply("u1", t0.id, "anthropic", null, d);
    expect((await fu.getFollowup("u1", q1!.id))!.status).toBe("open");
    await gc.startGraphChatMessage("u1", t0.id, "4명이었어요", d, { followupId: q2!.id });
    await gc.runGraphChatReply("u1", t0.id, "anthropic", null, d);
    // 남은 후속 질문 블록만 본다(열린 질문 전체 표 <open_followups>에는 q1도 있다 — 답했는지 판정용).
    const user = prompts[1]!.user;
    const block = user.slice(user.indexOf(`<${CHAT_TAGS.followupQuestions}>`), user.indexOf(`</${CHAT_TAGS.followupQuestions}>`));
    expect(block).toContain(`지금 답하는 질문: ${q2!.text}`);
    expect(block).toContain(`1. ${q3!.text}`);
    expect(block).not.toContain(q1!.text);
    // 시스템 프롬프트는 턴마다 같다(프롬프트 캐시)
    expect(prompts[1]!.system).toBe(prompts[0]!.system);
  });

  it("일반 대화: 후속 질문에 답해도 시스템 프롬프트는 그대로이고 안내는 구분자 뒤에 들어간다, 이력의 질문은 짧게 자른다", async () => {
    const base = { graph: qaGraph(), messages: [], latestMessage: "4명" };
    const plain = gc.buildGraphChatPrompt(base);
    const withCurrent = gc.buildGraphChatPrompt({ ...base, followups: { current: "팀은 몇 명이었나요?", rest: [] } });
    expect(withCurrent.system).toBe(plain.system);
    expect(withCurrent.user).toContain(gc.GRAPH_CHAT_FOLLOWUP_RULE);
    const longQ = "가".repeat(300);
    const conv = gc.conversationForPrompt([
      { id: "m", threadId: "t", role: "user", content: "답", data: { kind: "followup-answer", followupId: "f", question: longQ }, status: null, createdAt: 0 } as never,
      { id: "a", threadId: "t", role: "assistant", content: "알겠어요", data: null, status: null, createdAt: 1 } as never,
      { id: "n", threadId: "t", role: "user", content: "이번 메시지", data: null, status: null, createdAt: 2 } as never,
    ]);
    expect(conv[0]!.content.length).toBeLessThan(100);
    expect(conv[0]!.content.endsWith("답")).toBe(true);
  });
});
