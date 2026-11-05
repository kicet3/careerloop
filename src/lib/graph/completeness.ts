/**
 * 경험 체크리스트(순수, 클라이언트·서버 공용): 경력 그래프가 자소서·이력서에 필요한 경험 카테고리(domain/experience-categories.ts)를
 * 최소한으로 채웠는지 판정한다. 화면의 체크리스트 패널과 그래프 채팅 프롬프트가 같은 결과를 쓴다. 규칙은 docs/EXPERIENCE-CATEGORIES.md.
 */
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import {
  EXPERIENCE_CATEGORIES,
  type ExperienceCategory,
  type ExperienceCategoryId,
  experienceCategory,
  STORY_FIELD_NAMES,
  type StoryField,
} from "@/lib/domain/experience-categories";
import { type CareerGraph, type GraphNode, type NodeLabel, nodeDisplayName, PERSON_ID, STORY_TAGS } from "@/lib/domain/graph";

/** 이 글자 수(공백 제외) 이상이면 채운 것으로 본다. "했음" 같은 값은 채운 것이 아니다. */
export const MIN_STORY_CHARS = 8;

export type CategoryState = "missing" | "partial" | "done";

/** 체크리스트에서 바로 고칠 방법: 폼으로 속성 채우기, 또는 연결 추가. */
export type CategoryFix = "edit" | "link";

export interface CategoryBest {
  nodeId: string;
  nodeName: string;
  missing: string[];
  missingFields: StoryField[];
  fix: CategoryFix;
  /** fix가 "link"일 때 이을 대상 라벨(이 밖의 대상, 특히 본인은 판정을 바꾸지 못한다). */
  linkTargets?: NodeLabel[];
}

export interface CategoryStatus {
  id: ExperienceCategoryId;
  required: boolean;
  state: CategoryState;
  /** 이 카테고리 후보 노드. */
  matchedNodeIds: string[];
  /** partial일 때 가장 덜 빠진 후보. missing은 빠진 항목의 한국어 이름, missingFields는 STAR 필드 id(해당하는 것만). */
  best?: CategoryBest;
  /** 한 줄 안내. 예: "‘물류 대시보드’에 결과(R)이(가) 없어요" */
  hint: string;
}

export interface ExperienceChecklist {
  categories: CategoryStatus[];
  requiredDone: number;
  requiredTotal: number;
  recommendedDone: number;
  recommendedTotal: number;
  /** 0~100 = round(100 * Σ필수(done=1, partial=0.5) / 필수 수) */
  progress: number;
  /** 필수 카테고리가 모두 done. */
  complete: boolean;
}

/** 성과 수치로 보지 않는 숫자: 날짜·연도·분기·학년 등(“2024년 3월 출시”, “2023 해커톤”, “2024.03”, “3학년”). */
const NON_METRIC_NUMBERS: readonly RegExp[] = [
  /(?:19|20)\d{2}\s*[.\-/]\s*\d{1,2}(?:\s*[.\-/]\s*\d{1,2})?\.?/g,
  /(?:19|20)\d{2}\s*년(?:\s*\d{1,2}\s*월)?(?:\s*\d{1,2}\s*일)?/g,
  /(?<!\d)\d{1,2}\s*월(?:\s*\d{1,2}\s*일)?/g,
  /(?<![\d.,])(?:19|20)\d{2}(?![\d.,]|\s*(?:%|％|명|건|원|개|배|회|번|점|만|천|억|시간|분|초|ms|달러|위))/g,
  /\d+\s*(?:학년|학기|분기|기수|기|차)/g,
  /\bQ[1-4]\b/gi,
];

/** 날짜·연도 같은 숫자를 빼고도 아라비아 숫자가 남으면 수치가 있는 성과로 본다. */
export function hasMetric(text: string): boolean {
  const rest = NON_METRIC_NUMBERS.reduce((t, re) => t.replace(re, " "), text);
  return /\d/.test(rest);
}

/** 공백을 뺀 길이가 MIN_STORY_CHARS 이상인 문자열. */
export function filled(v: unknown): boolean {
  return typeof v === "string" && v.replace(/\s+/g, "").length >= MIN_STORY_CHARS;
}

const present = (v: unknown) => typeof v === "string" && v.trim() !== "";
const propsOf = (n: GraphNode) => n.props as Record<string, unknown>;
const isStoryNode = (n: GraphNode) => n.label === "Project" || n.label === "Experience";

function storyFieldFilled(node: GraphNode, field: StoryField): boolean {
  const p = propsOf(node);
  switch (field) {
    case "myRole":
      return present(p.myRole);
    case "situation":
      // 기존 노드: 요약·설명이 상황을 대신한다(행동·결과는 대신하지 않는다).
      return filled(p.situation) || filled(node.label === "Project" ? p.summary : p.description);
    default:
      return filled(p[field]);
  }
}

