/**
 * 경험 그래프 편집 화면의 순수 도우미: 라벨별 입력 필드, 폼 값 → GraphOp, 연결 가능한 관계 계산, 표시용 문구.
 * 서버 검증(GraphOpSchema·applyGraphOps)이 최종 판단이고, 여기서는 사용자가 틀린 값을 보내기 전에 알려 주는 정도다.
 */
import { z } from "zod";
import {
  type CareerGraph,
  type EndpointLabel,
  type GraphEdge,
  type GraphNode,
  type GraphOp,
  GraphOpSchema,
  isAllowedEdge,
  MAX_STORY_TAGS,
  NODE_PROP_SCHEMAS,
  NODE_TITLE_KEY,
  type NodeLabel,
  nodeDisplayName,
  PERSON_ID,
  REL_RULES,
  REL_TYPES,
  type RelType,
  SKILL_CATEGORIES,
  STORY_TAGS,
} from "@/lib/domain/graph";
import { storyTagName } from "@/lib/domain/experience-categories";

// ---------------------------------------------------------------------------
// 입력 필드
// ---------------------------------------------------------------------------

export type FieldKind = "text" | "textarea" | "date" | "number" | "boolean" | "select" | "url" | "tags";

export interface FieldSpec {
  key: string;
  label: string;
  kind: FieldKind;
  required: boolean;
  options?: { value: string; label: string }[];
  placeholder?: string;
  /** "story": 자소서 소재(STAR) 소제목 아래로 모아 보인다. */
  group?: "story";
  /** tags: 고를 수 있는 최대 개수. */
  maxItems?: number;
}

const PROP_LABELS: Record<string, string> = {
  name: "이름",
  industry: "업종",
  location: "위치",
  description: "설명",
  url: "링크",
  title: "제목",
  department: "부서",
  employmentType: "고용 형태",
  startDate: "시작",
  endDate: "종료",
  current: "현재 진행 중",
  summary: "요약",
  myRole: "내 역할",
  teamSize: "팀 규모(명)",
  kind: "종류",
  organization: "기관",
  category: "분류",
  level: "숙련도",
  metric: "지표",
  value: "결과·수치",
  date: "날짜",
  school: "학교",
  degree: "학위",
  major: "전공",
  status: "상태",
  issuer: "발급 기관",
  score: "점수·등급",
  situation: "상황·목표(S·T)",
  action: "내 행동(A)",
  result: "결과(R)",
  learned: "배운 점",
  categories: "자소서 소재 분류",
};

/** 자소서 소재(STAR) 묶음에 들어가는 키. */
const STORY_KEYS = new Set(["situation", "action", "result", "learned", "categories"]);

/** 라벨마다 뜻이 달라지는 키(대표 키 위주). */
const PROP_LABEL_OVERRIDES: Partial<Record<NodeLabel, Record<string, string>>> = {
  Company: { name: "회사명" },
  Role: { title: "직함", current: "현재 재직 중" },
  Project: { name: "프로젝트명" },
  Experience: { title: "활동명" },
  Skill: { name: "기술명" },
  Achievement: { summary: "성과 내용" },
  Certification: { name: "자격증·시험명" },
};

const SKILL_CATEGORY_LABELS: Record<(typeof SKILL_CATEGORIES)[number], string> = {
  language: "언어",
  framework: "프레임워크",
  tool: "도구",
  domain: "도메인 지식",
  soft: "소프트 스킬",
  other: "기타",
};

const TEXTAREA_KEYS = new Set(["description", "summary", "situation", "action", "result", "learned"]);

/** tags 값(폼): STORY_TAGS 순서로 정렬한 id를 쉼표로 이은 문자열. */
function joinTags(v: unknown): string {
  if (!Array.isArray(v)) return "";
  const set = new Set(v.map(String));
  return STORY_TAGS.filter((t) => set.has(t)).join(",");
}

/** 폼의 tags 문자열 → id 배열(정렬, 중복 제거). */
export function splitTags(s: string): string[] {
  return joinTags(s.split(",").map((x) => x.trim()).filter(Boolean)).split(",").filter(Boolean);
}

export function propLabel(label: NodeLabel, key: string): string {
  return PROP_LABEL_OVERRIDES[label]?.[key] ?? PROP_LABELS[key] ?? key;
}

