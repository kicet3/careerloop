/**
 * 후속 질문의 주제(topic) 판정과 "이미 채웠거나 이미 물은 질문" 가리기(순수 — 클라이언트·서버 공용).
 *
 * 같은 것을 다른 말로 다시 묻는 문제(예: "맡은 역할은?" → 답한 뒤 "맡으신 역할과 팀 규모는?")를 막으려고, 글자가 아니라 주제로 비교한다.
 * - followupTopicKeys: 질문 글 → 주제 키 목록(role·team·period·…, 성과 측정 기준은 수치까지 — "metric-basis:3%").
 *   한 질문이 여러 주제를 물을 수 있다("기간과 사용한 기술" → period, tech). 아무 주제도 못 읽으면 [](글자 비교만 한다).
 * - filledTopics: 프로젝트 노드(와 이어진 기술·성과·소속)에 이미 값이 있는 주제.
 * - coverOf: 새 질문의 주제가 모두 (채운 주제 ∪ 이미 답한·건너뛴 질문의 주제 ∪ 열린 질문의 주제)로 덮이면 중복이다.
 *   일부만 덮이면(예: 역할은 있고 팀 규모가 없다) 묻는다.
 * - overlayGraphOps: 적용 전 변경안(확인 대기·방금 만든 변경안)을 그래프 복사본에 얹는다 — "이미 말한 것"을 판정할 때만 쓴다(저장하지 않는다).
 */
import { type CareerGraph, type GraphEdge, type GraphNode, type GraphOp, edgeId } from "@/lib/domain/graph";
import { normalizeFollowupText } from "@/lib/domain/followups";
import { assessProjectStructure, type ProjectStructureItemId } from "@/lib/graph/project-structure";

export const FOLLOWUP_TOPICS = [
  "background",
  "role",
  "team",
  "period",
  "affiliation",
  "tech",
  "actions",
  "result",
  "metric-basis",
  "learned",
  "limitations",
  "challenge",
  "collaboration",
] as const;
export type FollowupTopic = (typeof FOLLOWUP_TOPICS)[number];

export const FOLLOWUP_TOPIC_NAMES: Record<FollowupTopic, string> = {
  background: "배경·문제",
  role: "맡은 역할",
  team: "팀 규모·구성",
  period: "기간",
  affiliation: "소속(회사·학교·동아리)",
  tech: "사용 기술",
  actions: "직접 한 일",
  result: "결과·성과",
  "metric-basis": "성과 수치의 측정 기준",
  learned: "배운 점",
  limitations: "아쉬운 점·한계",
  challenge: "어려웠던 점·문제 해결",
  collaboration: "협업·소통",
};

export function isFollowupTopic(v: string): v is FollowupTopic {
  return (FOLLOWUP_TOPICS as readonly string[]).includes(v);
}

