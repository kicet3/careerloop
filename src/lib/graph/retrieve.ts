/**
 * 그래프에 묻기 — 검색 단계(순수 함수): 질문 분석 → ① 후보 생성(BM25F 어휘 점수·기술 별칭·소재 태그·질문 의도 라벨) →
 * ② 그래프 확장(시드의 1~2홉 이웃) → 후보마다 리랭크용 신호를 계산한다. 점수 결합·다양화는 rerank.ts.
 * 사용자 그래프(노드 ≤ 1000) 전체를 메모리에서 다룬다 — Cypher를 쓰지 않는다. 설계·가중치·평가는 docs/GRAPH-QA.md.
 */
import { EXPERIENCE_CATEGORIES } from "@/lib/domain/experience-categories";
import {
  type CareerGraph,
  type GraphNode,
  type NodeLabel,
  NODE_TITLE_KEY,
  nodeDisplayName,
  PERSON_ID,
  type RelType,
  resolveStoryTag,
  STORY_TAG_ALIASES,
  STORY_TAGS,
  type StoryTag,
} from "@/lib/domain/graph";
import { canonicalSkill, extractKeywords, skillKey } from "@/lib/skills/dictionary";
import { hasMetric } from "./completeness";
import { anchorOf, type GraphPathStep, personPaths } from "./paths";

// ---------------------------------------------------------------------------
// 상수
// ---------------------------------------------------------------------------

/** 후보 풀 상한(사전 점수 순으로 자른다). */
export const POOL_MAX = 60;
/** 같은 라벨의 intent 라벨 시드 상한. */
export const INTENT_SEED_MAX = 20;
/** BM25 파라미터. */
const K1 = 1.2;
const B = 0.75;
/** 이전 질문 용어의 가중치(지시어 질문 "그 프로젝트 성과는?" 처리). */
export const HISTORY_WEIGHT = 0.3;
/** 한글 글자 바이그램 용어의 가중치. */
const BIGRAM_WEIGHT = 0.5;
/** 접두 일치("개선" ↔ "개선했다")의 tf 할인. */
const PREFIX_TF = 0.8;
/** 그래프 확장: 홉당 감쇠, 기술 보유·관련 관계의 추가 감쇠, achievement 질문의 성과 자식 가중치. */
const HOP1 = 0.5;
const HOP2 = 0.25;
const WEAK_REL: ReadonlySet<RelType> = new Set(["HAS_SKILL", "RELATED_TO"]);
const ACHIEVED_CHILD = 0.8;

// ---------------------------------------------------------------------------
// 질문 분석
// ---------------------------------------------------------------------------

export const QUERY_INTENTS = [
  "achievement",
  "skill",
  "leadership",
  "collaboration",
  "problem-solving",
  "challenge-failure",
  "learning",
  "career",
  "education",
  "certification",
  "project",
  "overview",
] as const;
export type QueryIntent = (typeof QUERY_INTENTS)[number];

/** 의도 단서(공백을 뺀 질문에서 부분 문자열로 찾는다). */
const INTENT_CUES: Record<QueryIntent, readonly string[]> = {
  achievement: ["성과", "결과", "수치", "개선", "효과", "%", "퍼센트", "줄였", "늘렸", "높였", "낮췄", "단축", "매출", "전환", "지표", "임팩트"],
  skill: ["기술", "스택", "언어", "프레임워크", "써본", "써봤", "다뤄", "다룰", "사용한", "사용해", "툴", "도구"],
  leadership: ["리더", "주도", "이끌", "이끈", "팀장", "리딩", "리드"],
  collaboration: ["협업", "갈등", "팀워크", "조율", "소통", "의사소통"],
  "problem-solving": ["문제", "해결", "트러블", "장애", "원인", "디버깅"],
  "challenge-failure": ["실패", "도전", "극복", "좌절"],
  learning: ["배운", "배웠", "공부", "학습", "자기개발", "자기계발"],
  career: ["경력", "회사", "재직", "직무", "직장", "몇년", "언제", "기간", "근무", "무슨일", "어떤일", "일했"],
  education: ["학교", "전공", "학력", "졸업", "대학", "학위"],
  certification: ["자격증", "토익", "어학", "점수", "자격", "오픽", "toeic", "opic"],
  project: ["프로젝트", "만들었", "만든", "개발한", "구현한", "구축한"],
  overview: ["자기소개", "요약", "전체", "정리해", "한눈에", "소개해"],
};

