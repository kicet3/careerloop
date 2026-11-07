/**
 * 후속 질문 중복 회귀(PGlite): 실제 사례 — '예약율 예측 솔루션' 프로젝트 대화에서 역할·기간·배운 점·측정 기준을 답했는데 표현만 바꾼
 * 질문이 다시 쌓이고 열린 채로 남아 다시 물었다. 그래프·LLM은 가짜(deps).
 * - 예전에 쌓인 중복은 목록·대화 화면을 열 때 정리된다(DB를 손으로 고치지 않아도).
 * - 답변의 새 질문은 이미 채운 것·이미 답한 것·열린 질문과 같은 것을 바꿔 묻지 않는다. 확인 대기 중인 변경안이 채우는 것도.
 * - 답하면 같은 것을 바꿔 묻는 열린 질문도 함께 answered. 적용하면 채운 주제의 질문이 answered.
 * - 다른 사용자의 질문은 건드리지 않는다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { CHAT_TAGS, type GraphChatOutput, type GraphProposalData } from "@/lib/domain/chat";
import type { CareerGraph, GraphOp, LlmGraphOp } from "@/lib/domain/graph";
import { MAX_OPEN_FOLLOWUPS_PER_PROJECT } from "@/lib/domain/followups";
import { reservationGraph } from "@/lib/graph/__fixtures__/reservation-graph";
import { extractTag } from "@/lib/panel/prompts";
import type { LlmClient, LlmRequest } from "@/lib/llm/types";
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

const PROD = {
  role1: "맡은 역할은 무엇이었나요? 혼자/함께?",
  role2: "맡으신 역할과 팀 규모는 어땠나요? (예: 2인 중 백엔드 담당)",
  period1: "진행한 기간과 사용한 기술을 알려 주세요",
  period1b: "진행한 기간과 사용한 기술은 무엇이었나요?",
  period2: "언제부터 언제까지 진행하셨나요?",
  period2b: "언제부터 언제까지 하셨어요?",
  learned1: "이 프로젝트에서 배운 점·아쉬운 점은 무엇인가요?",
  learned2: "돌아보면 아쉬웠던 점과 배운 점이 있나요?",
  learned3: "배운 점이나 아쉬운 점을 알려 주세요",
  metric1: "오차 약 3%는 어떤 기준으로 쟀나요?",
  metric2: "예측 오차 3%는 어떻게 측정한 값인가요?",
  metric3: "3% 오차는 무엇 대비로 계산했나요?",
  metric4: "오차 3%는 어떤 기준으로 측정하셨나요?",
};

const cand = (text: string, projectNodeId: string | null): FollowupCandidate => ({
  kind: "question",
  text,
  detail: null,
  targetItem: null,
  projectNodeId,
  projectRef: null,
});

/** 실제 사례처럼 이미 쌓인 행을 그대로 넣는다(저장 가리기를 거치지 않게 직접). */
async function seed(userId: string, rows: [string, "open" | "answered" | "skipped"][], projectNodeId = "n_res") {
  const base = Date.now() - 60_000;
  const out: string[] = [];
  for (const [i, [text, status]] of rows.entries()) {
    const id = `${userId}_f${i}`;
    await tdb.prisma.graphFollowup.create({
      data: {
        id,
        userId,
        projectNodeId,
        kind: "question",
        text,
        dedupeKey: `${text}#${i}`,
        status,
        createdAt: new Date(base + i * 1000),
        resolvedAt: status === "open" ? null : new Date(base + i * 1000),
      },
    });
    out.push(id);
  }
  return out;
}

const blank: Omit<LlmGraphOp, "op"> = { ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };

/** 차례대로 정해 둔 출력을 내는 LLM. 프롬프트를 모은다. */
function deps(opts: { graph?: () => CareerGraph; outputs: GraphChatOutput[] }) {
  const prompts: { system: string; user: string }[] = [];
  const applied: GraphOp[][] = [];
  let graph = opts.graph ?? (() => reservationGraph());
  const queue = [...opts.outputs];
  const d: import("./graph-chat").GraphChatDeps = {
    getGraph: async () => graph(),
    applyOps: async (_u, ops) => {
      applied.push(ops);
      return { created: {}, applied: ops.length };
    },
    createClient: () =>
      ({
        name: "spy",
        generate: async (req: LlmRequest<unknown>) => {
          prompts.push({ system: req.system, user: req.user });
          const output = queue.shift() ?? { reply: "알겠어요", summary: "", followUpQuestions: [], ops: [] };
          return { output: { answeredFollowups: [], ...output }, usage: undefined } as never;
        },
      }) as LlmClient,
    now: () => Date.now(),
  };
  return { deps: d, prompts, applied, setGraph: (g: () => CareerGraph) => void (graph = g) };
}