/** 주제를 읽는 표현. 순서는 뜻이 없다(여러 개가 맞으면 모두). */
const TOPIC_PATTERNS: [FollowupTopic, RegExp][] = [
  ["background", /배경|계기|동기|시작하게|왜\s*(시작|만들|하게)|어떤\s*(상황|문제)|문제\s*(는|가|를|의식|상황)|해결하려|목표(는|가|를|였|이었|로)/],
  ["role", /역할|담당|맡(은|으신|았|아\s*서|으셨)|책임\s*(범위|영역)|포지션|기여\s*(도|비중)/],
  ["team", /팀\s*(규모|원|구성|은\s*몇|인원)|몇\s*(명|인)|인원|혼자|함께\s*(했|한|하)|\d+\s*인\s*(중|팀)|팀원|동료/],
  ["period", /기간|언제|시기|몇\s*(개월|달|주|년)|시작\s*(일|시점|했|한)|종료|끝(났|난|낸)|마감/],
  ["affiliation", /소속|어느\s*(회사|조직|학교|동아리|기관|과정|부서)|어디\s*(에서|서)\s*(진행|한|했|하)|회사·직무|동아리|부트\s*캠프|교육\s*과정/],
  ["tech", /기술(?!적)|스택|도구|툴|프레임워크|라이브러리|프로그래밍\s*언어|tech|stack/],
  // 한 일: "어떤 일을 했나요"처럼 일반적으로 묻는 표현만. "Redis 캐시는 어떻게 구현했나요?"처럼 특정 대상을 파고드는 질문은 주제로 묶지 않는다
  // (한 일을 이미 적었어도 새로 물을 수 있다 — 글 비교만).
  ["actions", /한\s*일|하신\s*일|어떤\s*일|맡은\s*일|직접\s*(한|하신)\s*(것|부분|작업)|어떤\s*작업/],
  ["result", /결과|성과|효과|임팩트|전후|개선\s*(폭|율|률|됐|되었)|수치|지표/],
  ["learned", /배운|배우|배웠|깨달|느낀\s*점|교훈|성장|달라졌|달라진/],
  ["limitations", /아쉬|한계|보완|다시\s*한다면|후회|개선할\s*점/],
  // 그래프 속성이 없는 주제(이미 물은 질문으로만 덮인다): 어려웠던 점·문제 해결, 협업·소통.
  ["challenge", /어려(웠|운|움)|힘들|트러블|난관|장애|병목|막혔|막힌|시행착오|이슈|겪(은|었|으신)/],
  ["collaboration", /협업|소통|커뮤니케이션|갈등|조율/],
];

/** 측정 기준 질문: 기준·측정 표현과 수치·지표 표현이 함께 있을 때. */
const METRIC_BASIS_RE = /기준|어떻게\s*(측정|계산|쟀|재|산출|집계|확인)|측정|산출|비교\s*대상|베이스라인|baseline|무엇\s*대비|대비/;
const METRIC_WORD_RE = /\d|수치|지표|오차|정확도|성능|정밀도|재현율|%/;

/** 수치 토큰("3%", "40분", "2배") — 측정 기준 질문을 어느 수치에 대한 것인지로 나눈다. */
function numberTokens(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(/(\d+(?:\.\d+)?)\s*(%|퍼센트|배|분|초|시간|건|명|원|ms|점)?/g)) {
    out.add(`${m[1]}${m[2] === "퍼센트" ? "%" : (m[2] ?? "")}`);
  }
  return [...out].sort();
}

const clean = (text: string) => text.normalize("NFKC").toLowerCase().replace(/\s+/g, " ");

/** 질문 글 → 주제 목록(중복 없음, FOLLOWUP_TOPICS 순). */
export function followupTopics(text: string): FollowupTopic[] {
  const t = clean(text);
  const found = new Set<FollowupTopic>();
  for (const [topic, re] of TOPIC_PATTERNS) if (re.test(t)) found.add(topic);
  if (METRIC_BASIS_RE.test(t) && METRIC_WORD_RE.test(t)) {
    // 측정 기준 질문의 "결과·수치·기간(측정 기간)"은 그 수치의 세부라 따로 세지 않는다.
    found.add("metric-basis");
    found.delete("result");
    found.delete("period");
    found.delete("actions");
  }
  // "가장 어려웠던 문제" "겪은 기술적 문제"는 배경(시작한 문제)이 아니다. "동료와 협업"은 팀 규모가 아니다.
  if (found.has("challenge")) {
    found.delete("background");
    found.delete("actions");
  }
  if (found.has("collaboration")) found.delete("team");
  return FOLLOWUP_TOPICS.filter((x) => found.has(x));
}

/**
 * 질문의 주제 키. 측정 기준은 수치까지 붙인다("metric-basis:3%" — 수치가 없으면 "metric-basis"). extra: LLM이 표시한 주제(합친다).
 */