/** 의도 → 라벨 시드(소재 의도는 그 태그가 달린 프로젝트·경험). */
const INTENT_LABELS: Partial<Record<QueryIntent, readonly NodeLabel[]>> = {
  achievement: ["Achievement"],
  skill: ["Skill"],
  career: ["Role", "Company"],
  education: ["Education"],
  certification: ["Certification"],
  project: ["Project"],
};

/** 소재(STAR) 의도 → 태그. */
export const INTENT_TAG: Partial<Record<QueryIntent, StoryTag>> = {
  leadership: "leadership",
  collaboration: "collaboration",
  "problem-solving": "problem-solving",
  "challenge-failure": "challenge-failure",
  learning: "learning",
};

/** 다른 의도와 함께 오면 "project" 의도를 지우는, 대상 라벨이 분명한 의도. */
const TARGET_INTENTS: ReadonlySet<QueryIntent> = new Set(["achievement", "skill", "education", "certification"]);
/** 소재 태그 별칭이지만 성과 질문에서 더 자주 쓰이는 낱말(태그로 보지 않는다). */
const AMBIGUOUS_TAG_TOKENS: ReadonlySet<string> = new Set(["개선"]);

/** 조사·어미(긴 것부터 하나만 뗀다). 남는 어간이 2글자 이상일 때만. */
const PARTICLES = [
  "에서는",
  "으로는",
  "했나요",
  "인가요",
  "이랑",
  "에서",
  "으로",
  "에게",
  "한테",
  "까지",
  "부터",
  "처럼",
  "했던",
  "했어",
  "이었",
  "였어",
  "은",
  "는",
  "이",
  "가",
  "을",
  "를",
  "에",
  "로",
  "와",
  "과",
  "의",
  "도",
  "만",
  "랑",
].sort((a, b) => b.length - a.length);

const STOPWORDS = new Set([
  "무엇",
  "뭐",
  "뭘",
  "뭐야",
  "뭐였어",
  "뭐였지",
  "뭐가",
  "무슨",
  "어떤",
  "어떻게",
  "알려",
  "알려줘",
  "주세요",
  "줘",
  "있나요",
  "있어",
  "있어요",
  "있었",
  "했던",
  "경험",
  "내가",
  "나의",
  "나",
  "내",
  "저",
  "제",
  "그",
  "그거",
  "그때",
  "좀",
  "적",
  "한",
  "했어",
  "했지",
  "만들었지",
  "보여줄",
  "보여줘",
  "써",
  "본",
  "것",
  "거",
  "해줘",
  "정리해줘",
]);

const HANGUL = /^[가-힣]+$/;
const isHangul = (s: string) => HANGUL.test(s);

/** NFKC → 소문자 → 문자·숫자 밖에서 자른다. */
export function rawTokens(text: string): string[] {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}%+#]+/u)
    .filter(Boolean);
}

/** 한글 토큰 끝의 조사·어미를 하나 뗀다(어간 2글자 이상일 때만). */
export function stripParticle(token: string): string {
  if (!/[가-힣]$/.test(token)) return token;
  for (const p of PARTICLES) {
    if (token.length - p.length >= 2 && token.endsWith(p)) return token.slice(0, -p.length);
  }
  return token;
}

/** 본문 토큰(문서·질문 공통): 조사를 뗀 토큰. */
export function tokenize(text: string): string[] {
  return rawTokens(text).map(stripParticle).filter((t) => t.length > 0);
}

/** 한글 토큰(3글자 이상)의 글자 바이그램. 형태소 분석 없이 복합어("결제개선" ↔ "결제 개선")를 잡는다. */
export function hangulBigrams(token: string): string[] {
  if (!isHangul(token) || token.length < 3) return [];
  const out: string[] = [];
  for (let i = 0; i + 2 <= token.length; i++) out.push(token.slice(i, i + 2));
  return out;
}

