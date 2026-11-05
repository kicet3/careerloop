/**
 * 공고 요구 기술 ↔ 경력 그래프 대조(순수 모듈 — 클라이언트에서 타입을 가져다 쓸 수 있다).
 *
 * 상태:
 * - proven(증명됨): 직무·프로젝트·경험이 USED_SKILL로 그 기술을 썼다. 그 노드의 ACHIEVED 성과를 함께 보인다.
 * - claimed(보유만): 그래프에 그 기술(Skill)은 있지만 어떤 경력도 USED_SKILL로 잇지 않았다(HAS_SKILL만 있거나 홀로 있음).
 * - missing(없음): 그래프에 같은 기술이 없다.
 * 같은 기술인지는 skillKey(사전 정식 명칭, 없으면 압축 키)로 본다 — "리액트" 스킬은 공고의 "React"를 채운다.
 */
import type { JdAnalysis } from "@/lib/domain/schemas";
import { type CareerGraph, type GraphNode, nodeDisplayName } from "@/lib/domain/graph";
import { canonicalSkill, extractKeywordHits, extractKeywords, skillKey } from "@/lib/skills/dictionary";

export type RequirementImportance = "must" | "nice" | "keyword";
/** diagnosis = 연결된 진단의 JD 분석, keywords = 공고 본문 사전 추출, none = 요구 기술을 찾지 못함. */
export type RequirementSource = "diagnosis" | "keywords" | "none";
export type MatchStatus = "proven" | "claimed" | "missing";

export const MATCH_STATUS_LABELS: Record<MatchStatus, string> = {
  proven: "경력으로 증명됨",
  claimed: "보유만 표시",
  missing: "그래프에 없음",
};
export const IMPORTANCE_LABELS: Record<RequirementImportance, string> = {
  must: "필수",
  nice: "우대",
  keyword: "언급",
};

export interface SkillRequirement {
  /** 비교 키(skillKey). */
  key: string;
  /** 화면 표시 이름(사전 정식 명칭 또는 원문 표기). */
  name: string;
  importance: RequirementImportance;
  /** 근거 문장(진단 요건 문장 또는 본문 줄). 없으면 null. */
  evidence: string | null;
}

export interface RequirementsResult {
  source: RequirementSource;
  requirements: SkillRequirement[];
}

/** 대조할 요구 기술 상한 — 키워드가 지나치게 많은 공고에서 화면이 넘치지 않게. */
export const MAX_REQUIREMENTS = 40;
const MAX_RAW_KEYWORD = 40;
const MAX_EVIDENCE = 160;
const IMPORTANCE_RANK: Record<RequirementImportance, number> = { must: 0, nice: 1, keyword: 2 };

function clip(text: string, max = MAX_EVIDENCE): string {
  const t = text.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** 같은 기술은 한 줄로(더 높은 중요도·먼저 나온 근거 유지), 중요도 순으로 정렬해 상한까지. */
function dedupe(reqs: SkillRequirement[]): SkillRequirement[] {
  const byKey = new Map<string, SkillRequirement>();
  for (const r of reqs) {
    const prev = byKey.get(r.key);
    if (!prev) byKey.set(r.key, r);
    else if (IMPORTANCE_RANK[r.importance] < IMPORTANCE_RANK[prev.importance]) byKey.set(r.key, { ...r, evidence: r.evidence ?? prev.evidence });
  }
  // 안정 정렬: 같은 중요도 안에서는 처음 나온 순서.
  return [...byKey.values()].sort((a, b) => IMPORTANCE_RANK[a.importance] - IMPORTANCE_RANK[b.importance]).slice(0, MAX_REQUIREMENTS);
}

function fromAnalysis(jd: JdAnalysis): SkillRequirement[] {
  const out: SkillRequirement[] = [];
  const fromList = (list: JdAnalysis["mustHave"], importance: RequirementImportance) => {
    for (const req of list) {
      for (const label of extractKeywords(req.text, req.jdQuote ?? "")) {
        out.push({ key: label, name: label, importance, evidence: clip(req.jdQuote || req.text) });
      }
    }
  };
  fromList(jd.mustHave, "must");
  fromList(jd.niceToHave, "nice");
  // ATS 키워드는 LLM이 고른 핵심 용어다. 사전에 있으면 정식 명칭, 없으면 짧은 원문 그대로 둔다.
  for (const raw of jd.keywords) {
    const kw = raw.trim();
    if (!kw) continue;
    const canonical = canonicalSkill(kw);
    if (canonical) {
      out.push({ key: canonical, name: canonical, importance: "keyword", evidence: null });
      continue;
    }
    // "Python과 Django" 같은 묶음은 사전 키워드로 나눈다.
    const inside = extractKeywords(kw);
    if (inside.length > 0) {
      for (const label of inside) out.push({ key: label, name: label, importance: "keyword", evidence: null });
    } else if (kw.length <= MAX_RAW_KEYWORD) {
      out.push({ key: skillKey(kw), name: kw, importance: "keyword", evidence: null });
    }
  }
  return out;
}

/**
 * 본문 머리글(줄 맨 앞, 글머리 기호 허용). 마지막으로 지난 머리글이 그 키워드의 중요도를 정한다(머리글 전은 '언급').
 * 줄 중간의 "경력자 우대"는 머리글로 보지 않는다.
 */
const BULLET = "^[\\s#*•■□▶▷◆◇▪●○※\\-\\[【<(]*";
const SECTION_HEADINGS: { re: RegExp; importance: RequirementImportance }[] = [
  {
    re: new RegExp(`${BULLET}(자격\\s*(요건|사항|조건)|필수\\s*(요건|사항|역량)|지원\\s*자격|minimum qualifications|requirements|must[\\s-]+have)`, "gim"),
    importance: "must",
  },
  { re: new RegExp(`${BULLET}(우대\\s*(사항|조건|요건|역량)?|preferred|nice[\\s-]+to[\\s-]+have|bonus points)`, "gim"), importance: "nice" },
];

function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const end = text.indexOf("\n", index);
  return text.slice(start, end === -1 ? undefined : end);
}