/** 라벨의 속성 스키마에서 입력 필드 목록을 만든다(대표 키가 맨 앞). */
export function fieldsFor(label: NodeLabel): FieldSpec[] {
  const shape = NODE_PROP_SCHEMAS[label].shape as Record<string, z.ZodType>;
  const titleKey = NODE_TITLE_KEY[label];
  const keys = [titleKey, ...Object.keys(shape).filter((k) => k !== titleKey)];
  return keys.map((key) => {
    const schema = shape[key]!;
    const required = !(schema instanceof z.ZodOptional);
    const inner = schema instanceof z.ZodOptional ? (schema.unwrap() as z.ZodType) : schema;
    const spec: FieldSpec = { key, label: propLabel(label, key), kind: "text", required };
    if (STORY_KEYS.has(key)) spec.group = "story";
    if (inner instanceof z.ZodArray) {
      spec.kind = "tags";
      const el = inner.element as z.ZodType;
      spec.options = el instanceof z.ZodEnum ? (el.options as string[]).map((v) => ({ value: v, label: storyTagName(v) })) : [];
      spec.maxItems = MAX_STORY_TAGS;
    } else if (inner instanceof z.ZodBoolean) spec.kind = "boolean";
    else if (inner instanceof z.ZodNumber) spec.kind = "number";
    else if (inner instanceof z.ZodEnum) {
      spec.kind = "select";
      spec.options = (inner.options as string[]).map((v) => ({
        value: v,
        label: label === "Skill" && key === "category" ? SKILL_CATEGORY_LABELS[v as keyof typeof SKILL_CATEGORY_LABELS] : v,
      }));
    } else if (key === "date" || key.endsWith("Date")) {
      spec.kind = "date";
      spec.placeholder = "예: 2023-04";
    } else if (key === "url") {
      spec.kind = "url";
      spec.placeholder = "https://";
    } else if (TEXTAREA_KEYS.has(key)) spec.kind = "textarea";
    const desc = inner.description;
    if (!spec.placeholder && desc && (spec.kind === "text" || spec.kind === "textarea")) spec.placeholder = desc;
    return spec;
  });
}

export type FormValues = Record<string, string | boolean>;

/** 노드 속성 → 폼 값(없는 키는 빈 값). */
export function formValuesFrom(label: NodeLabel, props: Record<string, unknown> = {}): FormValues {
  const values: FormValues = {};
  for (const f of fieldsFor(label)) {
    const v = props[f.key];
    values[f.key] = f.kind === "boolean" ? v === true : f.kind === "tags" ? joinTags(v) : v === undefined || v === null ? "" : String(v);
  }
  return values;
}

function toPropValue(f: FieldSpec, raw: string | boolean): unknown {
  if (f.kind === "boolean") return raw === true;
  const s = String(raw).trim();
  if (f.kind === "tags") return splitTags(s);
  if (f.kind === "number") {
    const n = Number(s);
    return Number.isFinite(n) ? n : s;
  }
  return s;
}

const isEmpty = (f: FieldSpec, raw: string | boolean | undefined) =>
  raw === undefined ||
  (f.kind === "boolean" ? raw !== true : f.kind === "tags" ? splitTags(String(raw)).length === 0 : String(raw).trim() === "");

/** zod 이슈를 필드 이름이 들어간 한 줄로. */
function issueMessage(label: NodeLabel, err: z.ZodError): string {
  for (const issue of err.issues) {
    const key = issue.path.find((p): p is string => typeof p === "string" && p !== "props" && p !== "op");
    if (key && key in NODE_PROP_SCHEMAS[label].shape) {
      const f = fieldsFor(label).find((x) => x.key === key);
      const hint = f?.kind === "date" ? " (YYYY, YYYY-MM, YYYY-MM-DD)" : f?.kind === "url" ? " (http(s) 주소)" : "";
      return `${propLabel(label, key)}: 값이 올바르지 않습니다${hint}.`;
    }
  }
  // 유니온 오류는 경로가 비어 있을 수 있다(필드 값은 checkProps가 먼저 걸러 여기까지 오는 일은 드물다).
  return "입력값을 확인해 주세요.";
}

function checkProps(label: NodeLabel, props: Record<string, unknown>): string | null {
  const shape = NODE_PROP_SCHEMAS[label].shape as Record<string, z.ZodType>;
  for (const [key, value] of Object.entries(props)) {
    if (value === null) continue;
    const r = shape[key]?.safeParse(value);
    if (r && !r.success) return issueMessage(label, new z.ZodError(r.error.issues.map((i) => ({ ...i, path: [key, ...i.path] }))));
  }
  return null;
}