const compact = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/|?!~]+/g, "");

export interface QueryAnalysis {
  /** 용어 → 질문 가중치(토큰 1, 바이그램 0.5, 이전 질문 0.3배). */
  terms: Map<string, number>;
  /** 바이그램 용어(문서 바이그램과 맞춘다). */
  bigrams: Map<string, number>;
  /** 질문에서 찾은 기술의 정식 명칭(skillKey). */
  skills: string[];
  /** 질문에서 찾은 소재 태그. */
  tags: StoryTag[];
  intents: QueryIntent[];
  /** 질문에 나온 연도. */
  years: number[];
}

function analyzeOne(q: string): Omit<QueryAnalysis, "terms" | "bigrams"> & { tokens: string[]; bigramList: string[] } {
  const tokens = [...new Set(tokenize(q).filter((t) => !STOPWORDS.has(t)))];
  const bigramList = [...new Set(tokens.flatMap(hangulBigrams))];
  const skills = new Set<string>(extractKeywords(q).map(skillKey));
  for (const t of rawTokens(q)) {
    const c = canonicalSkill(t) ?? canonicalSkill(stripParticle(t));
    if (c) skills.add(skillKey(c));
  }
  const flat = compact(q);
  const tags = new Set<StoryTag>();
  for (const t of tokens) {
    const tag = AMBIGUOUS_TAG_TOKENS.has(t) ? null : resolveStoryTag(t);
    if (tag) tags.add(tag);
  }
  for (const tag of STORY_TAGS) {
    // 별칭 부분 일치는 3글자 이상만(“개선”, “주도” 같은 짧은 별칭은 토큰이 같을 때만).
    if (STORY_TAG_ALIASES[tag].some((a) => compact(a).length >= 3 && flat.includes(compact(a)))) tags.add(tag);
  }
  for (const c of EXPERIENCE_CATEGORIES) {
    if (c.source === "tag" && flat.includes(compact(c.name))) tags.add(c.id as StoryTag);
  }
  let intents = QUERY_INTENTS.filter((i) => INTENT_CUES[i].some((cue) => flat.includes(cue)));
  // 질문 대상 라벨이 따로 있으면 "프로젝트"는 주어일 뿐이다("결제 개선 프로젝트 성과가 뭐였어?" → 성과를 묻는다).
  if (intents.some((i) => TARGET_INTENTS.has(i))) intents = intents.filter((i) => i !== "project");
  if (skills.size > 0 && !intents.includes("skill") && /기술|스택|써|다뤄|사용/.test(flat)) intents.push("skill");
  const years = [...new Set([...q.matchAll(/(?<!\d)((?:19|20)\d{2})(?!\d)/g)].map((m) => Number(m[1])))];
  return { tokens, bigramList, skills: [...skills], tags: [...tags], intents, years };
}

/** 질문 분석. history는 직전 사용자 질문(지시어 처리용, 가중치 HISTORY_WEIGHT). */
export function analyzeQuery(question: string, opts: { history?: string | null } = {}): QueryAnalysis {
  const cur = analyzeOne(question);
  const terms = new Map<string, number>();
  const bigrams = new Map<string, number>();
  const add = (m: Map<string, number>, k: string, w: number) => m.set(k, Math.max(m.get(k) ?? 0, w));
  for (const t of cur.tokens) add(terms, t, 1);
  for (const b of cur.bigramList) add(bigrams, b, BIGRAM_WEIGHT);
  // 정식 기술 이름도 용어로("리액트" → react): 프로젝트 설명의 "React"와 어휘로 맞는다.
  for (const s of cur.skills) for (const t of tokenize(s)) add(terms, t, 1);
  if (opts.history?.trim()) {
    const prev = analyzeOne(opts.history);
    for (const t of prev.tokens) add(terms, t, HISTORY_WEIGHT);
    for (const b of prev.bigramList) add(bigrams, b, BIGRAM_WEIGHT * HISTORY_WEIGHT);
    for (const s of prev.skills) for (const t of tokenize(s)) add(terms, t, HISTORY_WEIGHT);
  }
  return { terms, bigrams, skills: cur.skills, tags: cur.tags, intents: cur.intents, years: cur.years };
}

