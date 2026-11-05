/**
 * 그래프에 묻기 평가용 고정 그래프(docs/GRAPH-QA.md 평가 계획). 회사 2, 직무 2, 프로젝트 4, 경험 2, 성과 5, 기술 8, 학력 1, 자격증 1.
 * id는 사람이 읽기 쉽게 고정한다(골든 테스트가 id로 기대 순위를 적는다).
 */
import { type CareerGraph, edgeId, type GraphEdge, type GraphNode, type RelType } from "@/lib/domain/graph";

const node = <N extends GraphNode>(n: Omit<N, "createdAt" | "updatedAt">): GraphNode => ({ ...n, createdAt: 1, updatedAt: 1 }) as GraphNode;
const edge = (type: RelType, from: string, to: string): GraphEdge => ({ id: edgeId(type, from, to), type, from, to });

export const QA_NODES: GraphNode[] = [
  node({ id: "c_paylab", label: "Company", props: { name: "페이랩", industry: "핀테크" } }),
  node({ id: "c_nextcom", label: "Company", props: { name: "넥스트커머스", industry: "이커머스" } }),
  node({
    id: "r_backend",
    label: "Role",
    props: { title: "백엔드 개발자", department: "결제플랫폼팀", startDate: "2022-03", current: true, summary: "결제·정산 서버 개발과 운영" },
  }),
  node({
    id: "r_intern",
    label: "Role",
    props: { title: "프론트엔드 인턴", employmentType: "인턴", startDate: "2020-07", endDate: "2020-12", summary: "쇼핑몰 화면 개발" },
  }),
  node({
    id: "p_payment",
    label: "Project",
    props: {
      name: "결제 개선",
      summary: "레거시 결제 정산 배치를 Go와 Kafka로 다시 설계",
      myRole: "백엔드 리드 개발",
      startDate: "2023-01",
      endDate: "2023-09",
      situation: "월말마다 정산 배치가 6시간 넘게 걸려 다음 날 업무가 밀렸다",
      action: "배치를 이벤트 기반 스트리밍으로 바꾸고 병목 쿼리를 나눴다",
      result: "정산 시간을 6시간에서 40분으로 줄였다",
      categories: ["problem-solving"],
    },
  }),
  node({
    id: "p_dashboard",
    label: "Project",
    props: {
      name: "주문 대시보드",
      summary: "운영팀용 주문 현황 대시보드를 React와 TypeScript로 개발",
      myRole: "프론트엔드 개발",
      startDate: "2022-06",
      endDate: "2022-11",
      result: "조회 속도 2배 개선",
    },
  }),
  node({
    id: "p_shop",
    label: "Project",
    props: {
      name: "쇼핑몰 프론트 리뉴얼",
      summary: "상품 상세 화면을 React로 리뉴얼",
      myRole: "화면 개발",
      startDate: "2020-08",
      endDate: "2020-12",
    },
  }),
  node({
    id: "p_wiki",
    label: "Project",
    props: {
      name: "사내 위키 검색",
      summary: "Python과 Elasticsearch로 사내 문서 검색을 만들며 검색 랭킹을 공부했다",
      startDate: "2024-02",
      endDate: "2024-05",
      learned: "형태소 분석과 BM25를 직접 공부해 적용했다",
      categories: ["learning"],
    },
  }),
  node({
    id: "e_club",
    label: "Experience",
    props: {
      title: "개발 동아리 운영",
      kind: "동아리",
      organization: "한국대학교 코딩 동아리",
      myRole: "회장",
      startDate: "2018-03",
      endDate: "2019-02",
      situation: "신입 회원이 절반 넘게 중도 이탈했다",
      action: "스터디 조를 다시 짜고 멘토링을 도입해 팀을 이끌었다",
      result: "이탈률을 50%에서 15%로 낮췄다",
      categories: ["leadership"],
    },
  }),
  node({
    id: "e_hackathon",
    label: "Experience",
    props: {
      title: "핀테크 해커톤",
      kind: "공모전",
      startDate: "2021-05",
      endDate: "2021-05",
      myRole: "백엔드",
      situation: "디자이너와 기능 범위를 두고 의견이 갈렸다",
      action: "사용자 인터뷰 결과를 근거로 우선순위를 함께 조율했다",
      result: "팀이 대상을 받았다",
      categories: ["collaboration"],
    },
  }),
  node({ id: "a_settle", label: "Achievement", props: { summary: "결제 정산 배치 시간 단축", metric: "처리 시간", value: "6시간→40분", date: "2023-09" } }),
  node({ id: "a_fail", label: "Achievement", props: { summary: "PG 승인 실패율 감소", metric: "실패율", value: "3%→0.5%", date: "2023-09" } }),
  node({ id: "a_dash", label: "Achievement", props: { summary: "대시보드 조회 속도 개선", metric: "응답 속도", value: "2배", date: "2022-11" } }),
  node({ id: "a_cvr", label: "Achievement", props: { summary: "상세 페이지 전환율 상승", metric: "전환율", value: "12%→18%", date: "2020-12" } }),
  node({ id: "a_award", label: "Achievement", props: { summary: "핀테크 해커톤 대상 수상", value: "대상", date: "2021-05" } }),
  node({ id: "s_go", label: "Skill", props: { name: "Go", category: "language" } }),
  node({ id: "s_kafka", label: "Skill", props: { name: "Kafka", category: "tool" } }),
  node({ id: "s_react", label: "Skill", props: { name: "React", category: "framework" } }),
  node({ id: "s_ts", label: "Skill", props: { name: "TypeScript", category: "language" } }),
  node({ id: "s_python", label: "Skill", props: { name: "Python", category: "language" } }),
  node({ id: "s_es", label: "Skill", props: { name: "Elasticsearch", category: "tool" } }),
  node({ id: "s_aws", label: "Skill", props: { name: "AWS", category: "tool" } }),
  node({ id: "s_comm", label: "Skill", props: { name: "커뮤니케이션", category: "soft" } }),
  node({ id: "ed_univ", label: "Education", props: { school: "한국대학교", degree: "학사", major: "컴퓨터공학", endDate: "2021-02", status: "졸업" } }),
  node({ id: "cert_eip", label: "Certification", props: { name: "정보처리기사", issuer: "한국산업인력공단", date: "2021-06" } }),
];

