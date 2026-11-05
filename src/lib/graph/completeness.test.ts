import { describe, expect, it } from "vitest";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import { experienceCategory } from "@/lib/domain/experience-categories";
import { type CareerGraph, type GraphEdge, type GraphNode, edgeId, type RelType, STORY_TAGS } from "@/lib/domain/graph";
import { assessExperienceChecklist, categoryAskMessage, checklistToPromptText, type ExperienceChecklist, hasMetric } from "./completeness";

const node = (id: string, label: GraphNode["label"], props: Record<string, unknown>) => ({ id, label, props, createdAt: 0, updatedAt: 0 }) as GraphNode;
const edge = (type: RelType, from: string, to: string): GraphEdge => ({ id: edgeId(type, from, to), type, from, to });
const graph = (nodes: GraphNode[] = [], edges: GraphEdge[] = []): CareerGraph => ({ person: { id: "me", name: null }, nodes, edges });
const get = (c: ExperienceChecklist, id: string) => c.categories.find((x) => x.id === id)!;

const STORY = {
  situation: "물류 정산이 매일 3시간씩 걸리던 상황",
  action: "배치 쿼리를 다시 설계하고 인덱스를 추가함",
  result: "정산 시간이 3시간에서 20분으로 줄어듦",
  learned: "측정부터 하고 고치는 습관이 생겼다",
};

describe("assessExperienceChecklist", () => {
  it("빈 그래프: 10개 모두 missing, progress 0", () => {
    const c = assessExperienceChecklist(graph());
    expect(c.categories).toHaveLength(10);
    expect(c.categories.every((x) => x.state === "missing")).toBe(true);
    expect(c).toMatchObject({ progress: 0, complete: false, requiredDone: 0, requiredTotal: 6, recommendedTotal: 4 });
  });

  it("career: 회사 연결 없는 Role은 partial(힌트에 '회사'), 조건을 채운 Role·Project는 done", () => {
    const role = node("r1", "Role", { title: "백엔드", startDate: "2021-01", summary: "결제 API를 개발하고 운영했다" });
    const partial = get(assessExperienceChecklist(graph([role])), "career");
    expect(partial.state).toBe("partial");
    expect(partial.hint).toContain("회사");
    expect(partial.best).toMatchObject({ nodeId: "r1", fix: "link" });

    const co = node("c1", "Company", { name: "페이랩" });
    expect(get(assessExperienceChecklist(graph([role, co], [edge("AT_COMPANY", "r1", "c1")])), "career").state).toBe("done");

    const project = node("p1", "Project", { name: "대시보드", myRole: "백엔드", startDate: "2023-01", action: STORY.action });
    expect(get(assessExperienceChecklist(graph([project])), "career").state).toBe("done");
  });

  it("quantified-result: 숫자 없음 partial, 경험에서 ACHIEVED면 done, me에서만이면 partial", () => {
    const p = node("p1", "Project", { name: "대시보드" });
    const noNum = node("a1", "Achievement", { summary: "응답 속도 개선" });
    const s1 = get(assessExperienceChecklist(graph([p, noNum], [edge("ACHIEVED", "p1", "a1")])), "quantified-result");
    expect(s1.state).toBe("partial");
    expect(s1.hint).toContain("수치");

    const num = node("a2", "Achievement", { summary: "전환율 개선", value: "30%" });
    expect(get(assessExperienceChecklist(graph([p, num], [edge("ACHIEVED", "p1", "a2")])), "quantified-result").state).toBe("done");
    const meOnly = get(assessExperienceChecklist(graph([p, num], [edge("ACHIEVED", "me", "a2")])), "quantified-result");
    expect(meOnly.state).toBe("partial");
    expect(meOnly.hint).toContain("연결");
    expect(meOnly.best?.fix).toBe("link");

    const withResult = node("p2", "Project", { name: "b", result: STORY.result });
    expect(get(assessExperienceChecklist(graph([withResult])), "quantified-result").state).toBe("done");
  });

  it("hasMetric: 날짜·연도·학년만 있으면 수치가 아니다", () => {
    for (const t of ["2024년 3월에 서비스 출시", "2023 해커톤 참가", "2024.03 출시", "2024-03-05 배포", "3월 5일 오픈", "3학년 2학기 프로젝트", "2024 Q1 런칭"]) {
      expect(hasMetric(t), t).toBe(false);
    }
    for (const t of ["처리 시간 3일→1일", "전환율 12%→18%", "참여자 2000명", "2023년 매출 30% 증가", "30%", "응답 속도 2배"]) {
      expect(hasMetric(t), t).toBe(true);
    }
    const dateOnly = node("p3", "Project", { name: "c", result: "2024년 3월에 서비스 출시" });
    expect(get(assessExperienceChecklist(graph([dateOnly])), "quantified-result").state).toBe("partial");
  });

  it("태그 카테고리: myRole이 없으면 partial, description이 situation을 대신, 8자 미만은 빈 값", () => {
    const exp = node("e1", "Experience", { title: "동아리", categories: ["collaboration"], description: "동아리 행사 준비 중 의견 충돌", action: STORY.action, result: STORY.result });
    const s = get(assessExperienceChecklist(graph([exp])), "collaboration");
    expect(s.state).toBe("partial");
    expect(s.best?.missingFields).toEqual(["myRole"]);
    expect(s.best?.missing).toEqual(["내 역할"]);

    const full = node("e1", "Experience", { ...exp.props, myRole: "기획팀장" });
    expect(get(assessExperienceChecklist(graph([full])), "collaboration").state).toBe("done");

    const short = node("e2", "Experience", { title: "x", categories: ["problem-solving"], situation: STORY.situation, action: "했음", result: STORY.result });
    expect(get(assessExperienceChecklist(graph([short])), "problem-solving").best?.missingFields).toEqual(["action"]);
  });

  it("후보가 여럿이면 가장 덜 빠진 것이 best, 모르는 태그는 무시", () => {
    const a = node("p1", "Project", { name: "A", categories: ["problem-solving"] });
    const b = node("p2", "Project", { name: "B", categories: ["problem-solving", "foo"], situation: STORY.situation, action: STORY.action });
    const s = get(assessExperienceChecklist(graph([a, b])), "problem-solving");
    expect(s.state).toBe("partial");
    expect(s.matchedNodeIds).toEqual(["p1", "p2"]);
    expect(s.best).toMatchObject({ nodeId: "p2", missingFields: ["result"] });
    expect(s.hint).toContain("‘B’");
  });

  it("progress는 done=1, partial=0.5, complete는 필수 6개 done", () => {
    const co = node("c1", "Company", { name: "페이랩" });
    const p = node("p1", "Project", {
      name: "대시보드",
      myRole: "백엔드",
      startDate: "2023-01",
      ...STORY,
      categories: ["problem-solving", "collaboration", "challenge-failure"],
    });
    const c1 = assessExperienceChecklist(graph([co, p]));
    // career·quantified·problem-solving·challenge-failure done, collaboration done(myRole 있음), motivation missing
    expect(get(c1, "collaboration").state).toBe("done");
    expect(c1.requiredDone).toBe(5);
    expect(c1.progress).toBe(Math.round((100 * 5) / 6));
    expect(c1.complete).toBe(false);

    const m = node("e1", "Experience", { title: "계기", categories: ["motivation"], situation: STORY.situation });
    const c2 = assessExperienceChecklist(graph([co, p, m]));
    expect(get(c2, "motivation").state).toBe("partial");
    expect(c2.progress).toBe(Math.round((100 * 5.5) / 6));

    const m2 = node("e1", "Experience", { ...m.props, action: STORY.action });
    const c3 = assessExperienceChecklist(graph([co, p, m2]));
    expect(c3).toMatchObject({ complete: true, progress: 100, requiredDone: 6 });
  });

  it("Certification만 있으면 learning partial", () => {
    const s = get(assessExperienceChecklist(graph([node("x1", "Certification", { name: "정보처리기사" })])), "learning");
    expect(s.state).toBe("partial");
    expect(s.hint).toContain("자격증");
    expect(s.best).toBeUndefined();
  });
});