// ---------------------------------------------------------------------------
// 노드 필드 (BM25F)
// ---------------------------------------------------------------------------

/** 필드 가중치: 대표 이름 > 수치·역할 > 결과·행동 > 설명 > 기타. */
export const FIELD_WEIGHTS = { title: 3, primary: 2, story: 1.5, body: 1, context: 1, minor: 0.5 } as const;
type FieldGroup = keyof typeof FIELD_WEIGHTS;

const PRIMARY_KEYS = new Set(["value", "metric", "myRole", "department"]);
const STORY_KEYS = new Set(["result", "action"]);
const BODY_KEYS = new Set(["situation", "learned", "summary", "description", "industry", "kind", "organization", "major", "degree"]);
/** 텍스트로 보지 않는 속성(날짜·숫자·URL·태그). */
const SKIP_KEYS = new Set(["startDate", "endDate", "date", "current", "teamSize", "url", "categories", "category"]);

export interface NodeField {
  key: string;
  group: FieldGroup;
  text: string;
}

/** 노드의 검색 필드(필드 묶음별 텍스트). categories는 텍스트가 아니라 태그 신호로만 쓴다. */
export function nodeFields(node: GraphNode): NodeField[] {
  const titleKey = NODE_TITLE_KEY[node.label];
  const out: NodeField[] = [];
  for (const [k, v] of Object.entries(node.props as Record<string, unknown>)) {
    if (SKIP_KEYS.has(k) || typeof v !== "string" || !v.trim()) continue;
    const group: FieldGroup =
      k === titleKey
        ? "title"
        : node.label === "Achievement" && k === "summary"
          ? "title"
          : PRIMARY_KEYS.has(k)
            ? "primary"
            : STORY_KEYS.has(k)
              ? "story"
              : BODY_KEYS.has(k)
                ? "body"
                : "minor";
    out.push({ key: k, group, text: v });
  }
  return out;
}

interface IndexedField {
  group: FieldGroup;
  tokens: string[];
  bigrams: string[];
}

interface IndexedNode {
  node: GraphNode;
  fields: IndexedField[];
  /** 문서 토큰 집합(MMR 유사도용). */
  tokenSet: Set<string>;
}

/** context: 성과는 그 성과를 이룬 곳(ACHIEVED 출발 노드)의 이름을 함께 색인한다("결제 개선 성과" ↔ 성과 노드). */
function indexNode(node: GraphNode, context: readonly string[] = []): IndexedNode {
  const extra: NodeField[] = context.length ? [{ key: "context", group: "context", text: context.join(" ") }] : [];
  const fields = [...nodeFields(node), ...extra].map((f) => {
    const tokens = tokenize(f.text);
    // 문서 바이그램: 2글자 한글 토큰은 그 자체, 3글자 이상은 글자 바이그램.
    const bigrams = tokens.flatMap((t) => (isHangul(t) && t.length === 2 ? [t] : hangulBigrams(t)));
    return { group: f.group, tokens, bigrams };
  });
  return { node, fields, tokenSet: new Set(fields.flatMap((f) => f.tokens)) };
}

/** 문서 토큰 하나가 질문 용어와 맞는 정도: 같으면 1, 한글 접두 일치면 PREFIX_TF, 아니면 0. */
function termMatch(docToken: string, term: string): number {
  if (docToken === term) return 1;
  if (term.length >= 2 && isHangul(term) && docToken.startsWith(term)) return PREFIX_TF;
  return 0;
}

/**
 * BM25F 어휘 점수. 사용자 그래프의 노드 전체를 문서 집합으로 보고 IDF를 계산한다(필드 길이는 필드 묶음별 평균으로 정규화).
 * 반환: 노드 id → 점수(0이면 어휘 일치 없음).
 */
