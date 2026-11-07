/**
 * 후속 질문 중복 회귀 테스트용 고정 그래프: 실제 사례('예약율 예측 솔루션' 프로젝트 대화에서 답한 역할·기간·측정 기준을 다시 물었다)를
 * 줄인 것. full=false면 역할·팀·기간·배운 점·기술이 빈 처음 상태.
 */
import { type CareerGraph, edgeId, type GraphEdge, type GraphNode, PERSON_ID, type RelType } from "@/lib/domain/graph";

const node = (n: Omit<GraphNode, "createdAt" | "updatedAt">): GraphNode => ({ ...n, createdAt: 1, updatedAt: 1 }) as GraphNode;
const edge = (type: RelType, from: string, to: string): GraphEdge => ({ id: edgeId(type, from, to), type, from, to });

/** 프로젝트 n_res(예약율 예측 솔루션, 성과 a_err "오차 약 3%"), 다른 프로젝트 n_other. */
export function reservationGraph(full = true): CareerGraph {
  const props: Record<string, unknown> = {
    name: "예약율 예측 솔루션",
    summary: "호텔 예약율을 예측하는 솔루션",
    situation: "객실 예약 수요를 미리 알 수 없어 인력 배치가 어려웠다",
    action: "예측 API와 배치 파이프라인을 FastAPI로 만들었다",
    result: "예측 오차를 약 3%까지 줄였다",
  };
  if (full) Object.assign(props, { myRole: "백엔드 담당", teamSize: 2, startDate: "2024-07", endDate: "2024-12", learned: "데이터 검증을 먼저 해야 한다는 것을 배웠다" });
  return {
    person: { name: "테스트" },
    nodes: [
      node({ id: "n_res", label: "Project", props } as never),
      node({ id: "s_fastapi", label: "Skill", props: { name: "FastAPI" } }),
      node({ id: "a_err", label: "Achievement", props: { summary: "예측 오차 약 3%", metric: "오차", value: "약 3% (2주치 실제 예약과 비교)" } }),
      node({ id: "n_other", label: "Project", props: { name: "다른 프로젝트" } }),
    ],
    edges: [
      edge("WORKED_ON", PERSON_ID, "n_res"),
      ...(full ? [edge("USED_SKILL", "n_res", "s_fastapi")] : []),
      edge("ACHIEVED", "n_res", "a_err"),
      edge("WORKED_ON", PERSON_ID, "n_other"),
    ],
  } as CareerGraph;
}
