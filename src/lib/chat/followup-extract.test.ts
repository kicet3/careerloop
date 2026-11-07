/**
 * 변경안 → 후속 질문 후보(순수): 뺀 항목 중 채울 수 있는 것만 질문으로, 프로젝트 귀속, 중복 제거.
 */
import { describe, expect, it } from "vitest";
import type { CareerGraph, GraphOp, LlmGraphOp } from "@/lib/domain/graph";
import { qaGraph } from "@/lib/graph/__fixtures__/qa-graph";
import { PROJECT_STRUCTURE_ITEMS } from "@/lib/graph/project-structure";
import {
  dedupeCandidates,
  projectByName,
  projectOfBatch,
  projectOfOp,
  questionsFromEvidenceGaps,
  questionsFromFollowUps,
  questionsFromFormatErrors,
  structureItemOfQuestion,
} from "./followup-extract";

const blank: Omit<LlmGraphOp, "op"> = { ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };
const ctx = (batch: GraphOp[] = [], graph: CareerGraph = qaGraph()) => ({ graph, batch });

describe("프로젝트 귀속", () => {
  it("Project 연산은 그 프로젝트, 다른 노드는 이어진 Project가 하나일 때만", () => {
    const c = ctx();
    expect(projectOfOp({ op: "updateNode", id: "p_payment", label: "Project", props: { learned: "x" } }, c)).toEqual({ id: "p_payment" });
    // 성과 a_settle은 p_payment에만 이어져 있다
    expect(projectOfOp({ op: "updateNode", id: "a_settle", label: "Achievement", props: { value: "1" } }, c)).toEqual({ id: "p_payment" });
    // React는 두 프로젝트(p_dashboard, p_shop)에 이어져 있어 정할 수 없다
    expect(projectOfOp({ op: "updateNode", id: "s_react", label: "Skill", props: { level: "상" } }, c)).toBeNull();
    // 직무는 Project가 아니고 여러 프로젝트에 이어져 있다
    expect(projectOfOp({ op: "updateNode", id: "r_backend", label: "Role", props: { summary: "x" } }, c)).toBeNull();
  });

  it("같은 변경안의 관계로 새 노드가 붙는 Project, 새 Project는 ref", () => {
    const batch: GraphOp[] = [
      { op: "addNode", ref: "new:a", label: "Achievement", props: { summary: "성과" } },
      { op: "addEdge", type: "ACHIEVED", from: "p_wiki", to: "new:a" },
      { op: "addNode", ref: "new:p", label: "Project", props: { name: "추천 서비스" } },
      { op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
    ];
    const c = ctx(batch);
    expect(projectOfOp(batch[0]!, c)).toEqual({ id: "p_wiki" });
    expect(projectOfOp(batch[2]!, c)).toEqual({ ref: "new:p" });
    // 변경안이 두 프로젝트에 걸치면 전체 귀속은 없다
    expect(projectOfBatch(batch, c)).toBeNull();
    expect(projectOfBatch(batch.slice(0, 2), c)).toEqual({ id: "p_wiki" });
  });

  it("이름 일치: 하나만 맞을 때만(새 Project 이름 포함)", () => {
    const batch: GraphOp[] = [{ op: "addNode", ref: "new:p", label: "Project", props: { name: "추천 서비스" } }];
    expect(projectByName("결제 개선 프로젝트의 팀 규모는?", ctx())).toEqual({ id: "p_payment" });
    expect(projectByName("추천서비스는 언제 했나요?", ctx(batch))).toEqual({ ref: "new:p" });
    expect(projectByName("결제 개선과 주문 대시보드 중 무엇이 먼저였나요?", ctx())).toBeNull();
    expect(projectByName("기간을 알려 주세요", ctx())).toBeNull();
  });
});

describe("변경안에서 뺀 항목 → 질문", () => {
  it("기간·팀 규모 형식 오류만 질문으로 만들고, 그 밖의 형식 오류는 넘긴다", () => {
    const llmOps: LlmGraphOp[] = [
      { ...blank, op: "updateNode", id: "p_payment", label: "Project", props: [{ key: "startDate", value: "작년 봄" }] },
      { ...blank, op: "addNode", ref: "new:p", label: "Project", props: [{ key: "name", value: "추천 서비스" }, { key: "teamSize", value: "3-4명" }] },
      { ...blank, op: "updateNode", id: "p_payment", label: "Project", props: [{ key: "url", value: "not a url" }] },
      { ...blank, op: "addNode", ref: "", label: "", props: [] },
    ];
    const errors = [
      "#1 updateNode: 속성 startDate 값 '작년 봄'은(는) 형식이 맞지 않아 뺐습니다",
      "#2 addNode: 속성 teamSize 값 '3-4명'은(는) 형식이 맞지 않아 뺐습니다",
      "#3 updateNode: 속성 url 값 'not a url'은(는) 형식이 맞지 않아 뺐습니다",
      "#4 addNode: label이 없습니다",
    ];
    const batch: GraphOp[] = [{ op: "addNode", ref: "new:p", label: "Project", props: { name: "추천 서비스" } }];
    const out = questionsFromFormatErrors(errors, llmOps, ctx(batch), null);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "dropped", projectNodeId: "p_payment", projectRef: null, targetItem: null, detail: errors[0] });
    expect(out[0]!.text).toContain("‘결제 개선’의 시작 시점");
    expect(out[0]!.text).toContain("2023-03");
    expect(out[1]).toMatchObject({ projectNodeId: null, projectRef: "new:p", targetItem: null });
    expect(out[1]!.text).toContain("몇 명");
    // 프로젝트 대화면 모두 그 프로젝트
    expect(questionsFromFormatErrors(errors, llmOps, ctx(batch), "p_wiki").every((c) => c.projectNodeId === "p_wiki")).toBe(true);
  });

  it("한 연산의 시작·종료가 함께 빠지면 기간 질문은 하나만", () => {
    const llmOps: LlmGraphOp[] = [
      { ...blank, op: "updateNode", id: "p_payment", label: "Project", props: [{ key: "startDate", value: "2027-01" }, { key: "endDate", value: "2027-05" }] },
    ];
    const errors = [
      "#1 updateNode: 속성 startDate 값 '2027-01'은(는) 오늘 이후 날짜라 뺐습니다",
      "#1 updateNode: 속성 endDate 값 '2027-05'은(는) 오늘 이후 날짜라 뺐습니다",
    ];
    expect(questionsFromFormatErrors(errors, llmOps, ctx(), null)).toHaveLength(1);
  });

  it("문서에 근거가 없어 뺀 항목: 항목째·숫자 속성을 다른 문장으로 묻는다", () => {
    const ach: GraphOp = { op: "addNode", ref: "new:a", label: "Achievement", props: { summary: "매출 30% 증가" } };
    const upd: GraphOp = { op: "updateNode", id: "p_payment", label: "Project", props: { result: "지연 50% 감소" } };
    const batch: GraphOp[] = [ach, { op: "addEdge", type: "ACHIEVED", from: "p_shop", to: "new:a" }, upd];
    const out = questionsFromEvidenceGaps(
      [
        { op: ach, keys: null, reason: "성과 추가: 매출 30% 증가 — 문서에서 찾지 못한 항목이라 뺐습니다" },
        { op: upd, keys: ["result"], reason: "프로젝트 수정: 결제 개선 (result) — 문서에 없는 숫자가 있어 뺐습니다" },
      ],
      ctx(batch),
      null,
    );
    expect(out[0]).toMatchObject({ projectNodeId: "p_shop", targetItem: null });
    expect(out[0]!.text).toContain("성과 ‘매출 30% 증가’은(는) 문서에서 찾지 못해");
    expect(out[1]).toMatchObject({ projectNodeId: "p_payment", targetItem: null });
    expect(out[1]!.text).toContain("‘결제 개선’의 결과에 문서에 없는 숫자");
  });
});