function fromText(jdText: string): SkillRequirement[] {
  const marks = SECTION_HEADINGS.flatMap(({ re, importance }) => [...jdText.matchAll(re)].map((m) => ({ at: m.index, importance })));
  marks.sort((a, b) => a.at - b.at);
  return extractKeywordHits(jdText).map((hit) => {
    let importance: RequirementImportance = "keyword";
    for (const m of marks) {
      if (m.at > hit.index) break;
      importance = m.importance;
    }
    return { key: hit.label, name: hit.label, importance, evidence: clip(lineAt(jdText, hit.index)) };
  });
}

/**
 * 공고의 요구 기술 목록. 연결된 진단의 JD 분석(jd 단계 출력)이 있으면 그것을 쓰고, 없거나(또는 JD 없이 추정한 분석인데
 * 지금은 본문이 있으면) 비어 있으면 공고 본문에서 사전으로 뽑는다.
 */
export function requirementsFromJd(jd: JdAnalysis | null, jdText: string | null | undefined): RequirementsResult {
  const text = (jdText ?? "").trim();
  if (jd && !(jd.source === "inferred" && text)) {
    const reqs = dedupe(fromAnalysis(jd));
    if (reqs.length > 0) return { source: "diagnosis", requirements: reqs };
  }
  if (text) {
    const reqs = dedupe(fromText(text));
    if (reqs.length > 0) return { source: "keywords", requirements: reqs };
  }
  return { source: "none", requirements: [] };
}

// ---------------------------------------------------------------------------
// 그래프 대조
// ---------------------------------------------------------------------------

type ProofLabel = "Role" | "Project" | "Experience";
const PROOF_LABELS: readonly string[] = ["Role", "Project", "Experience"] satisfies ProofLabel[];

export interface MatchNodeRef {
  id: string;
  label: ProofLabel;
  name: string;
}
export interface MatchAchievement {
  id: string;
  summary: string;
  /** 이 성과를 낸 노드(provenBy 중 하나)의 id. */
  byId: string;
}

export interface RequirementMatch extends SkillRequirement {
  status: MatchStatus;
  /** 대응한 그래프 Skill 노드(표기가 다른 같은 기술이 여럿일 수 있다). */
  skills: { id: string; name: string }[];
  provenBy: MatchNodeRef[];
  achievements: MatchAchievement[];
}

export interface MatchSummary {
  total: number;
  proven: number;
  claimed: number;
  missing: number;
}

export interface GraphMatchResult {
  items: RequirementMatch[];
  summary: MatchSummary;
}

const MAX_PROOFS = 6;
const MAX_ACHIEVEMENTS = 4;

function achievementText(node: GraphNode): string {
  if (node.label !== "Achievement") return nodeDisplayName(node);
  const p = node.props;
  const metric = [p.metric, p.value].filter(Boolean).join(" ");
  return metric ? `${p.summary} (${metric})` : p.summary;
}