const statusOf = async (id: string) => (await fu.getFollowup("u1", id))!.status;

describe("예전에 쌓인 바꿔 쓴 중복 정리", () => {
  it("실제 사례: 프로젝트 대화 화면을 열면 이미 채운 것·이미 답한 것을 묻는 열린 질문이 모두 정리된다(다른 사용자 질문은 그대로)", async () => {
    const ids = await seed("u1", [
      [PROD.role1, "answered"],
      [PROD.role2, "open"],
      [PROD.period1, "open"],
      [PROD.period1b, "open"],
      [PROD.period2, "open"],
      [PROD.period2b, "open"],
      [PROD.learned1, "open"],
      [PROD.learned2, "open"],
      [PROD.learned3, "open"],
      [PROD.metric1, "answered"],
      [PROD.metric2, "open"],
      [PROD.metric3, "open"],
      [PROD.metric4, "open"],
    ]);
    // 다른 사용자의 같은 id 프로젝트(노드 id는 사용자마다 다르지만 방어로 확인)
    const other = await seed("u2", [[PROD.role2, "open"]]);
    const { deps: d } = deps({ outputs: [] });
    const t = await gc.createFocusedGraphThread("u1", "n_res", d);
    const view = await gc.getGraphThreadView("u1", t.id, null, d);
    expect(view.followups.filter((f) => f.status === "open")).toEqual([]);
    for (const id of ids) expect(await statusOf(id)).toBe("answered");
    expect((await fu.getFollowup("u2", other[0]!))!.status).toBe("open");
    expect((await fu.followupCounts("u1")).byProject).toEqual({});
  });

  it("후속 질문 목록 API 경로(reconcileProjectFollowups): 그래프에 없는 정보·처음 묻는 수치는 남기고, 같은 것을 바꿔 묻는 것만 skipped", async () => {
    const ids = await seed("u1", [
      [PROD.metric1, "open"],
      [PROD.metric2, "open"],
      ["처리 시간 40분은 어떤 기준으로 쟀나요?", "open"],
    ]);
    const res = await fu.reconcileProjectFollowups("u1", reservationGraph(), ["n_res"]);
    expect(res).toEqual({ answered: [], skipped: [ids[1]] });
    expect(await statusOf(ids[0]!)).toBe("open");
    expect(await statusOf(ids[2]!)).toBe("open");
    // 다시 정리해도(목록·화면을 다시 열어도) 자동 중복 처리한 행 때문에 원래 열린 질문이 연쇄로 닫히지 않는다
    expect(await fu.reconcileProjectFollowups("u1", reservationGraph(), ["n_res"])).toEqual({ answered: [], skipped: [] });
    expect(await statusOf(ids[0]!)).toBe("open");
    // 그래프에 없는 프로젝트(지워짐)는 건드리지 않는다, 다른 사용자 id로는 아무것도 바꾸지 않는다
    expect(await fu.reconcileProjectFollowups("u1", reservationGraph(), ["gone"])).toEqual({ answered: [], skipped: [] });
    expect(await fu.reconcileProjectFollowups("u2", reservationGraph(), ["n_res"])).toEqual({ answered: [], skipped: [] });
    expect(await statusOf(ids[0]!)).toBe("open");
  });
});

describe("다시 열기는 자동 정리로 되돌아가지 않는다", () => {
  it("목록에서 다시 연 질문은 채운 주제여도 정리에서 닫지 않는다(다시 열기 전에는 닫는다)", async () => {
    const [periodQ] = await seed("u1", [[PROD.period2, "open"]]);
    expect((await fu.reconcileProjectFollowups("u1", reservationGraph(), ["n_res"])).answered).toEqual([periodQ]);
    await fu.updateFollowup("u1", periodQ!, { status: "open" }, { getGraph: async () => reservationGraph() });
    expect(await fu.reconcileProjectFollowups("u1", reservationGraph(), ["n_res"])).toEqual({ answered: [], skipped: [] });
    expect(await statusOf(periodQ!)).toBe("open");
  });

  it("답변이 정리한 질문을 되돌리면(다시 열면) 함께 정리한 같은 주제 질문 때문에 다시 닫히지 않는다", async () => {
    const [m1, m2] = await seed("u1", [
      [PROD.metric1, "open"],
      [PROD.metric2, "open"],
    ]);
    expect(await fu.markFollowupsAnswered("u1", [m1!])).toEqual([m1]);
    expect(await statusOf(m2!)).toBe("answered");
    // 되돌리기 = 다시 열기
    await fu.updateFollowup("u1", m1!, { status: "open" }, { getGraph: async () => reservationGraph() });
    await fu.reconcileProjectFollowups("u1", reservationGraph(), ["n_res"]);
    expect(await statusOf(m1!)).toBe("open");
    // 같은 주제의 다른 질문에 답해도 다시 연 질문은 함께 닫지 않는다
    await tdb.prisma.graphFollowup.create({
      data: { id: "u1_m3", userId: "u1", projectNodeId: "n_res", kind: "question", text: PROD.metric3, dedupeKey: "m3", status: "open" },
    });
    expect(await fu.markFollowupsAnswered("u1", ["u1_m3"])).toEqual(["u1_m3"]);
    expect(await statusOf(m1!)).toBe("open");
  });
});

