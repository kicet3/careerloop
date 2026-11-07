/**
 * 후속 질문 주제 판정·가리기(순수): 같은 것을 바꿔 묻는 질문(역할·팀, 기간, 배운 점, 측정 기준)과 이미 채운 항목, 확인 대기 변경안.
 * 실제 사례: '예약율 예측 솔루션' 프로젝트 대화에서 답한 역할·기간·측정 기준을 표현만 바꿔 다시 물었다.
 */
import { describe, expect, it } from "vitest";
import { reservationGraph } from "@/lib/graph/__fixtures__/reservation-graph";
import { PROJECT_STRUCTURE_ITEMS } from "@/lib/graph/project-structure";
import { type ExistingFollowup, guardFollowupQuestions, questionsFromFollowUps } from "./followup-extract";
import {
  coverOf,
  filledTopics,
  followupTopicKeys,
  followupTopics,
  overlayGraphOps,
  planFollowupReconcile,
  structureItemOfTopics,
} from "./followup-topics";

const PROD = {
  role1: "맡은 역할은 무엇이었나요? 혼자/함께?",
  role2: "맡으신 역할과 팀 규모는 어땠나요? (예: 2인 중 백엔드 담당)",
  period1: "진행한 기간과 사용한 기술을 알려 주세요",
  period2: "언제부터 언제까지 진행하셨나요?",
  learned: "이 프로젝트에서 배운 점·아쉬운 점은 무엇인가요?",
  learned2: "돌아보면 아쉬웠던 점과 배운 점이 있나요?",
  metric1: "오차 약 3%는 어떤 기준으로 쟀나요?",
  metric2: "예측 오차 3%는 어떻게 측정한 값인가요?",
  metric3: "3% 오차는 무엇 대비로 계산했나요?",
  actions: "예약율 예측 솔루션에서 백엔드 담당으로 구체적으로 어떤 일을 했나요?",
};

describe("주제 판정", () => {
  it("실제 사례의 바꿔 쓴 질문들을 같은 주제로 읽는다", () => {
    expect(followupTopics(PROD.role1)).toEqual(["role", "team"]);
    expect(followupTopics(PROD.role2)).toEqual(["role", "team"]);
    expect(followupTopics(PROD.period1)).toEqual(["period", "tech"]);
    expect(followupTopics(PROD.period2)).toEqual(["period"]);
    expect(followupTopics(PROD.learned)).toEqual(["learned", "limitations"]);
    expect(followupTopics(PROD.learned2)).toEqual(["learned", "limitations"]);
    for (const q of [PROD.metric1, PROD.metric2, PROD.metric3]) expect(followupTopicKeys(q)).toEqual(["metric-basis:3%"]);
    // 역할을 전제로 한 일을 묻는 질문은 역할 + 한 일(한 일이 비어 있으면 물을 수 있다)
    expect(followupTopics(PROD.actions)).toEqual(["role", "actions"]);
    // 다른 수치의 측정 기준은 다른 주제
    expect(followupTopicKeys("응답 시간 40분 단축은 어떤 기준으로 쟀나요?")).toEqual(["metric-basis:40분"]);
  });

  it("체크리스트 질문은 각자 항목의 주제로 읽고, 한 항목에만 드는 주제면 그 구조화 항목을 단다", () => {
    const q = (id: string) => PROJECT_STRUCTURE_ITEMS.find((d) => d.id === id)!.question;
    expect(followupTopics(q("background"))).toEqual(["background"]);
    expect(followupTopics(q("role"))).toEqual(["role", "team"]);
    expect(followupTopics(q("skills"))).toEqual(["tech"]);
    expect(followupTopics(q("results"))).toEqual(["result"]);
    expect(followupTopics(q("context"))).toEqual(["period", "affiliation"]);
    expect(followupTopics(q("learned"))).toEqual(["learned"]);
    expect(structureItemOfTopics(followupTopicKeys("맡으신 포지션이 뭐였나요?"))).toBe("role");
    expect(structureItemOfTopics(followupTopicKeys(PROD.role2))).toBeNull(); // 팀 규모는 항목 완료 조건이 아니다
    expect(structureItemOfTopics([])).toBeNull();
  });

  it("LLM이 표시한 주제(followUpTopics)를 합치고, 표현이 바뀐 질문에도 구조화 항목을 단다", () => {
    const g = reservationGraph(false);
    const [c] = questionsFromFollowUps(["그 시절 무엇을 깨쳤나요?"], [], { graph: g, batch: [] }, "n_res", ["learned"]);
    expect(c).toMatchObject({ targetItem: "learned", topics: ["learned"], projectNodeId: "n_res" });
    // 모르는 주제 표시는 버린다
    const [d] = questionsFromFollowUps(["그 시절 무엇을 깨쳤나요?"], [], { graph: g, batch: [] }, "n_res", ["nonsense"]);
    expect(d!.topics).toBeUndefined();
  });
});