/** 노드의 알려진 소재 분류(모르는 값은 무시). */
export function storyTagsOf(node: GraphNode): string[] {
  const c = propsOf(node).categories;
  return Array.isArray(c) ? c.filter((t): t is string => typeof t === "string" && (STORY_TAGS as readonly string[]).includes(t)) : [];
}

interface Candidate {
  node: GraphNode;
  missing: string[];
  missingFields: StoryField[];
  fix: CategoryFix;
  linkTargets?: NodeLabel[];
}

const pickBest = (cands: Candidate[]) => cands.reduce((a, b) => (b.missing.length < a.missing.length ? b : a));
const quote = (n: GraphNode) => `‘${nodeDisplayName(n)}’`;

function status(cat: ExperienceCategory, state: CategoryState, matched: GraphNode[], hint: string, best?: Candidate): CategoryStatus {
  return {
    id: cat.id,
    required: cat.required,
    state,
    matchedNodeIds: matched.map((n) => n.id),
    ...(best && state === "partial"
      ? {
          best: {
            nodeId: best.node.id,
            nodeName: nodeDisplayName(best.node),
            missing: best.missing,
            missingFields: best.missingFields,
            fix: best.fix,
            ...(best.linkTargets ? { linkTargets: best.linkTargets } : {}),
          },
        }
      : {}),
    hint,
  };
}

function partialHint(c: Candidate): string {
  return `${quote(c.node)}에 ${c.missing.join("·")}이(가) 없어요`;
}

function assessTag(cat: ExperienceCategory, graph: CareerGraph): CategoryStatus {
  const matched = graph.nodes.filter((n) => isStoryNode(n) && storyTagsOf(n).includes(cat.id));
  if (matched.length === 0) {
    if (cat.id === "learning" && graph.nodes.some((n) => n.label === "Certification")) {
      return status(cat, "partial", [], "자격증을 준비한 과정을 경험으로 남겨 보세요");
    }
    return status(cat, "missing", [], "아직 이 소재로 분류한 경험이 없어요");
  }
  const cands: Candidate[] = matched.map((node) => {
    const missingFields = cat.minFields.filter((f) => !storyFieldFilled(node, f));
    return { node, missingFields, missing: missingFields.map((f) => STORY_FIELD_NAMES[f]), fix: "edit" };
  });
  const done = cands.find((c) => c.missing.length === 0);
  if (done) return status(cat, "done", matched, `${quote(done.node)}(으)로 채웠어요`);
  const best = pickBest(cands);
  return status(cat, "partial", matched, partialHint(best), best);
}

function assessCareer(cat: ExperienceCategory, graph: CareerGraph): CategoryStatus {
  const matched = graph.nodes.filter((n) => n.label === "Role" || n.label === "Project");
  if (matched.length === 0) return status(cat, "missing", [], "회사 경력(직무)이나 프로젝트를 추가해 주세요");
  const cands: Candidate[] = matched.map((node) => {
    const p = propsOf(node);
    const missing: string[] = [];
    const missingFields: StoryField[] = [];
    if (node.label === "Role") {
      const out = graph.edges.filter((e) => e.from === node.id);
      if (!out.some((e) => e.type === "AT_COMPANY")) missing.push("회사 연결");
      if (!present(p.startDate)) missing.push("시작일");
      if (!filled(p.summary) && !out.some((e) => e.type === "WORKED_ON" || e.type === "ACHIEVED"))
        missing.push("한 일(요약 또는 프로젝트·성과 연결)");
      const fix: CategoryFix = missing.length === 1 && missing[0] === "회사 연결" ? "link" : "edit";
      return { node, missing, missingFields, fix, ...(fix === "link" ? { linkTargets: ["Company"] as NodeLabel[] } : {}) };
    }
    if (!present(p.myRole)) {
      missing.push(STORY_FIELD_NAMES.myRole);
      missingFields.push("myRole");
    }
    if (!present(p.startDate)) missing.push("시작일");
    if (!filled(p.action) && !filled(p.summary)) {
      missing.push("한 일(내 행동 또는 요약)");
      missingFields.push("action");
    }
    return { node, missing, missingFields, fix: "edit" };
  });
  const done = cands.find((c) => c.missing.length === 0);
  if (done) return status(cat, "done", matched, `${quote(done.node)}(으)로 채웠어요`);
  const best = pickBest(cands);
  return status(cat, "partial", matched, partialHint(best), best);
}

