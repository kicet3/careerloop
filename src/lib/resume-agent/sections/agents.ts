/**
 * 본문 구역 에이전트 5개(경력·대표 프로젝트·핵심 성과·직무 역량·수상·기타)의 규칙·LLM 스키마·조각 변환·구역별 후처리(순수).
 * 지원 동기 두 에이전트(초안·추천)는 src/lib/resumes/motivation.ts(추천 버튼과 같은 모듈)에 있다.
 */
import type { z } from "zod";
import type { Effort } from "@/lib/llm/types";
import { extrasPathMapper, normalizeExtras } from "@/lib/resumes/extras-guide";
import { linePaths } from "../citations";
import type { WritingSection } from "../job-types";
import { EXTRAS_RULES } from "../prompts-v2";
import {
  LlmExperienceSectionSchema,
  LlmExtrasSectionSchema,
  LlmHighlightsSectionSchema,
  LlmProjectsSectionSchema,
  LlmSkillsSectionSchema,
  type Citation,
  type EvidencePack,
  type LlmSectionOutput,
  type SectionFragment,
} from "../schemas";
import { fragmentDoc, nearDuplicate, removeElement, pickFragment } from "./common";

export interface PostprocessContext {
  pack: EvidencePack;
  /** 다른 구역이 실제로 쓴 본문(웨이브 2·재작성). */
  others: SectionFragment;
}

export interface SectionAgentDef {
  section: WritingSection;
  wave: 1 | 2;
  schema: z.ZodType<LlmSectionOutput>;
  effort: Effort;
  maxTokens: number;
  rules: readonly string[];
  toFragment(out: LlmSectionOutput): SectionFragment;
  /** 구역별 결정적 후처리(공통 검증 뒤). */
  postprocess?(fragment: SectionFragment, citations: Citation[], ctx: PostprocessContext): { fragment: SectionFragment; citations: Citation[]; notes: string[] };
}

const COMMON_FACT = "- 이 구역 줄마다 근거 ref를 인용한다. 근거에 없는 수치·기간·역할을 쓰지 않는다(서버가 [ADD: 수치 확인]으로 바꾸거나 지운다).";

export const experienceAgent: SectionAgentDef = {
  section: "experience",
  wave: 1,
  schema: LlmExperienceSectionSchema as unknown as z.ZodType<LlmSectionOutput>,
  effort: "medium",
  maxTokens: 16_000,
  rules: [
    "- experience만 쓴다: 직무(Role) 근거로 최근 순. company·title·startDate·endDate는 근거 줄 값 그대로(서버가 근거로 덮어쓴다 — 바꾸지 않는다).",
    "- 각 회사의 앞쪽 불릿에 주 책임 must 요건을 다루는 줄을 둔다. 줄마다 행동 동사 + 결과. 항목당 줄 수는 분량 예산 안.",
    "- 다른 구역(대표 프로젝트)이 소유한 프로젝트는 '주문 시스템 개편 리드(대표 프로젝트 참조)'처럼 한 줄 이하로만 언급한다.",
    COMMON_FACT,
    '- citations: { path: "experience[0]" | "experience[0].bullets[1]", refs, requirementIds }.',
  ],
  toFragment: (out) => ({ experience: out.experience ?? [] }),
};

export const projectsAgent: SectionAgentDef = {
  section: "projects",
  wave: 1,
  schema: LlmProjectsSectionSchema as unknown as z.ZodType<LlmSectionOutput>,
  effort: "medium",
  maxTokens: 14_000,
  rules: [
    "- projects만 쓴다: 작전 지시서 include.projects 순서대로, why를 반영해 문제·행동·결과(problem·action·result)로. 기간은 근거 값 그대로(서버가 보정한다).",
    "- 프로젝트마다 대응 JD 요건을 1개 이상 citations.requirementIds에 적는다. result는 근거에 있는 결과만. techs는 근거의 '기술:'에 있는 것만.",
    COMMON_FACT,
    '- citations: { path: "projects[0]" | "projects[0].bullets[0]", refs, requirementIds }.',
  ],
  toFragment: (out) => ({ projects: out.projects ?? [] }),
};