export function matchGraphToRequirements(graph: CareerGraph, reqs: SkillRequirement[]): GraphMatchResult {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  // 기술 키 → 그 키의 Skill 노드들
  const skillsByKey = new Map<string, GraphNode[]>();
  for (const n of graph.nodes) {
    if (n.label !== "Skill") continue;
    const key = skillKey(n.props.name);
    skillsByKey.set(key, [...(skillsByKey.get(key) ?? []), n]);
  }
  // Skill id → 그 기술을 쓴 직무·프로젝트·경험 id / 노드 id → 성과 id
  const usedBy = new Map<string, string[]>();
  const achievedBy = new Map<string, string[]>();
  for (const e of graph.edges) {
    if (e.type === "USED_SKILL" && PROOF_LABELS.includes(nodes.get(e.from)?.label ?? "")) {
      usedBy.set(e.to, [...(usedBy.get(e.to) ?? []), e.from]);
    } else if (e.type === "ACHIEVED" && nodes.get(e.to)?.label === "Achievement") {
      achievedBy.set(e.from, [...(achievedBy.get(e.from) ?? []), e.to]);
    }
  }

  const items = reqs.map((req): RequirementMatch => {
    const skillNodes = skillsByKey.get(req.key) ?? [];
    const proofIds = [...new Set(skillNodes.flatMap((s) => usedBy.get(s.id) ?? []))];
    const provenBy = proofIds
      .map((id) => nodes.get(id))
      .filter((n): n is GraphNode => Boolean(n))
      .slice(0, MAX_PROOFS)
      .map((n) => ({ id: n.id, label: n.label as ProofLabel, name: nodeDisplayName(n) }));
    const achievements: MatchAchievement[] = [];
    const seen = new Set<string>();
    for (const p of provenBy) {
      for (const aid of achievedBy.get(p.id) ?? []) {
        const a = nodes.get(aid);
        if (!a || seen.has(aid) || achievements.length >= MAX_ACHIEVEMENTS) continue;
        seen.add(aid);
        achievements.push({ id: aid, summary: achievementText(a), byId: p.id });
      }
    }
    const status: MatchStatus = provenBy.length > 0 ? "proven" : skillNodes.length > 0 ? "claimed" : "missing";
    return {
      ...req,
      status,
      skills: skillNodes.map((s) => ({ id: s.id, name: nodeDisplayName(s) })),
      provenBy,
      achievements,
    };
  });

  const count = (s: MatchStatus) => items.filter((i) => i.status === s).length;
  return { items, summary: { total: items.length, proven: count("proven"), claimed: count("claimed"), missing: count("missing") } };
}

// ---------------------------------------------------------------------------
// 여러 공고의 스킬 갭
// ---------------------------------------------------------------------------

export interface SkillGapRowInput {
  postingId: string;
  company: string;
  roleTitle: string;
  items: Pick<RequirementMatch, "key" | "name" | "importance" | "status">[];
}

export interface SkillGapItem {
  key: string;
  name: string;
  /** 이 기술을 요구하지만 그래프에 없는 공고 수. */
  postings: number;
  /** 그중 필수로 요구한 공고 수. */
  mustCount: number;
  /** 예시 공고(최대 3개, 입력 순서 = 최근 갱신 순). */
  examples: { postingId: string; company: string; roleTitle: string }[];
}

const MAX_EXAMPLES = 3;

/** 공고별 대조 결과에서 '없음'만 모아 기술별로 센다. 많은 공고 → 필수 많은 순 → 이름 순. */
export function aggregateSkillGap(rows: SkillGapRowInput[], limit = 20): SkillGapItem[] {
  const byKey = new Map<string, SkillGapItem>();
  for (const row of rows) {
    const counted = new Set<string>();
    for (const item of row.items) {
      if (item.status !== "missing" || counted.has(item.key)) continue;
      counted.add(item.key);
      const gap = byKey.get(item.key) ?? { key: item.key, name: item.name, postings: 0, mustCount: 0, examples: [] };
      gap.postings += 1;
      if (item.importance === "must") gap.mustCount += 1;
      if (gap.examples.length < MAX_EXAMPLES) gap.examples.push({ postingId: row.postingId, company: row.company, roleTitle: row.roleTitle });
      byKey.set(item.key, gap);
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.postings - a.postings || b.mustCount - a.mustCount || a.name.localeCompare(b.name, "ko"))
    .slice(0, Math.max(0, limit));
}

// ---------------------------------------------------------------------------
// API 응답
// ---------------------------------------------------------------------------

/** GET /api/postings/[id]/match */
export interface PostingMatchResponse extends GraphMatchResult {
  postingId: string;
  company: string;
  roleTitle: string;
  source: RequirementSource;
  /** source가 diagnosis일 때 그 진단 id. */
  diagnosisId: string | null;
  /** 그래프에 노드가 하나도 없음(모두 '없음'으로 나오는 이유 안내용). */
  graphEmpty: boolean;
}

/** GET /api/insights/skills */
export interface SkillGapResponse {
  items: SkillGapItem[];
  /** 대조한 공고 수(마감 제외, 최근 갱신 50개 중 요구 기술을 찾은 공고). */
  postingsConsidered: number;
  graphEmpty: boolean;
}

/** 없음 항목을 그래프 채팅으로 보낼 때 미리 채울 문장. */
export function graphChatPrompt(skill: string, context?: { company?: string; roleTitle?: string }): string {
  const where = context?.company ? ` (${[context.company, context.roleTitle].filter(Boolean).join(" · ")} 공고에서 요구)` : "";
  return `'${skill}'${where}을(를) 써 본 경험을 정리하고 싶어요. 어느 직무나 프로젝트에서 어떻게 썼는지 물어봐 주세요.`;
}
