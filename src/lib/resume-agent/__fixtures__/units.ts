/**
 * 단위 테스트 공용 고정값(테스트에서만 불러온다): 작은 evidence pack·초안.
 */
import { emptyResumeDocument } from "@/lib/domain/resumes";
import type { AgentDraft, EvidenceItem, EvidencePack } from "../schemas";

export function item(ref: string, over: Partial<EvidenceItem> = {}): EvidenceItem {
  return {
    ref,
    nodeId: `n-${ref}`,
    label: "Project",
    name: `프로젝트 ${ref}`,
    path: `나 → 페이랩(회사) → 프로젝트 ${ref}(프로젝트)`,
    text: "",
    period: "",
    skills: [],
    hasMetric: false,
    completeness: 0,
    facts: null,
    ...over,
  };
}

export function pack(items: EvidenceItem[], over: Partial<EvidencePack> = {}): EvidencePack {
  return {
    version: 1,
    graphFingerprint: "fp",
    items,
    byRequirement: [],
    coverage: { mustFound: 0, mustTotal: 0, niceFound: 0, niceTotal: 0 },
    truncated: false,
    skillKeys: [],
    ...over,
  };
}

export function draft(over: Partial<AgentDraft["document"]> = {}, citations: AgentDraft["citations"] = []): AgentDraft {
  return { document: { ...emptyResumeDocument(), ...over }, citations, notes: [], missingInfo: [] };
}

export const exp = (over: Partial<AgentDraft["document"]["experience"][number]> = {}) => ({
  company: "페이랩",
  department: "",
  title: "백엔드 개발자",
  startDate: "2021.03",
  endDate: "현재",
  location: "",
  scope: "",
  bullets: [] as string[],
  ...over,
});

export const proj = (over: Partial<AgentDraft["document"]["projects"][number]> = {}) => ({
  name: "주문 시스템",
  company: "",
  team: "",
  role: "",
  startDate: "",
  endDate: "",
  summary: "",
  problem: "",
  action: "",
  result: "",
  evidence: "",
  bullets: [] as string[],
  techs: [] as string[],
  ...over,
});