export type OpsResult = { ok: true; ops: GraphOp[] } | { ok: false; error: string };

/** 새 노드를 만드는 임시 ref. 한 변경안 안에서만 쓰인다. */
export const NEW_NODE_REF = "new:node";

/** 노드 추가(+ 선택한 연결 1개) 변경안. link의 from/to 중 하나는 NEW_NODE_REF. */
export function buildAddNodeOps(label: NodeLabel, values: FormValues, link?: { type: RelType; from: string; to: string } | null): OpsResult {
  const props: Record<string, unknown> = {};
  for (const f of fieldsFor(label)) {
    if (isEmpty(f, values[f.key])) {
      if (f.required) return { ok: false, error: `${f.label}을(를) 입력해 주세요.` };
      continue;
    }
    props[f.key] = toPropValue(f, values[f.key]!);
  }
  const bad = checkProps(label, props);
  if (bad) return { ok: false, error: bad };
  const ops: unknown[] = [{ op: "addNode", ref: NEW_NODE_REF, label, props }];
  if (link) ops.push({ op: "addEdge", ...link });
  return parseOps(label, ops);
}

/** 바뀐 키만 담은 updateNode. 비운 값은 null(속성 삭제). 바뀐 것이 없으면 오류. */
export function buildUpdateNodeOps(node: GraphNode, values: FormValues): OpsResult {
  const before = formValuesFrom(node.label, node.props as Record<string, unknown>);
  const props: Record<string, unknown> = {};
  for (const f of fieldsFor(node.label)) {
    const next = values[f.key];
    if (next === undefined) continue;
    const same =
      f.kind === "boolean"
        ? (next === true) === (before[f.key] === true)
        : f.kind === "tags"
          ? splitTags(String(next)).join(",") === String(before[f.key])
          : String(next).trim() === String(before[f.key]).trim();
    if (same) continue;
    if (isEmpty(f, next)) {
      if (f.required) return { ok: false, error: `${f.label}은(는) 비울 수 없습니다.` };
      props[f.key] = null;
    } else props[f.key] = toPropValue(f, next);
  }
  if (Object.keys(props).length === 0) return { ok: false, error: "바뀐 내용이 없습니다." };
  const bad = checkProps(node.label, props);
  if (bad) return { ok: false, error: bad };
  return parseOps(node.label, [{ op: "updateNode", id: node.id, label: node.label, props }]);
}

function parseOps(label: NodeLabel, ops: unknown[]): OpsResult {
  const parsed: GraphOp[] = [];
  for (const o of ops) {
    const r = GraphOpSchema.safeParse(o);
    if (!r.success) return { ok: false, error: issueMessage(label, r.error) };
    parsed.push(r.data);
  }
  return { ok: true, ops: parsed };
}

// ---------------------------------------------------------------------------
// 관계
// ---------------------------------------------------------------------------

export function endpointLabel(graph: CareerGraph, id: string): EndpointLabel | null {
  if (id === PERSON_ID) return "Person";
  return graph.nodes.find((n) => n.id === id)?.label ?? null;
}

export function endpointName(graph: CareerGraph, id: string): string {
  if (id === PERSON_ID) return graph.person.name ? `나(${graph.person.name})` : "나";
  const n = graph.nodes.find((x) => x.id === id);
  return n ? nodeDisplayName(n) : "(알 수 없음)";
}

export interface EdgeCandidate {
  type: RelType;
  from: string;
  to: string;
}

/** 두 끝점 사이에 새로 만들 수 있는 관계(양방향, 이미 있는 관계 제외). */
export function relationsBetween(graph: CareerGraph, a: string, b: string): EdgeCandidate[] {
  if (a === b) return [];
  const la = endpointLabel(graph, a);
  const lb = endpointLabel(graph, b);
  if (!la || !lb) return [];
  const existing = new Set(graph.edges.map((e) => e.id));
  const out: EdgeCandidate[] = [];
  for (const type of REL_TYPES) {
    if (isAllowedEdge(type, la, lb) && !existing.has(`${type}:${a}:${b}`)) out.push({ type, from: a, to: b });
    if (isAllowedEdge(type, lb, la) && !existing.has(`${type}:${b}:${a}`)) out.push({ type, from: b, to: a });
  }
  return out;
}