export function bm25f(indexed: readonly IndexedNode[], query: Pick<QueryAnalysis, "terms" | "bigrams">): Map<string, number> {
  const N = indexed.length;
  const avgLen = new Map<FieldGroup, number>();
  const counts = new Map<FieldGroup, { sum: number; n: number }>();
  for (const d of indexed)
    for (const f of d.fields) {
      const c = counts.get(f.group) ?? { sum: 0, n: 0 };
      c.sum += f.tokens.length;
      c.n += 1;
      counts.set(f.group, c);
    }
  for (const [g, c] of counts) avgLen.set(g, c.n ? c.sum / c.n : 1);

  const scoreFor = (terms: Map<string, number>, useBigrams: boolean) => {
    const out = new Map<string, number>();
    for (const [term, qw] of terms) {
      const tfs: { id: string; tf: number }[] = [];
      for (const d of indexed) {
        let tf = 0;
        for (const f of d.fields) {
          const list = useBigrams ? f.bigrams : f.tokens;
          let raw = 0;
          for (const t of list) raw += useBigrams ? (t === term ? 1 : 0) : termMatch(t, term);
          if (raw === 0) continue;
          const norm = 1 - B + B * (list.length / (avgLen.get(f.group) || 1));
          tf += (FIELD_WEIGHTS[f.group] * raw) / norm;
        }
        if (tf > 0) tfs.push({ id: d.node.id, tf });
      }
      if (tfs.length === 0) continue;
      const idf = Math.log(1 + (N - tfs.length + 0.5) / (tfs.length + 0.5));
      for (const { id, tf } of tfs) out.set(id, (out.get(id) ?? 0) + qw * idf * (tf / (K1 + tf)));
    }
    return out;
  };
  const lex = scoreFor(query.terms, false);
  for (const [id, s] of scoreFor(query.bigrams, true)) lex.set(id, (lex.get(id) ?? 0) + s);
  return lex;
}

// ---------------------------------------------------------------------------
// 신호
// ---------------------------------------------------------------------------

export interface CandidateSignals {
  /** BM25F 원점수(리랭커가 풀 최댓값으로 정규화). */
  lexical: number;
  /** 1 = 일치하는 기술 노드, 0.7 = 그 기술을 USED_SKILL로 쓴 노드. */
  skill: number;
  /** 소재 태그가 질문 태그와 겹치면 1. */
  tag: number;
  /** 질문 의도와 라벨이 맞으면 1, 관련 라벨이면 0.5. */
  intent: number;
  /** 그래프 확장으로 전파된 값(0~1). */
  propagated: number;
  /** 수치 성과 여부(achievement 의도 없으면 0.3배). */
  metric: number;
  /** 최근성(현재 1, 아니면 exp(-나이/4)). 질문 연도와 겹치면 1. */
  recency: number;
  /** log(1+차수)/log(1+최대 차수). */
  centrality: number;
  /** STAR 필드 채운 비율(프로젝트·경험만). */
  completeness: number;
}

export interface Candidate {
  node: GraphNode;
  name: string;
  signals: CandidateSignals;
  /** 같은 프로젝트·경험에서 나온 항목을 묶는 기준(paths.anchorOf). */
  anchorId: string;
  path: GraphPathStep[];
  /** 질문과 직접 맞은 시드인가(아니면 확장·폴백으로 들어온 것). */
  seed: boolean;
  /** 문서 토큰 집합(MMR 유사도). */
  tokens: Set<string>;
}

export interface RetrievalResult {
  query: QueryAnalysis;
  candidates: Candidate[];
  /** 시드가 없거나 overview 의도라 라벨별 층화 폴백을 썼다. */
  fallback: boolean;
  /** 경로 계산 결과(컨텍스트·출처가 다시 쓴다). */
  paths: Map<string, GraphPathStep[]>;
}

const LEADER_ROLE = /팀장|리드|리더|lead|pm|매니저|manager|파트장|대표|회장|부장/i;
const STAR_FIELDS = ["situation", "action", "result", "learned", "myRole"] as const;

function tagsOf(node: GraphNode): StoryTag[] {
  const v = (node.props as Record<string, unknown>).categories;
  return Array.isArray(v) ? (v.filter((t) => (STORY_TAGS as readonly unknown[]).includes(t)) as StoryTag[]) : [];
}