describe("categoryAskMessage · checklistToPromptText", () => {
  it("partial이면 노드 이름·빠진 필드, missing이면 chatStarter, 길이 상한", () => {
    const exp = node("e1", "Experience", { title: "물류 대시보드", categories: ["collaboration"], description: "동아리 행사 준비 중 의견 충돌" });
    const c = assessExperienceChecklist(graph([exp]));
    const msg = categoryAskMessage(get(c, "collaboration"));
    expect(msg).toContain("물류 대시보드");
    expect(msg).toContain("내 역할");
    expect(msg).toContain("결과(R)");
    expect(categoryAskMessage(get(c, "leadership"))).toBe(experienceCategory("leadership").chatStarter);
    for (const s of c.categories) expect(categoryAskMessage(s).length).toBeLessThanOrEqual(MAX_CHAT_MESSAGE_CHARS);
  });

  it("빠진 필수 항목이 먼저, id 포함", () => {
    const p = node("p1", "Project", { name: "A", myRole: "백엔드", startDate: "2023-01", action: STORY.action });
    const text = checklistToPromptText(assessExperienceChecklist(graph([p])));
    const lines = text.split("\n");
    expect(lines[0]).toContain("필수 1/6");
    expect(lines[1]).toMatch(/^- \[필수·없음\] quantified-result/);
    expect(lines.at(-1)).toContain("career");
    for (const t of STORY_TAGS) expect(text).toContain(t);
    const firstRecommended = lines.findIndex((l) => l.includes("[추천"));
    const lastRequiredMissing = lines.findLastIndex((l) => l.includes("[필수·없음]") || l.includes("[필수·일부]"));
    expect(lastRequiredMissing).toBeLessThan(firstRecommended);
  });
});