export const highlightsAgent: SectionAgentDef = {
  section: "highlights",
  wave: 2,
  schema: LlmHighlightsSectionSchema as unknown as z.ZodType<LlmSectionOutput>,
  effort: "low",
  maxTokens: 6_000,
  rules: [
    "- highlights만 쓴다: 다른 구역이 쓴 본문 줄과 근거에 있는 결과 중 JD 요건 관점에서 가장 강한 것을 끌어올린다. 새 사실을 만들지 않는다.",
    "- 수치가 근거에 있으면 앞에('기준값 → 개선값'). 없으면 정성 결과로 쓰고 [ADD: 수치]는 넣지 않는다(notes에 '수치를 더하면 좋음').",
    "- 본문 줄을 그대로 복사하지 않는다(서버가 거의 같은 항목을 지운다). 항목마다 refs ≥ 1, requirementIds ≥ 1(주 책임 must 요건 우선).",
    '- citations: { path: "highlights[0]", refs, requirementIds }.',
  ],
  toFragment: (out) => ({ highlights: out.highlights ?? [] }),
  postprocess(fragment, citations, ctx) {
    const doc = fragmentDoc(fragment);
    let cites = citations;
    const body = linePaths(fragmentDoc(ctx.others))
      .filter((l) => /^(experience|projects)\[/.test(l.path) && l.value.trim())
      .map((l) => l.value);
    const notes: string[] = [];
    for (let i = doc.highlights.length - 1; i >= 0; i--) {
      const h = doc.highlights[i]!;
      if (body.some((b) => nearDuplicate(h.title, b))) {
        cites = removeElement(doc, cites, `highlights[${i}]`);
        notes.push(`핵심 성과 '${h.title.slice(0, 40)}'는 본문 줄과 같아 뺐습니다.`);
      }
    }
    return { fragment: pickFragment("highlights", doc), citations: cites, notes };
  },
};

export const skillsAgent: SectionAgentDef = {
  section: "skills",
  wave: 2,
  schema: LlmSkillsSectionSchema as unknown as z.ZodType<LlmSectionOutput>,
  effort: "low",
  maxTokens: 6_000,
  rules: [
    "- skills만 쓴다: category·items·detail. JD 키워드 순서를 우선하고, 다른 구역 본문에서 실제로 증명된 기술(인용된 근거의 기술)을 앞에, 그래프에만 있는 기술은 뒤에.",
    "- 기술 이름은 근거(그래프)에 있는 것만. JD에 있지만 근거가 없는 기술은 쓰지 않고 missingInfo로. detail에는 그 기술을 쓴 본문 줄의 근거 ref를 인용한다.",
    '- citations: { path: "skills[0]", refs, requirementIds }.',
  ],
  toFragment: (out) => ({ skills: out.skills ?? [] }),
};

export const extrasAgent: SectionAgentDef = {
  section: "extras",
  wave: 1,
  schema: LlmExtrasSectionSchema as unknown as z.ZodType<LlmSectionOutput>,
  effort: "low",
  maxTokens: 6_000,
  rules: EXTRAS_RULES,
  toFragment: (out) => ({ extras: out.extras ?? [], education: out.education ?? [], certifications: out.certifications ?? [] }),
  postprocess(fragment, citations, ctx) {
    // 수상·기타 묶음 규칙(빈 묶음 생략·합치기·순서·최신순). 신입 판정은 웨이브 1이라 pack에 직무(Role)가 없는지로.
    const before = fragment.extras ?? [];
    const newcomer = !ctx.pack.items.some((i) => i.label === "Role");
    const after = normalizeExtras(before, { newcomer }).extras;
    const remap = extrasPathMapper(before, after);
    const cites = citations.flatMap((c) => {
      if (!c.path.startsWith("extras[")) return [c];
      const p = remap(c.path);
      return p === null ? [] : [{ ...c, path: p }];
    });
    return { fragment: { ...fragment, extras: after }, citations: cites, notes: [] };
  },
};

export const SECTION_AGENTS: Record<WritingSection, SectionAgentDef> = {
  experience: experienceAgent,
  projects: projectsAgent,
  highlights: highlightsAgent,
  skills: skillsAgent,
  extras: extrasAgent,
};