/** 연도 범위(시작·끝). current면 끝은 올해. 날짜가 없으면 null. */
function yearSpan(node: GraphNode, nowYear: number): { from: number; to: number } | null {
  const p = node.props as Record<string, unknown>;
  const y = (v: unknown) => (typeof v === "string" && /^\d{4}/.test(v) ? Number(v.slice(0, 4)) : null);
  const start = y(p.startDate) ?? y(p.date);
  const end = p.current === true ? nowYear : (y(p.endDate) ?? y(p.date) ?? start);
  if (start === null && end === null) return null;
  return { from: start ?? end!, to: end ?? start! };
}

/** 최근성: 현재 진행 1, 아니면 exp(-나이/4). 질문 연도와 기간이 겹치면 1(겹치지 않으면 0.2배). 날짜가 없으면 0.3. */
export function recencyOf(node: GraphNode, years: readonly number[], nowYear: number): number {
  const span = yearSpan(node, nowYear);
  if (years.length > 0) {
    if (!span) return 0.1;
    return years.some((yr) => yr >= span.from && yr <= span.to) ? 1 : 0.05;
  }
  if ((node.props as Record<string, unknown>).current === true) return 1;
  if (!span) return 0.3;
  return Math.exp(-Math.max(0, nowYear - span.to) / 4);
}

function intentSignal(node: GraphNode, intents: readonly QueryIntent[], usesMatchedSkill: boolean): number {
  const p = node.props as Record<string, unknown>;
  let best = 0;
  for (const intent of intents) {
    let v = 0;
    const labels = INTENT_LABELS[intent];
    if (labels?.includes(node.label)) v = 1;
    else if (intent === "achievement" && (node.label === "Project" || node.label === "Experience") && typeof p.result === "string" && p.result.trim())
      v = 0.5;
    else if (intent === "skill" && usesMatchedSkill) v = 0.5;
    else if (intent === "career" && node.label === "Project") v = 0.3;
    const tag = INTENT_TAG[intent];
    if (tag && (node.label === "Project" || node.label === "Experience")) {
      if (tagsOf(node).includes(tag)) v = Math.max(v, 1);
      else if (intent === "leadership" && typeof p.myRole === "string" && LEADER_ROLE.test(p.myRole)) v = Math.max(v, 1);
    }
    if (intent === "leadership" && node.label === "Role" && typeof p.title === "string" && LEADER_ROLE.test(p.title)) v = Math.max(v, 0.5);
    best = Math.max(best, v);
  }
  return best;
}

function metricText(node: GraphNode): string {
  const p = node.props as Record<string, unknown>;
  const s = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : "");
  if (node.label === "Achievement") return `${s("value")} ${s("summary")} ${s("metric")}`;
  return s("result");
}

// ---------------------------------------------------------------------------
// 검색
// ---------------------------------------------------------------------------

export interface RetrieveOptions {
  /** 직전 사용자 질문(지시어 처리). */
  history?: string | null;
  /** 최근성 기준 연도(테스트에서 고정). */
  nowYear?: number;
  /** 경로를 이미 계산했으면 넘긴다. */
  paths?: Map<string, GraphPathStep[]>;
  /** 색인을 이미 만들었으면 넘긴다(같은 그래프에 질의를 여러 번 할 때 — 이력서 에이전트의 요건별 검색). */
  index?: GraphIndex;
  /**
   * 질의 의도를 명시한다(질문 분석 결과와 합친다). 요건 명사구("Kafka 운영 경험 3년 이상")는 질문 문장이 아니라 의도가 비어
   * 나올 수 있어 이력서 에이전트가 ["project", "achievement"]처럼 넘긴다. 그래프 QA는 넘기지 않는다(동작 불변).
   */
  intents?: readonly QueryIntent[];
}

/** 그래프 색인(BM25F 문서·성과 맥락). 같은 그래프면 질의마다 다시 만들 필요가 없다. */
export interface GraphIndex {
  indexed: IndexedNode[];
  byId: Map<string, IndexedNode>;
}