describe("처음 묻는 질문을 중복으로 보지 않는다(모두 채운 프로젝트)", () => {
  it("어려웠던 점·문제 해결, 협업, 특정 대상을 파고드는 질문은 새 질문이다", () => {
    const filled = filledTopics(reservationGraph(), "n_res");
    for (const q of [
      "가장 어려웠던 문제는 무엇이었고 어떻게 해결했나요?",
      "개발 중 겪은 기술적 문제는 무엇이었나요?",
      "Redis 캐시는 구체적으로 어떻게 구현했나요?",
      "동료와는 어떻게 협업했나요?",
      "목표 정확도는 얼마였나요?",
      "API 응답 속도는 어떻게 개선했나요?",
    ]) {
      expect(coverOf(q, followupTopicKeys(q), filled, []).kind, q).toBe("new");
    }
    // 실제 사례의 일반적인 "구체적으로 어떤 일" 질문은 여전히 이미 채운 것
    expect(coverOf(PROD.actions, followupTopicKeys(PROD.actions), filled, []).kind).toBe("known");
    // 같은 어려움 질문을 바꿔 물으면 열린 질문으로 묶는다
    const open = [{ id: "c", text: "가장 어려웠던 점은 무엇이었나요?", status: "open" as const }];
    const q = "개발하면서 힘들었던 부분은요?";
    expect(coverOf(q, followupTopicKeys(q), filled, open)).toMatchObject({ kind: "open", sameAs: { id: "c" } });
  });
});

describe("이미 채운 주제", () => {
  it("프로젝트 노드·이은 기술·성과에서 읽는다(측정 기준은 그래프로 정하지 않는다)", () => {
    expect([...filledTopics(reservationGraph(), "n_res")].sort()).toEqual(
      ["actions", "background", "learned", "limitations", "period", "result", "role", "team", "tech"].sort(),
    );
    expect([...filledTopics(reservationGraph(false), "n_res")].sort()).toEqual(["actions", "background", "result"].sort());
    expect(filledTopics(reservationGraph(), "missing").size).toBe(0);
  });

  it("확인 대기 변경안을 얹은 복사본은 그 값을 채운 것으로 본다(원본은 그대로)", () => {
    const g = reservationGraph(false);
    const after = overlayGraphOps(
      g,
      [
        { op: "updateNode", id: "n_res", label: "Project", props: { startDate: "2024-07", myRole: "백엔드" } },
        { op: "addNode", ref: "new:s", label: "Skill", props: { name: "Redis" } },
        { op: "addEdge", type: "USED_SKILL", from: "n_res", to: "new:s" },
      ],
      "m1:",
    );
    expect(filledTopics(after, "n_res").has("period")).toBe(true);
    expect(filledTopics(after, "n_res").has("role")).toBe(true);
    expect(filledTopics(after, "n_res").has("tech")).toBe(true);
    expect(filledTopics(g, "n_res").has("period")).toBe(false);
    expect(after.nodes.some((n) => n.id === "m1:new:s")).toBe(true);
    // 값 ""는 속성 삭제
    const cleared = overlayGraphOps(after, [{ op: "updateNode", id: "n_res", label: "Project", props: { myRole: "" } } as never]);
    expect(filledTopics(cleared, "n_res").has("role")).toBe(false);
  });
});