describe("새 후속 질문 가리기", () => {
  it("실제 사례: 역할을 답한 뒤 '역할과 팀 규모'를 다시 묻지 않고, 프롬프트에 이미 채운 항목·답한 질문을 넣는다", async () => {
    await seed("u1", [[PROD.role1, "answered"]]);
    const { deps: d, prompts } = deps({
      outputs: [{ reply: "좋아요", summary: "", ops: [], followUpQuestions: [PROD.role2], followUpTopics: ["role,team"] }],
    });
    const t = await gc.createFocusedGraphThread("u1", "n_res", d);
    await gc.startGraphChatMessage("u1", t.id, "백엔드 로직을 맡았고 동료가 프론트를 했어요", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    const data = reply!.data as GraphProposalData;
    expect(data.followUpQuestions).not.toContain(PROD.role2);
    const open = await fu.listFollowups("u1", { projectNodeId: "n_res", statuses: ["open"] });
    expect(open.map((f) => f.text)).not.toContain(PROD.role2);
    const asked = extractTag(prompts[0]!.user, CHAT_TAGS.askedFollowups) ?? "";
    expect(asked).toContain("[예약율 예측 솔루션]");
    expect(asked).toContain("이미 채운 항목:");
    expect(asked).toContain("맡은 역할");
    expect(asked).toContain(PROD.role1);
    expect(prompts[0]!.system).toContain("followUpTopics");
  });

  it("확인 대기 중인 변경안이 채운 기간은 '그래프에 비어 있다'며 다시 묻지 않는다(그다음 턴, 적용 전)", async () => {
    const g = () => reservationGraph(false);
    const proposeDates: GraphChatOutput = {
      reply: "기간을 정리했어요",
      summary: "기간 추가",
      followUpQuestions: [],
      ops: [{ ...blank, op: "updateNode", id: "n_res", label: "Project", props: [{ key: "startDate", value: "2024-07" }, { key: "endDate", value: "2024-12" }] }],
    };
    const askAgain: GraphChatOutput = { reply: "말씀하셨는데 그래프에 기간이 비어 있어요", summary: "", followUpQuestions: [PROD.period2], ops: [] };
    const { deps: d, prompts } = deps({ graph: g, outputs: [proposeDates, askAgain] });
    const t = await gc.createFocusedGraphThread("u1", "n_res", d);
    // 처음 상태에 열린 기간 질문이 있다
    const [periodQ] = await fu.saveProposalFollowups("u1", { threadId: t.id, messageId: null, candidates: [cand(PROD.period2b, "n_res")] });
    await gc.startGraphChatMessage("u1", t.id, "2024년 7월부터 12월까지요", d, { followupId: periodQ!.id });
    const first = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    expect(first!.status).toBe("proposed");
    // 적용하지 않고 다음 메시지
    await gc.startGraphChatMessage("u1", t.id, "다음은요?", d);
    const second = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    expect((second!.data as GraphProposalData).followUpQuestions).not.toContain(PROD.period2);
    expect((second!.data as GraphProposalData).followUpQuestions).not.toContain(PROD.period2b);
    const user = prompts[1]!.user;
    expect(extractTag(user, CHAT_TAGS.askedFollowups) ?? "").toContain("확인 대기 중인 변경안이 채우는 항목(이미 들었다): 기간");
    // 남은 후속 질문에도 기간 질문을 넣지 않는다(상태는 그대로 — 거절하면 다시 묻는다)
    const rest = extractTag(user, CHAT_TAGS.followupQuestions) ?? "";
    expect(rest).not.toContain(PROD.period2b);
    expect(await statusOf(periodQ!.id)).toBe("open");
    const open = await fu.listFollowups("u1", { projectNodeId: "n_res", statuses: ["open"] });
    expect(open.map((f) => f.text)).not.toContain(PROD.period2);
  });

  it("같은 답변의 변경안이 채우는 것을 묻는 질문, 열린 질문을 바꿔 쓴 질문은 쌓지 않고 그 열린 질문 글로 묻는다", async () => {
    const g = () => reservationGraph(false);
    const [metricQ] = await seed("u1", [[PROD.metric1, "open"]]);
    const out: GraphChatOutput = {
      reply: "정리했어요",
      summary: "역할",
      followUpQuestions: [PROD.metric2],
      ops: [{ ...blank, op: "updateNode", id: "n_res", label: "Project", props: [{ key: "myRole", value: "백엔드" }] }],
    };
    const { deps: d } = deps({ graph: g, outputs: [out] });
    const t = await gc.createFocusedGraphThread("u1", "n_res", d);
    await gc.startGraphChatMessage("u1", t.id, "백엔드를 맡았어요", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    expect((reply!.data as GraphProposalData).followUpQuestions).toEqual([PROD.metric1]);
    const open = await fu.listFollowups("u1", { projectNodeId: "n_res", statuses: ["open"] });
    expect(open.map((f) => f.id)).toEqual([metricQ]);

    // 일반 저장 경로도: 그래프(변경안 얹은 것)에 역할이 있으면 역할 질문은 쌓지 않는다
    const withRole = { ...reservationGraph(false) };
    withRole.nodes = withRole.nodes.map((n) => (n.id === "n_res" ? ({ ...n, props: { ...n.props, myRole: "백엔드" } } as typeof n) : n));
    expect(
      await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("맡은 포지션은?", "n_res")], graph: withRole }),
    ).toEqual([]);
  });

  it("프로젝트당 열린 질문은 상한까지만 쌓는다", async () => {
    const many = Array.from({ length: MAX_OPEN_FOLLOWUPS_PER_PROJECT + 3 }, (_, i) => cand(`그 밖의 이야기 ${i}번`, "n_res"));
    const saved = await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: many });
    expect(saved).toHaveLength(MAX_OPEN_FOLLOWUPS_PER_PROJECT);
    expect(await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("하나 더", "n_res")] })).toEqual([]);
    // 다른 프로젝트·다른 사용자는 따로 센다
    expect(await fu.saveProposalFollowups("u1", { threadId: null, messageId: null, candidates: [cand("하나 더", "n_other")] })).toHaveLength(1);
    expect(await fu.saveProposalFollowups("u2", { threadId: null, messageId: null, candidates: [cand("하나 더", "n_res")] })).toHaveLength(1);
  });
});