export function buildIndex(graph: CareerGraph): GraphIndex {
  const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));
  const achievedFrom = new Map<string, string[]>();
  for (const e of graph.edges) {
    const src = nodeById.get(e.from);
    if (e.type === "ACHIEVED" && src) achievedFrom.set(e.to, [...(achievedFrom.get(e.to) ?? []), nodeDisplayName(src)]);
  }
  const indexed = graph.nodes.map((n) => indexNode(n, achievedFrom.get(n.id)));
  return { indexed, byId: new Map(indexed.map((d) => [d.node.id, d])) };
}

/** ① 후보 생성 + ② 그래프 확장 + 신호 계산. */
export function retrieve(graph: CareerGraph, question: string, opts: RetrieveOptions = {}): RetrievalResult {
  const analyzed = analyzeQuery(question, { history: opts.history });
  const query: QueryAnalysis =
    opts.intents && opts.intents.length > 0 ? { ...analyzed, intents: [...new Set([...analyzed.intents, ...opts.intents])] } : analyzed;
  const paths = opts.paths ?? personPaths(graph);
  const nowYear = opts.nowYear ?? new Date().getFullYear();
  if (graph.nodes.length === 0) return { query, candidates: [], fallback: false, paths };

  const { indexed, byId } = opts.index ?? buildIndex(graph);
  const lex = bm25f(indexed, query);
  const maxLex = Math.max(0, ...lex.values());

  // 이웃(본인 제외).
  const neighbors = new Map<string, { id: string; type: RelType; out: boolean }[]>();
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
    if (e.from === PERSON_ID || e.to === PERSON_ID) continue;
    (neighbors.get(e.from) ?? neighbors.set(e.from, []).get(e.from)!).push({ id: e.to, type: e.type, out: true });
    (neighbors.get(e.to) ?? neighbors.set(e.to, []).get(e.to)!).push({ id: e.from, type: e.type, out: false });
  }
  const maxDegree = Math.max(1, ...graph.nodes.map((n) => degree.get(n.id) ?? 0));

  // 기술 신호.
  const querySkills = new Set(query.skills);
  const skillSig = new Map<string, number>();
  for (const n of graph.nodes) {
    if (n.label !== "Skill" || !querySkills.has(skillKey(nodeDisplayName(n)))) continue;
    skillSig.set(n.id, 1);
    for (const e of graph.edges) if (e.type === "USED_SKILL" && e.to === n.id) skillSig.set(e.from, Math.max(skillSig.get(e.from) ?? 0, 0.7));
  }

  const queryTags = new Set(query.tags);
  const signalsOf = (node: GraphNode, propagated: number): CandidateSignals => {
    const p = node.props as Record<string, unknown>;
    const isStory = node.label === "Project" || node.label === "Experience";
    // 수치: 성과 질문이면 성과 노드 1·그 밖의 노드 0.5, 성과 질문이 아니면 0.3배.
    const metric = hasMetric(metricText(node)) ? (query.intents.includes("achievement") ? (node.label === "Achievement" ? 1 : 0.5) : 0.3) : 0;
    return {
      lexical: lex.get(node.id) ?? 0,
      skill: skillSig.get(node.id) ?? 0,
      tag: tagsOf(node).some((t) => queryTags.has(t)) ? 1 : 0,
      intent: intentSignal(node, query.intents, (skillSig.get(node.id) ?? 0) > 0 && node.label !== "Skill"),
      propagated,
      metric,
      recency: recencyOf(node, query.years, nowYear),
      centrality: Math.log(1 + (degree.get(node.id) ?? 0)) / Math.log(1 + maxDegree),
      completeness: isStory ? STAR_FIELDS.filter((k) => typeof p[k] === "string" && (p[k] as string).trim()).length / STAR_FIELDS.length : 0,
    };
  };

  /** 사전 점수: 시드 강도 순 정렬·자르기용(차수·최근성은 동점 깨기). */
  const prior = (s: CandidateSignals) =>
    (maxLex > 0 ? s.lexical / maxLex : 0) + s.skill + s.tag + 0.5 * s.intent + s.propagated + 0.1 * s.centrality + 0.05 * s.recency;

  // ① 시드.
  const seedStrength = new Map<string, number>();
  for (const d of indexed) {
    const n = d.node;
    const s = signalsOf(n, 0);
    const strength = Math.max(maxLex > 0 ? s.lexical / maxLex : 0, s.skill, s.tag);
    if (strength > 0) seedStrength.set(n.id, strength);
  }
  // intent 라벨 시드(라벨별 사전 점수 상위 INTENT_SEED_MAX). 소재 의도는 태그가 이미 tag 신호로 시드가 된다.
  const intentSeeds = new Map<string, number>();
  for (const intent of query.intents) {
    const labels = INTENT_LABELS[intent] ?? [];
    for (const label of labels) {
      const pool = graph.nodes
        .filter((n) => n.label === label)
        .map((n) => ({ n, p: prior(signalsOf(n, 0)) }))
        .sort((a, b) => b.p - a.p || a.n.id.localeCompare(b.n.id))
        .slice(0, INTENT_SEED_MAX);
      for (const { n } of pool) intentSeeds.set(n.id, 0.3);
    }
    const tag = INTENT_TAG[intent];
    if (tag) for (const n of graph.nodes) if (intentSignal(n, [intent], false) >= 1) seedStrength.set(n.id, Math.max(seedStrength.get(n.id) ?? 0, 0.6));
  }

  const fallback = (seedStrength.size === 0 && intentSeeds.size === 0) || query.intents.includes("overview");

  // ② 확장: 시드 강도를 이웃으로 전파(1홉 0.5, 2홉 0.25, 약한 관계 0.5배 더).
  const propagated = new Map<string, number>();
  const bump = (id: string, v: number) => {
    if (v > (propagated.get(id) ?? 0)) propagated.set(id, v);
  };
  for (const [id, s] of seedStrength) {
    for (const a of neighbors.get(id) ?? []) {
      const w1 = s * HOP1 * (WEAK_REL.has(a.type) ? 0.5 : 1);
      bump(a.id, w1);
      // achievement 질문: 시드 프로젝트·직무·경험의 성과 자식은 더 강하게.
      if (query.intents.includes("achievement") && a.type === "ACHIEVED" && a.out) bump(a.id, s * ACHIEVED_CHILD);
      for (const b of neighbors.get(a.id) ?? []) {
        if (b.id === id) continue;
        bump(b.id, s * HOP2 * (WEAK_REL.has(a.type) ? 0.5 : 1) * (WEAK_REL.has(b.type) ? 0.5 : 1));
      }
    }
  }

  const ids = new Set<string>([...seedStrength.keys(), ...intentSeeds.keys(), ...propagated.keys()]);
  if (fallback) {
    // 라벨별 층화: 이야기 단위(직무·프로젝트·경험·성과)는 3개, 나머지는 1개.
    for (const label of ["Role", "Project", "Experience", "Achievement", "Company", "Skill", "Education", "Certification"] as const) {
      const take = ["Role", "Project", "Experience", "Achievement"].includes(label) ? 3 : 1;
      graph.nodes
        .filter((n) => n.label === label)
        .map((n) => ({ n, p: prior(signalsOf(n, 0)) }))
        .sort((a, b) => b.p - a.p || a.n.id.localeCompare(b.n.id))
        .slice(0, take)
        .forEach(({ n }) => ids.add(n.id));
    }
  }

  const candidates: Candidate[] = [...ids]
    .map((id) => byId.get(id))
    .filter((d): d is IndexedNode => d !== undefined)
    .map((d) => {
      const path = paths.get(d.node.id) ?? [];
      return {
        node: d.node,
        name: nodeDisplayName(d.node),
        signals: signalsOf(d.node, propagated.get(d.node.id) ?? 0),
        anchorId: anchorOf(d.node.id, path),
        path,
        seed: seedStrength.has(d.node.id),
        tokens: d.tokenSet,
      };
    })
    .sort((a, b) => prior(b.signals) - prior(a.signals) || a.node.id.localeCompare(b.node.id))
    .slice(0, POOL_MAX);

  return { query, candidates, fallback: fallback && seedStrength.size === 0, paths };
}