describe("이미 아는 것·이미 물은 것 가리기", () => {
  const ex = (id: string, text: string, status: ExistingFollowup["status"], projectNodeId = "n_res"): ExistingFollowup => ({
    id,
    text,
    status,
    projectNodeId,
    kind: "question",
  });

  it("coverOf: 채운 주제뿐이면 known, 답한 질문과 같은 주제면 known, 열린 질문과 같으면 그 질문, 일부만 덮이면 new", () => {
    const filled = filledTopics(reservationGraph(), "n_res");
    expect(coverOf(PROD.role2, followupTopicKeys(PROD.role2), filled, []).kind).toBe("known");
    expect(coverOf(PROD.period2, followupTopicKeys(PROD.period2), filled, []).kind).toBe("known");
    expect(coverOf(PROD.metric2, followupTopicKeys(PROD.metric2), filled, [ex("a", PROD.metric1, "answered")]).kind).toBe("known");
    const open = coverOf(PROD.metric3, followupTopicKeys(PROD.metric3), filled, [ex("o", PROD.metric1, "open")]);
    expect(open).toMatchObject({ kind: "open", sameAs: { id: "o" } });
    // 다른 수치의 측정 기준은 새 질문
    const q = "처리 시간 40분은 어떤 기준으로 쟀나요?";
    expect(coverOf(q, followupTopicKeys(q), filled, [ex("a", PROD.metric1, "answered")]).kind).toBe("new");
    // 역할은 채웠지만 팀 규모가 비어 있으면 묻는다
    const empty = filledTopics(reservationGraph(false), "n_res");
    expect(coverOf(PROD.role2, followupTopicKeys(PROD.role2), new Set([...empty, "role" as const]), []).kind).toBe("new");
    // 주제를 못 읽으면 글 비교만
    expect(coverOf("그밖에 하실 말씀은?", [], filled, []).kind).toBe("new");
    expect(coverOf("그밖에 하실 말씀은", [], filled, [ex("s", "그밖에 하실 말씀은?", "skipped")]).kind).toBe("known");
  });

  it("planFollowupReconcile: 실제 사례의 열린 중복을 모두 정리하고, 아직 모르는 것은 남긴다", () => {
    const rows = [
      { ...ex("r1", PROD.role1, "answered"), kind: "question" as const },
      { ...ex("o1", PROD.role2, "open"), kind: "question" as const },
      { ...ex("o2", PROD.period1, "open"), kind: "question" as const },
      { ...ex("o3", PROD.period1, "open"), kind: "question" as const },
      { ...ex("o4", PROD.period2, "open"), kind: "question" as const },
      { ...ex("o5", PROD.learned, "open"), kind: "question" as const },
      { ...ex("m1", PROD.metric1, "answered"), kind: "question" as const },
      { ...ex("o6", PROD.metric2, "open"), kind: "question" as const },
      { ...ex("o7", PROD.metric3, "open"), kind: "question" as const },
      { ...ex("o8", "처리 시간 40분은 어떤 기준으로 쟀나요?", "open"), kind: "question" as const },
      { ...ex("o9", "처리 시간 40분은 어떻게 측정했나요?", "open"), kind: "question" as const },
      { ...ex("d1", "‘예약율 예측 솔루션’의 시작 시점을 ‘작년’으로는 알 수 없어 넣지 않았어요.", "open"), kind: "dropped" as const },
    ];
    const plan = planFollowupReconcile(rows, filledTopics(reservationGraph(), "n_res"));
    expect(plan.answered.sort()).toEqual(["o1", "o2", "o3", "o4", "o5", "o6", "o7"].sort());
    // 새 수치(40분)는 처음 것만 남기고 바꿔 쓴 두 번째는 중복(그 처음 질문을 가리킨다), 뺀 항목 질문은 건드리지 않는다
    expect(plan.skipped).toEqual([]);
    expect(plan.duplicates).toEqual([{ id: "o9", of: "o8" }]);
  });

  it("planFollowupReconcile: 중복 처리한 행을 빼고 다시 돌려도 원래 열린 질문은 닫지 않는다, 다시 연 질문(pinned)은 닫지 않는다", () => {
    const filled = filledTopics(reservationGraph(), "n_res");
    const q = (id: string, text: string, status: ExistingFollowup["status"], pinned = false) => ({
      ...ex(id, text, status),
      kind: "question" as const,
      ...(pinned ? { pinned } : {}),
    });
    const first = planFollowupReconcile([q("o8", "처리 시간 40분은 어떤 기준으로 쟀나요?", "open"), q("o9", "처리 시간 40분은 어떻게 측정했나요?", "open")], filled);
    expect(first.duplicates).toEqual([{ id: "o9", of: "o8" }]);
    // 두 번째 정리: 중복 처리한 o9는 조회에서 빠진다(duplicate_of) — o8은 그대로 열려 있어야 한다
    const second = planFollowupReconcile([q("o8", "처리 시간 40분은 어떤 기준으로 쟀나요?", "open")], filled);
    expect(second).toEqual({ answered: [], skipped: [], duplicates: [] });
    // 사용자가 다시 연 질문은 그래프에 채운 주제·답한 질문과 같아도 닫지 않고, 그 뒤의 같은 질문을 중복으로 본다
    const pinned = planFollowupReconcile(
      [q("a", PROD.role1, "answered"), q("r", PROD.role2, "open", true), q("p", PROD.period2, "open", true), q("p2", PROD.period2, "open")],
      filled,
    );
    expect(pinned.answered).toEqual(["p2"]);
    expect(pinned.skipped).toEqual([]);
  });

  it("guardFollowupQuestions(프로젝트 대화): 이미 채운 것을 바꿔 물으면 빼고 다음 미완료 항목을 묻는다, 열린 질문과 같으면 그 글로 바꾼다", () => {
    // 역할·팀·기간은 채웠고 배운 점이 빈 상태
    const g = reservationGraph();
    const project = g.nodes.find((n) => n.id === "n_res")!;
    delete (project.props as Record<string, unknown>).learned;
    const cands = questionsFromFollowUps([PROD.role2], [], { graph: g, batch: [] }, "n_res");
    const out = guardFollowupQuestions({ questions: [PROD.role2], candidates: cands, graph: g, existing: [], focusProjectId: "n_res" });
    expect(out.removed).toEqual([PROD.role2]);
    // 체크리스트 순서상 남은 첫 항목은 기간·소속(소속이 없다) → 그다음 질문
    const contextQ = PROJECT_STRUCTURE_ITEMS.find((d) => d.id === "context")!.question;
    expect(out.questions).toEqual([contextQ]);
    expect(out.candidates.map((c) => [c.text, c.targetItem])).toEqual([[contextQ, "context"]]);

    // 열린 질문이 같은 것을 묻고 있으면 그 질문 글로 바꿔 묻는다(새로 쌓지 않는다)
    const cands2 = questionsFromFollowUps([PROD.metric2], [], { graph: g, batch: [] }, "n_res");
    const out2 = guardFollowupQuestions({
      questions: [PROD.metric2],
      candidates: cands2,
      graph: g,
      existing: [ex("o", PROD.metric1, "open")],
      focusProjectId: "n_res",
    });
    expect(out2.questions).toEqual([PROD.metric1]);
    expect(out2.candidates).toEqual([]);

    // 이 대화에서 이미 답으로 보낸 열린 질문(skipIds)은 대신 묻지 않는다
    const out3 = guardFollowupQuestions({
      questions: [PROD.role2],
      candidates: cands,
      graph: g,
      existing: [ex("o", "출시 뒤 사용자 반응 3가지는?", "open")],
      focusProjectId: "n_res",
      skipIds: new Set(["o"]),
    });
    expect(out3.questions).toEqual([contextQ]);
  });

  it("guardFollowupQuestions(일반 대화): 프로젝트에 귀속한 질문만 가리고, 같은 변경안 안의 바꿔 쓴 질문은 하나만 남긴다", () => {
    const g = reservationGraph(false);
    const qs = [PROD.period2, "그 프로젝트는 언제 진행했나요?", "다른 경험도 있나요?"];
    const cands = questionsFromFollowUps(qs, [], { graph: g, batch: [] }, null).map((c, i) => (i < 2 ? { ...c, projectNodeId: "n_res" } : c));
    const out = guardFollowupQuestions({ questions: qs, candidates: cands, graph: g, existing: [], focusProjectId: null });
    expect(out.candidates.map((c) => c.text)).toEqual([PROD.period2, "다른 경험도 있나요?"]);
    expect(out.questions).toEqual([PROD.period2, "다른 경험도 있나요?"]);
    // 다른 프로젝트의 답한 질문은 이 프로젝트 판정에 쓰지 않는다
    const out2 = guardFollowupQuestions({
      questions: [PROD.period2],
      candidates: cands.slice(0, 1),
      graph: g,
      existing: [ex("x", "기간은 언제였나요?", "answered", "n_other")],
      focusProjectId: null,
    });
    expect(out2.questions).toEqual([PROD.period2]);
  });
});
