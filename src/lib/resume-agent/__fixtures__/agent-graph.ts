/**
 * 에이전트 테스트용 고정 그래프와 JD. 사용자 A: 페이랩 백엔드(주문 시스템 — Kotlin·Kafka, 캐시 개편 — Redis·AWS), 학력 1.
 * 사용자 B: 다른 사람의 그래프(격리 시험 — 이 문자열들이 A 작업의 어떤 프롬프트에도 나오면 안 된다).
 */
import { type CareerGraph, edgeId, type GraphEdge, type GraphNode, type RelType } from "@/lib/domain/graph";

const node = (n: Omit<GraphNode, "createdAt" | "updatedAt">): GraphNode => ({ ...n, createdAt: 1, updatedAt: 1 }) as GraphNode;
const edge = (type: RelType, from: string, to: string): GraphEdge => ({ id: edgeId(type, from, to), type, from, to });

export function graphA(): CareerGraph {
  return {
    person: { id: "me", name: null },
    nodes: [
      node({ id: "c1", label: "Company", props: { name: "페이랩", industry: "핀테크" } }),
      node({ id: "r1", label: "Role", props: { title: "백엔드 개발자", department: "주문플랫폼팀", startDate: "2021-03", current: true, summary: "주문·결제 서버 개발과 운영" } }),
      node({
        id: "p1",
        label: "Project",
        props: {
          name: "주문 시스템 개편",
          myRole: "백엔드 개발",
          startDate: "2022-01",
          endDate: "2022-12",
          situation: "주문 처리 지연으로 피크 시간 장애가 반복됐다",
          action: "Kotlin 서버를 Kafka 이벤트 파이프라인으로 나눠 비동기로 처리했다",
          result: "주문 처리 시간을 1200ms에서 300ms로 줄였다",
        },
      }),
      node({
        id: "p2",
        label: "Project",
        props: {
          name: "상품 캐시 개편",
          myRole: "백엔드 개발",
          startDate: "2023-02",
          endDate: "2023-06",
          situation: "상품 조회 트래픽이 DB에 몰렸다",
          action: "AWS ElastiCache 기반 Redis 캐시 계층을 설계했다",
          result: "DB 조회를 70% 줄였다",
        },
      }),
      node({ id: "a1", label: "Achievement", props: { summary: "주문 처리 시간 1200ms → 300ms", metric: "처리 시간", value: "1200ms → 300ms" } }),
      node({ id: "s_kotlin", label: "Skill", props: { name: "Kotlin" } }),
      node({ id: "s_kafka", label: "Skill", props: { name: "Kafka" } }),
      node({ id: "s_redis", label: "Skill", props: { name: "Redis" } }),
      node({ id: "s_aws", label: "Skill", props: { name: "AWS" } }),
      node({ id: "e1", label: "Education", props: { school: "한국대학교", degree: "학사", major: "컴퓨터공학" } }),
    ],
    edges: [
      edge("WORKED_AT", "me", "c1"),
      edge("HAD_ROLE", "me", "r1"),
      edge("AT_COMPANY", "r1", "c1"),
      edge("WORKED_ON", "r1", "p1"),
      edge("WORKED_ON", "r1", "p2"),
      edge("ACHIEVED", "p1", "a1"),
      edge("USED_SKILL", "p1", "s_kotlin"),
      edge("USED_SKILL", "p1", "s_kafka"),
      edge("USED_SKILL", "p2", "s_redis"),
      edge("USED_SKILL", "p2", "s_aws"),
      edge("STUDIED_AT", "me", "e1"),
    ],
  };
}

/** B의 고유 표식(격리 시험). */
export const B_MARK = "ZQXB비밀프로젝트";

export function graphB(): CareerGraph {
  return {
    person: { id: "me", name: null },
    nodes: [
      node({ id: "bc1", label: "Company", props: { name: `${B_MARK}회사` } }),
      node({ id: "br1", label: "Role", props: { title: "Kotlin Kafka Redis AWS 개발자", startDate: "2019-01", current: true } }),
      node({ id: "bp1", label: "Project", props: { name: B_MARK, action: "Kotlin Kafka Redis AWS 운영 9999건", result: "매출 8888억" } }),
    ],
    edges: [edge("HAD_ROLE", "me", "br1"), edge("AT_COMPANY", "br1", "bc1"), edge("WORKED_ON", "br1", "bp1")],
  };
}

export const AGENT_JD = ["자격 요건", "- Kotlin 기반 서버 개발 경험", "- Kafka 이벤트 파이프라인 운영 경험", "- Redis 캐시 설계 경험", "우대 사항", "- AWS 운영 경험"].join("\n");