function assessQuantified(cat: ExperienceCategory, graph: CareerGraph): CategoryStatus {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const achievements = graph.nodes.filter((n) => n.label === "Achievement");
  const withResult = graph.nodes.filter((n) => isStoryNode(n) && present(propsOf(n).result));
  const matched = [...achievements, ...withResult];
  if (matched.length === 0) return status(cat, "missing", [], "숫자가 들어간 성과가 아직 없어요");

  const hasDigit = (n: GraphNode) => {
    const p = propsOf(n);
    return n.label === "Achievement"
      ? hasMetric(String(p.value ?? "")) || hasMetric(String(p.summary ?? ""))
      : hasMetric(String(p.result ?? ""));
  };
  /** 성과가 어떤 경험(Role·Project·Experience)에서 이어졌는가. */
  const linkedToStory = (a: GraphNode) =>
    graph.edges.some((e) => e.type === "ACHIEVED" && e.to === a.id && e.from !== PERSON_ID && byId.has(e.from));

  const done = withResult.find(hasDigit) ?? achievements.find((a) => hasDigit(a) && linkedToStory(a));
  if (done) return status(cat, "done", matched, `${quote(done)}에 수치가 있어요`);

  const numericUnlinked = achievements.find(hasDigit);
  if (numericUnlinked) {
    const best: Candidate = { node: numericUnlinked, missing: ["연결된 경험"], missingFields: [], fix: "link", linkTargets: ["Role", "Project", "Experience"] };
    return status(cat, "partial", matched, `${quote(numericUnlinked)}: 어떤 경험의 성과인지 연결해 주세요`, best);
  }
  const target = matched[0]!;
  const best: Candidate = {
    node: target,
    missing: ["수치"],
    missingFields: target.label === "Achievement" ? [] : ["result"],
    fix: "edit",
  };
  return status(cat, "partial", matched, `${quote(target)}: 수치(전후 값, %, 건수, 기간)를 넣어 주세요`, best);
}

/** 경력 그래프 → 경험 체크리스트. 노드 하나가 여러 카테고리를 채워도 된다(태그 상한 3개가 몰아 달기를 막는다). */
export function assessExperienceChecklist(graph: CareerGraph): ExperienceChecklist {
  const categories = EXPERIENCE_CATEGORIES.map((cat) =>
    cat.id === "career" ? assessCareer(cat, graph) : cat.id === "quantified-result" ? assessQuantified(cat, graph) : assessTag(cat, graph),
  );
  const req = categories.filter((c) => c.required);
  const rec = categories.filter((c) => !c.required);
  const score = req.reduce((s, c) => s + (c.state === "done" ? 1 : c.state === "partial" ? 0.5 : 0), 0);
  const requiredDone = req.filter((c) => c.state === "done").length;
  return {
    categories,
    requiredDone,
    requiredTotal: req.length,
    recommendedDone: rec.filter((c) => c.state === "done").length,
    recommendedTotal: rec.length,
    progress: req.length ? Math.round((100 * score) / req.length) : 100,
    complete: requiredDone === req.length,
  };
}

/** 체크리스트의 '채팅으로 채우기' 버튼이 채팅 입력에 미리 채울 문장. */
export function categoryAskMessage(s: CategoryStatus): string {
  const cat = experienceCategory(s.id);
  const text =
    s.state === "partial" && s.best
      ? `‘${s.best.nodeName}’을(를) ${cat.name} 소재로 채우고 싶어요. 빠진 ${s.best.missing.join(", ")}을(를) 물어봐 주세요.`
      : cat.chatStarter;
  return text.slice(0, MAX_CHAT_MESSAGE_CHARS);
}

const STATE_NAMES: Record<CategoryState, string> = { missing: "없음", partial: "일부", done: "완료" };

/** 그래프 채팅 프롬프트용 체크리스트 텍스트(빠진 필수 항목 먼저). 호출자가 wrapData로 감싼다(노드 이름은 사용자 입력이다). */
export function checklistToPromptText(c: ExperienceChecklist): string {
  const rank = (s: CategoryStatus) => (s.state === "done" ? 2 : 0) + (s.required ? 0 : 1);
  const sorted = [...c.categories].sort((a, b) => rank(a) - rank(b));
  const lines = sorted.map((s) => {
    const cat = experienceCategory(s.id);
    const head = `- [${s.required ? "필수" : "추천"}·${STATE_NAMES[s.state]}] ${s.id}(${cat.name})`;
    if (s.state === "done") return `${head}: ${s.hint}`;
    const min = cat.source === "tag" ? ` 최소: ${cat.minFields.join(", ")}.` : "";
    const target = s.best ? ` 보강할 노드: [${s.best.nodeId}] ${s.best.nodeName}.` : "";
    return `${head}: ${s.hint}.${min}${target} 물을 질문: ${cat.guideQuestion}`;
  });
  return [`필수 ${c.requiredDone}/${c.requiredTotal} 완료 · 추천 ${c.recommendedDone}/${c.recommendedTotal} 완료`, ...lines].join("\n");
}
