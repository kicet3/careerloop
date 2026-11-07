import "server-only";
/**
 * 근거 검색 인터페이스(v2 단계는 ctx.evidence만 부른다 — docs/RESUME-SECTION-AGENTS.md §2.2).
 * 지금 구현은 경험 그래프(graphEvidenceSource): 작업 행의 userId로 loadAgentGraph(getCareerGraph + assertGraphOwner)를 거친 그래프만
 * buildEvidencePack / expandPack에 넘긴다. 에이전틱 RAG가 준비되면 같은 인터페이스로 바꿔 끼운다(모든 nodeId가 소유 스냅숏에 있는지
 * 확인한 뒤에만 pack에 넣는 fail-closed 구현 — 이 파일 범위 밖). 프롬프트에는 E1… ref만, 실제 노드 id는 서버 pack에만 있다.
 */
import type { CareerGraph } from "@/lib/domain/graph";
import type { JdAnalysis } from "@/lib/domain/schemas";
import { buildEvidencePack, expandPack, loadAgentGraph, type BuildPackResult } from "./evidence";
import type { EvidencePack, RequirementSignal } from "./schemas";

export interface EvidenceSource {
  /** 최초 근거 묶음(E1…). 소유자 확인을 통과한 데이터만 담는다. situation 판정용으로 직무(Role) 근거가 있는지도 돌려준다. */
  build(input: { userId: string; jd: JdAnalysis; signals: readonly RequirementSignal[]; jdText: string; nowYear?: number }): Promise<BuildPackResult & { hasRole: boolean }>;
  /** 재작성 전 공백 재검색. 기존 ref 번호는 유지하고 E{n+1}…만 더한다. */
  expand(input: {
    userId: string;
    pack: EvidencePack;
    targets: readonly { requirementId: string | null; query: string }[];
    nowYear?: number;
  }): Promise<{ pack: EvidencePack; added: number; unresolved: string[]; graphChanged: boolean }>;
}

/** 경험 그래프 구현. load는 작업 행 userId로만 그래프를 읽는 함수(기본 loadAgentGraph — 테스트는 같은 형태의 가짜를 넘긴다). */
export function graphEvidenceSource(load: (job: { userId: string }) => Promise<CareerGraph> = loadAgentGraph): EvidenceSource {
  return {
    async build({ userId, jd, signals, jdText, nowYear }) {
      const graph = await load({ userId });
      const res = buildEvidencePack(graph, jd, signals, jdText, { nowYear });
      return { ...res, hasRole: graph.nodes.some((n) => n.label === "Role") };
    },
    async expand({ userId, pack, targets, nowYear }) {
      const graph = await load({ userId });
      return expandPack(graph, pack, targets, { nowYear });
    },
  };
}