export function followupTopicKeys(text: string, extra: readonly FollowupTopic[] = []): string[] {
  const topics = new Set<FollowupTopic>([...followupTopics(text), ...extra]);
  const keys: string[] = [];
  for (const t of FOLLOWUP_TOPICS) {
    if (!topics.has(t)) continue;
    if (t === "metric-basis") {
      const nums = numberTokens(clean(text));
      keys.push(...(nums.length ? nums.map((n) => `metric-basis:${n}`) : ["metric-basis"]));
    } else keys.push(t);
  }
  return keys;
}

const topicOfKey = (key: string) => key.split(":")[0] as FollowupTopic;

/** 키 하나가 키 집합에 덮이는가. 수치 없는 측정 기준은 수치 있는 것과도 맞는다(같은 대화 맥락의 "그 수치"). */
export function keyCovered(key: string, pool: ReadonlySet<string>): boolean {
  if (pool.has(key)) return true;
  if (topicOfKey(key) !== "metric-basis") return false;
  if (key === "metric-basis") return [...pool].some((k) => topicOfKey(k) === "metric-basis");
  return pool.has("metric-basis");
}

const present = (v: unknown) => (typeof v === "string" && v.trim() !== "") || (typeof v === "number" && Number.isFinite(v));

/** 프로젝트에 이미 값이 있는 주제. 프로젝트가 없으면 빈 집합. 측정 기준은 그래프로 판정하지 않는다(답한 질문으로만 덮인다). */
export function filledTopics(graph: CareerGraph, projectId: string): Set<FollowupTopic> {
  const out = new Set<FollowupTopic>();
  const structure = assessProjectStructure(graph, projectId);
  const project = graph.nodes.find((n) => n.id === projectId);
  if (!structure || !project) return out;
  const p = project.props as Record<string, unknown>;
  const state = (id: ProjectStructureItemId) => structure.items.find((i) => i.id === id)!.state;
  if (state("background") === "done") out.add("background");
  if (present(p.myRole)) out.add("role");
  if (present(p.teamSize)) out.add("team");
  if (present(p.startDate)) out.add("period");
  const labels = new Map(graph.nodes.map((n) => [n.id, n.label]));
  const affiliation =
    graph.edges.some((e) => e.to === projectId && e.type === "WORKED_ON" && labels.get(e.from) === "Role") ||
    graph.edges.some((e) => e.from === projectId && e.type === "PART_OF");
  if (affiliation) out.add("affiliation");
  if (state("skills") === "done") out.add("tech");
  if (state("actions") === "done") out.add("actions");
  if (state("results") === "done") out.add("result");
  if (present(p.learned)) {
    // 아쉬운 점도 learned에 넣는다(별도 속성이 없다).
    out.add("learned");
    out.add("limitations");
  }
  return out;
}

/** 이미 있는 후속 질문(같은 프로젝트) — 주제 비교용. */
export interface ExistingFollowupLike {
  id: string;
  text: string;
  status: "open" | "answered" | "skipped";
  /** 사용자가 다시 연 질문(reopened_at) — 자동 정리로 닫지 않는다. */
  pinned?: boolean;
}

export type Cover =
  /** 덮이지 않는다 — 물어도 된다. */
  | { kind: "new" }
  /** 그래프에 이미 있거나 이미 답한·건너뛴 질문이 다룬 주제뿐이다 — 묻지 않는다. */
  | { kind: "known" }
  /** 열린 질문이 같은 것을 묻는다 — 새로 만들지 않고 그 질문(sameAs)을 쓴다. */
  | { kind: "open"; sameAs: ExistingFollowupLike };

/**
 * 새 질문(text, keys)이 이미 아는 것·이미 물은 것과 겹치는지.
 * - 글이 같은 질문이 있으면 그 상태대로(open이면 그 질문, 아니면 known).
 * - 주제를 못 읽은 질문은 글 비교만 한다.
 * - 주제가 모두 (채운 주제 ∪ 답한·건너뛴 질문의 주제)면 known.
 * - 남은 주제를 (채운 주제 ∪ 답한 주제 ∪ 열린 질문 하나의 주제)가 덮으면 그 열린 질문, 여러 열린 질문을 합쳐야 덮이면 첫 열린 질문.
 */