describe("후속 질문 → 후보", () => {
  it("이름 → 변경안 전체 → 미지정 순으로 귀속하고, 체크리스트 질문이면 구조화 항목을 단다", () => {
    const ops: GraphOp[] = [{ op: "updateNode", id: "p_wiki", label: "Project", props: { learned: "x" } }];
    const checklistQ = PROJECT_STRUCTURE_ITEMS.find((d) => d.id === "role")!.question;
    const out = questionsFromFollowUps(["결제 개선의 기간은?", checklistQ, "  "], ops, ctx(ops), null);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ kind: "question", projectNodeId: "p_payment", targetItem: null });
    expect(out[1]).toMatchObject({ projectNodeId: "p_wiki", targetItem: "role" });
    // 프로젝트가 정해지지 않으면 구조화 항목도 달지 않는다
    expect(questionsFromFollowUps([checklistQ], [], ctx(), null)[0]).toMatchObject({ projectNodeId: null, targetItem: null });
    expect(structureItemOfQuestion(` ${checklistQ.replace("?", "")} `)).toBe("role");
  });

  it("같은 프로젝트에서 정규화한 글이 같으면 하나로", () => {
    const base = { kind: "question" as const, detail: null, targetItem: null, projectRef: null };
    const out = dedupeCandidates([
      { ...base, text: "기간은 언제인가요?", projectNodeId: "p1" },
      { ...base, text: "기간은  언제인가요", projectNodeId: "p1" },
      { ...base, text: "기간은 언제인가요?", projectNodeId: "p2" },
      { ...base, text: "기간은 언제인가요?", projectNodeId: null },
      { ...base, text: "???", projectNodeId: null },
    ]);
    expect(out.map((c) => c.projectNodeId)).toEqual(["p1", "p2", null]);
  });
});