export const QA_EDGES: GraphEdge[] = [
  edge("WORKED_AT", "me", "c_paylab"),
  edge("WORKED_AT", "me", "c_nextcom"),
  edge("HAD_ROLE", "me", "r_backend"),
  edge("HAD_ROLE", "me", "r_intern"),
  edge("AT_COMPANY", "r_backend", "c_paylab"),
  edge("AT_COMPANY", "r_intern", "c_nextcom"),
  edge("WORKED_ON", "r_backend", "p_payment"),
  edge("WORKED_ON", "r_backend", "p_dashboard"),
  edge("WORKED_ON", "r_backend", "p_wiki"),
  edge("WORKED_ON", "r_intern", "p_shop"),
  edge("HAS_EXPERIENCE", "me", "e_club"),
  edge("HAS_EXPERIENCE", "me", "e_hackathon"),
  edge("ACHIEVED", "p_payment", "a_settle"),
  edge("ACHIEVED", "p_payment", "a_fail"),
  edge("ACHIEVED", "p_dashboard", "a_dash"),
  edge("ACHIEVED", "p_shop", "a_cvr"),
  edge("ACHIEVED", "e_hackathon", "a_award"),
  edge("USED_SKILL", "p_payment", "s_go"),
  edge("USED_SKILL", "p_payment", "s_kafka"),
  edge("USED_SKILL", "p_dashboard", "s_react"),
  edge("USED_SKILL", "p_dashboard", "s_ts"),
  edge("USED_SKILL", "p_shop", "s_react"),
  edge("USED_SKILL", "p_wiki", "s_python"),
  edge("USED_SKILL", "p_wiki", "s_es"),
  edge("HAS_SKILL", "me", "s_aws"),
  edge("HAS_SKILL", "me", "s_comm"),
  edge("USED_SKILL", "e_hackathon", "s_comm"),
  edge("STUDIED_AT", "me", "ed_univ"),
  edge("EARNED", "me", "cert_eip"),
];

export function qaGraph(): CareerGraph {
  return { person: { id: "me", name: "홍길동" }, nodes: structuredClone(QA_NODES), edges: structuredClone(QA_EDGES) };
}

/** 최근성 기준 연도(테스트 고정). */
export const QA_NOW_YEAR = 2026;