export function coverOf(
  text: string,
  keys: readonly string[],
  filled: ReadonlySet<FollowupTopic>,
  existing: readonly ExistingFollowupLike[],
): Cover {
  const norm = normalizeFollowupText(text);
  const same = existing.find((e) => normalizeFollowupText(e.text) === norm);
  if (same) return same.status === "open" ? { kind: "open", sameAs: same } : { kind: "known" };
  if (keys.length === 0) return { kind: "new" };
  const known = new Set<string>([...filled]);
  for (const e of existing) if (e.status !== "open") for (const k of followupTopicKeys(e.text)) known.add(k);
  const rest = keys.filter((k) => !keyCovered(k, known));
  if (rest.length === 0) return { kind: "known" };
  const opens = existing.filter((e) => e.status === "open").map((e) => ({ e, keys: new Set(followupTopicKeys(e.text)) }));
  const single = opens.find((o) => rest.every((k) => keyCovered(k, o.keys)));
  if (single) return { kind: "open", sameAs: single.e };
  const union = new Set(opens.flatMap((o) => [...o.keys]));
  if (rest.every((k) => keyCovered(k, union))) {
    const first = opens.find((o) => rest.some((k) => keyCovered(k, o.keys)))!;
    return { kind: "open", sameAs: first.e };
  }
  return { kind: "new" };
}

/** 이 질문(주제 키)이 채우는 구조화 항목 — 주제가 모두 한 항목에 들고, 그 항목의 완료 조건과 같을 때만. */
const TOPIC_ITEM: Partial<Record<FollowupTopic, ProjectStructureItemId>> = {
  background: "background",
  role: "role",
  tech: "skills",
  actions: "actions",
  result: "results",
  learned: "learned",
};
export function structureItemOfTopics(keys: readonly string[]): ProjectStructureItemId | null {
  const items = new Set(keys.map((k) => TOPIC_ITEM[topicOfKey(k)] ?? null));
  if (items.size !== 1) return null;
  return [...items][0] ?? null;
}

/**
 * 적용 전 변경안을 그래프 복사본에 얹는다(판정용). prefix: 변경안마다 다른 접두사(새 노드 ref가 변경안끼리 겹치지 않게).
 * 형식·관계 규칙은 보지 않는다(이미 검증한 변경안만 넣는다). 원본 그래프는 바꾸지 않는다.
 */
export function overlayGraphOps(graph: CareerGraph, ops: readonly GraphOp[], prefix = ""): CareerGraph {
  const nodes = new Map<string, GraphNode>(graph.nodes.map((n) => [n.id, n]));
  const edges = new Map<string, GraphEdge>(graph.edges.map((e) => [e.id, e]));
  const id = (ref: string) => (ref.startsWith("new:") ? `${prefix}${ref}` : ref);
  for (const op of ops) {
    switch (op.op) {
      case "addNode":
        nodes.set(id(op.ref), { id: id(op.ref), label: op.label, props: { ...op.props }, createdAt: 0, updatedAt: 0 } as GraphNode);
        break;
      case "updateNode": {
        const n = nodes.get(op.id);
        if (!n) break;
        const props: Record<string, unknown> = { ...(n.props as Record<string, unknown>) };
        for (const [k, v] of Object.entries(op.props)) {
          if (v === null || v === "") delete props[k];
          else props[k] = v;
        }
        nodes.set(op.id, { ...n, props } as GraphNode);
        break;
      }
      case "deleteNode":
        nodes.delete(op.id);
        for (const [k, e] of edges) if (e.from === op.id || e.to === op.id) edges.delete(k);
        break;
      case "addEdge": {
        const e: GraphEdge = { id: edgeId(op.type, id(op.from), id(op.to)), type: op.type, from: id(op.from), to: id(op.to) };
        edges.set(e.id, e);
        break;
      }
      case "deleteEdge":
        edges.delete(edgeId(op.type, id(op.from), id(op.to)));
        break;
    }
  }
  return { person: graph.person, nodes: [...nodes.values()], edges: [...edges.values()] };
}