describe("답하면 바꿔 쓴 질문도 함께 정리", () => {
  it("채팅 답변이 한 질문을 답했다고 표시하면 같은 것을 바꿔 묻는 열린 질문도 answered(다른 수치·다른 사용자는 그대로)", async () => {
    const [m1, m2, m3, other] = await seed("u1", [
      [PROD.metric1, "open"],
      [PROD.metric2, "open"],
      [PROD.metric3, "open"],
      ["처리 시간 40분은 어떤 기준으로 쟀나요?", "open"],
    ]);
    const [u2q] = await seed("u2", [[PROD.metric2, "open"]]);
    expect(await fu.markFollowupsAnswered("u1", [m1!])).toEqual([m1]);
    expect(await statusOf(m2!)).toBe("answered");
    expect(await statusOf(m3!)).toBe("answered");
    expect(await statusOf(other!)).toBe("open");
    expect((await fu.getFollowup("u2", u2q!))!.status).toBe("open");
    // 다른 사용자의 id로는 아무것도 바뀌지 않는다
    expect(await fu.markFollowupsAnswered("u2", [other!])).toEqual([]);
    expect(await statusOf(other!)).toBe("open");
  });

  it("변경안을 적용하면 채운 주제를 묻던 바꿔 쓴 질문(구조화 항목 없음)도 answered", async () => {
    const g0 = () => reservationGraph(false);
    const [teamQ, periodQ] = await seed("u1", [
      ["같이 한 사람은 몇 명이었나요?", "open"],
      [PROD.period2, "open"],
    ]);
    const out: GraphChatOutput = {
      reply: "팀 규모를 넣을게요",
      summary: "팀 규모",
      followUpQuestions: [],
      ops: [{ ...blank, op: "updateNode", id: "n_res", label: "Project", props: [{ key: "teamSize", value: "2" }] }],
    };
    const { deps: d, setGraph } = deps({ graph: g0, outputs: [out] });
    const t = await gc.createFocusedGraphThread("u1", "n_res", d);
    await gc.startGraphChatMessage("u1", t.id, "둘이서 했어요", d);
    const reply = await gc.runGraphChatReply("u1", t.id, "anthropic", null, d);
    expect(await statusOf(teamQ!)).toBe("open");
    setGraph(() => {
      const g = reservationGraph(false);
      g.nodes = g.nodes.map((n) => (n.id === "n_res" ? ({ ...n, props: { ...n.props, teamSize: 2 } } as typeof n) : n));
      return g;
    });
    await gc.applyGraphProposal("u1", reply!.id, d);
    expect(await statusOf(teamQ!)).toBe("answered");
    expect(await statusOf(periodQ!)).toBe("open");
  });
});