/** id와 새로 연결할 수 있는 끝점들(본인 포함). */
export function connectableTargets(graph: CareerGraph, id: string): string[] {
  const all = [PERSON_ID, ...graph.nodes.map((n) => n.id)];
  return all.filter((other) => relationsBetween(graph, id, other).length > 0);
}

/** 새로 만들 라벨의 노드를 기존 끝점에 잇는 선택지(본인 연결이 앞). */
export function linkOptionsForNewNode(graph: CareerGraph, label: NodeLabel): EdgeCandidate[] {
  const out: EdgeCandidate[] = [];
  const endpoints: { id: string; label: EndpointLabel }[] = [
    { id: PERSON_ID, label: "Person" },
    ...graph.nodes.map((n) => ({ id: n.id, label: n.label })),
  ];
  for (const e of endpoints) {
    for (const type of REL_TYPES) {
      if (isAllowedEdge(type, e.label, label)) out.push({ type, from: e.id, to: NEW_NODE_REF });
      if (isAllowedEdge(type, label, e.label)) out.push({ type, from: NEW_NODE_REF, to: e.id });
    }
  }
  return out;
}

/** 관계 한 줄 설명: "재직: 나 → 페이랩". */
export function describeEdge(graph: CareerGraph, e: Pick<GraphEdge, "type" | "from" | "to">, newName = "새 항목"): string {
  const name = (id: string) => (id === NEW_NODE_REF ? newName : endpointName(graph, id));
  return `${REL_RULES[e.type].name}: ${name(e.from)} → ${name(e.to)}`;
}

/** 노드(또는 본인)에 닿은 관계와 상대 끝점. */
export function edgesOf(graph: CareerGraph, id: string): { edge: GraphEdge; otherId: string; outgoing: boolean }[] {
  return graph.edges
    .filter((e) => e.from === id || e.to === id)
    .map((edge) => ({ edge, otherId: edge.from === id ? edge.to : edge.from, outgoing: edge.from === id }));
}

// ---------------------------------------------------------------------------
// 표시
// ---------------------------------------------------------------------------

/** "2021-01 ~ 현재" 같은 기간. 날짜가 없으면 null. */
export function nodePeriod(node: GraphNode): string | null {
  const p = node.props as Record<string, unknown>;
  const start = typeof p.startDate === "string" ? p.startDate : null;
  const end = p.current === true ? "현재" : typeof p.endDate === "string" ? p.endDate : null;
  if (start || end) return `${start ?? ""} ~ ${end ?? ""}`.trim();
  return typeof p.date === "string" ? p.date : null;
}

/** 정렬 키: 최근(시작일·날짜) 먼저, 날짜 없는 것은 뒤에서 만든 순서. */
export function sortNodesForList(nodes: readonly GraphNode[]): GraphNode[] {
  const key = (n: GraphNode) => {
    const p = n.props as Record<string, unknown>;
    if (p.current === true) return "9999";
    const v = p.startDate ?? p.date ?? p.endDate;
    return typeof v === "string" ? v : "";
  };
  return [...nodes].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    if (ka !== kb) return ka < kb ? 1 : -1;
    return a.createdAt - b.createdAt;
  });
}

/** 속성 값 → 표시 문구. 배열(소재 분류)은 카테고리 이름을 ·로 잇는다. */
export function formatPropValue(label: NodeLabel, key: string, v: unknown): string {
  if (Array.isArray(v)) return v.map((x) => storyTagName(String(x))).join(" · ");
  if (typeof v === "boolean") return v ? "예" : "아니오";
  const f = fieldsFor(label).find((x) => x.key === key);
  return f?.options?.find((o) => o.value === v)?.label ?? String(v);
}

/** 상세 패널에 보일 속성 목록(대표 키 제외, 값 있는 것만). */
export function displayProps(node: GraphNode): { key: string; label: string; value: string; group?: "story" }[] {
  const p = node.props as Record<string, unknown>;
  return fieldsFor(node.label)
    .filter((f) => f.key !== NODE_TITLE_KEY[node.label] && p[f.key] !== undefined && p[f.key] !== null && p[f.key] !== "")
    .map((f) => ({ key: f.key, label: f.label, value: formatPropValue(node.label, f.key, p[f.key]), group: f.group }));
}