/** 정리 대상 후속 질문 한 줄(같은 프로젝트, 오래된 것부터). 자동으로 중복 처리한 행(duplicate_of)은 넣지 않는다. */
export interface ReconcileRow extends ExistingFollowupLike {
  kind: "question" | "dropped";
}

/**
 * 한 프로젝트의 열린 질문 정리 계획(순수). 질문(kind='question')만 본다 — 뺀 항목 질문은 특정 노드·값에 대한 것이라 그대로 둔다.
 * 사용자가 다시 연 질문(pinned)은 닫지 않는다(그 질문의 주제는 열린 질문으로 센다).
 * - answered: 그래프에 이미 있는 주제뿐이거나, 이미 답한 질문과 같은 글·같은 주제뿐인 열린 질문.
 * - skipped: 사용자가 건너뛴 질문과 같은 것을 묻는 열린 질문(위와 함께 덮이는 경우 포함).
 * - duplicates: 더 먼저 연 질문들이 이미 같은 것을 묻는 열린 질문(바꿔 쓴 중복) — of는 그 먼저 연 질문 id. 저장할 때 skipped + duplicate_of.
 *   중복 처리한 행은 다음 정리에서 "건너뛴 주제"로 세지 않아야 원래 열린 질문이 연쇄로 닫히지 않는다.
 */
export function planFollowupReconcile(
  rows: readonly ReconcileRow[],
  filled: ReadonlySet<FollowupTopic>,
): { answered: string[]; skipped: string[]; duplicates: { id: string; of: string }[] } {
  const questions = rows.filter((r) => r.kind === "question");
  const answeredKeys = new Set<string>(filled);
  const answeredTexts = new Set<string>();
  const closedKeys = new Set<string>(filled);
  const closedTexts = new Set<string>();
  for (const r of questions) {
    if (r.status === "open") continue;
    const keys = followupTopicKeys(r.text);
    const norm = normalizeFollowupText(r.text);
    if (r.status === "answered") {
      keys.forEach((k) => answeredKeys.add(k));
      answeredTexts.add(norm);
    }
    keys.forEach((k) => closedKeys.add(k));
    closedTexts.add(norm);
  }
  const answered: string[] = [];
  const skipped: string[] = [];
  const duplicates: { id: string; of: string }[] = [];
  /** 남긴 열린 질문(오래된 것부터). */
  const kept: { id: string; norm: string; keys: Set<string> }[] = [];
  const all = (keys: readonly string[], pool: ReadonlySet<string>) => keys.length > 0 && keys.every((k) => keyCovered(k, pool));
  for (const r of questions) {
    if (r.status !== "open") continue;
    const keys = followupTopicKeys(r.text);
    const norm = normalizeFollowupText(r.text);
    if (!r.pinned) {
      if (answeredTexts.has(norm) || all(keys, answeredKeys)) {
        answered.push(r.id);
        continue;
      }
      if (closedTexts.has(norm) || all(keys, closedKeys)) {
        skipped.push(r.id);
        continue;
      }
      const sameText = kept.find((k) => k.norm === norm);
      const pool = new Set<string>([...closedKeys, ...kept.flatMap((k) => [...k.keys])]);
      if (sameText || all(keys, pool)) {
        const of = sameText ?? kept.find((k) => keys.some((x) => keyCovered(x, k.keys)))!;
        duplicates.push({ id: r.id, of: of.id });
        continue;
      }
    }
    kept.push({ id: r.id, norm, keys: new Set(keys) });
  }
  return { answered, skipped, duplicates };
}
