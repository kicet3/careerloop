/**
 * 경험 그래프 계약(클라이언트·서버 공용). 저장은 Neo4j(src/lib/graph/*)이고, 여기에는 노드 라벨·관계 타입·속성 스키마와
 * 변경 연산(GraphOp)만 둔다. 라벨·관계 타입은 이 화이트리스트 밖의 값을 절대 Cypher에 넣지 않는다.
 *
 * - 사용자마다 Person 노드가 하나 있고(자동 생성), API에서는 id를 PERSON_ID("me")로 부른다.
 * - 나머지 노드 id는 서버가 만든다(nanoid). 한 번의 변경안 안에서 새 노드를 가리킬 때는 임시 ref("new:...")를 쓴다.
 * - 관계는 (type, from, to)로 유일하다. 같은 관계를 두 번 추가해도 하나만 남는다. 관계 id = `${type}:${from}:${to}`.
 */
import { z } from "zod";

// ---------------------------------------------------------------------------
// 라벨 · 관계
// ---------------------------------------------------------------------------

/** 사용자가 만들고 고칠 수 있는 노드 라벨. Person은 사용자당 하나라 여기에 넣지 않는다. */
export const NODE_LABELS = ["Company", "Role", "Project", "Experience", "Skill", "Achievement", "Education", "Certification"] as const;
export type NodeLabel = (typeof NODE_LABELS)[number];
export const NodeLabelSchema = z.enum(NODE_LABELS);

/** 관계 양 끝에 올 수 있는 라벨(Person 포함). */
export type EndpointLabel = NodeLabel | "Person";

export const PERSON_ID = "me";

export const NODE_LABEL_META: Record<NodeLabel, { name: string; description: string }> = {
  Company: { name: "회사", description: "다닌 회사·기관" },
  Role: { name: "직무·직함", description: "회사에서 맡은 직함과 기간" },
  Project: { name: "프로젝트", description: "참여·주도한 프로젝트" },
  Experience: { name: "경험", description: "대외활동·동아리·봉사·수상 준비 등 경력 밖의 경험" },
  Skill: { name: "기술·역량", description: "도구·언어·프레임워크·도메인 지식·소프트 스킬" },
  Achievement: { name: "성과", description: "측정 가능한 결과(숫자·수상·출시 등)" },
  Education: { name: "학력", description: "학교·전공·학위" },
  Certification: { name: "자격증", description: "자격증·어학 점수·수료" },
};

export const REL_TYPES = [
  "WORKED_AT",
  "HAD_ROLE",
  "AT_COMPANY",
  "WORKED_ON",
  "PART_OF",
  "HAS_EXPERIENCE",
  "RELATED_TO",
  "USED_SKILL",
  "HAS_SKILL",
  "ACHIEVED",
  "STUDIED_AT",
  "EARNED",
] as const;
export type RelType = (typeof REL_TYPES)[number];
export const RelTypeSchema = z.enum(REL_TYPES);

/** 관계 타입별 허용 방향(from 라벨 → to 라벨). 서비스가 추가 시 검사한다. */
export const REL_RULES: Record<RelType, { name: string; from: readonly EndpointLabel[]; to: readonly EndpointLabel[] }> = {
  WORKED_AT: { name: "재직", from: ["Person"], to: ["Company"] },
  HAD_ROLE: { name: "직무", from: ["Person"], to: ["Role"] },
  AT_COMPANY: { name: "소속 회사", from: ["Role"], to: ["Company"] },
  WORKED_ON: { name: "프로젝트 수행", from: ["Person", "Role"], to: ["Project"] },
  PART_OF: { name: "소속", from: ["Project"], to: ["Company", "Experience", "Education"] },
  HAS_EXPERIENCE: { name: "경험", from: ["Person"], to: ["Experience"] },
  RELATED_TO: { name: "관련", from: ["Experience"], to: ["Company", "Role", "Project", "Education"] },
  USED_SKILL: { name: "사용 기술", from: ["Role", "Project", "Experience"], to: ["Skill"] },
  HAS_SKILL: { name: "보유 기술", from: ["Person"], to: ["Skill"] },
  ACHIEVED: { name: "성과", from: ["Person", "Role", "Project", "Experience"], to: ["Achievement"] },
  STUDIED_AT: { name: "학력", from: ["Person"], to: ["Education"] },
  EARNED: { name: "취득", from: ["Person"], to: ["Certification"] },
};

export function isAllowedEdge(type: RelType, from: EndpointLabel, to: EndpointLabel): boolean {
  const rule = REL_RULES[type];
  return rule.from.includes(from) && rule.to.includes(to);
}

// ---------------------------------------------------------------------------
// 속성 스키마
// ---------------------------------------------------------------------------

/** 날짜: YYYY, YYYY-MM, YYYY-MM-DD. */
const DATE_RE = /^\d{4}(-(0[1-9]|1[0-2])(-(0[1-9]|[12]\d|3[01]))?)?$/;
const date = () => z.string().regex(DATE_RE).describe("YYYY, YYYY-MM 또는 YYYY-MM-DD");
const short = (max = 120) => z.string().trim().min(1).max(max);
const long = (max = 2000) => z.string().trim().max(max);
const url = () => z.string().trim().max(500).describe("http(s) URL");

export const SKILL_CATEGORIES = ["language", "framework", "tool", "domain", "soft", "other"] as const;

/**
 * 자소서 소재 분류(Project·Experience.categories). 정의·최소 입력 기준은 experience-categories.ts, 근거는
 * docs/EXPERIENCE-CATEGORIES.md. 순서가 곧 저장 순서다(정렬해 저장해 비교가 흔들리지 않게 한다).
 */
export const STORY_TAGS = [
  "problem-solving",
  "collaboration",
  "challenge-failure",
  "motivation",
  "leadership",
  "values",
  "learning",
  "responsibility",
] as const;
export type StoryTag = (typeof STORY_TAGS)[number];
/** 노드 하나에 달 수 있는 소재 분류 수. */
export const MAX_STORY_TAGS = 3;

/** LLM·사용자가 한국어로 준 분류 이름 → id. 정규화(공백·기호 제거, 소문자) 뒤 비교한다. 서로 겹치지 않아야 한다. */
export const STORY_TAG_ALIASES: Record<StoryTag, readonly string[]> = {
  "problem-solving": ["문제해결", "문제 해결", "문제해결·개선", "개선", "트러블슈팅", "problem solving", "problemsolving"],
  collaboration: ["협업", "협업·갈등 해결", "갈등", "갈등해결", "갈등 해결", "팀워크", "의사소통", "teamwork"],
  "challenge-failure": ["도전", "실패", "도전·실패 극복", "실패극복", "실패 극복", "도전·실패", "challenge", "failure"],
  motivation: ["지원동기", "지원 동기", "지원동기 소재", "직무 관심", "계기"],
  leadership: ["리더십", "리더쉽", "주도성", "리더십·주도성", "주도"],
  values: ["가치관", "성장과정", "성장 과정", "성장과정·가치관", "장단점", "성격"],
  learning: ["학습", "자기개발", "자기계발", "자기개발·학습", "공부"],
  responsibility: ["책임감", "직업윤리", "윤리", "고객지향", "책임감·직업윤리·고객지향", "주인의식"],
};

const tagKey = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/|]+/g, "");
const TAG_LOOKUP = new Map<string, StoryTag>(
  STORY_TAGS.flatMap((t) => [[tagKey(t), t] as const, ...STORY_TAG_ALIASES[t].map((a) => [tagKey(a), t] as const)]),
);

/** 분류 이름(id 또는 별칭) → id. 모르면 null. */
export function resolveStoryTag(value: string): StoryTag | null {
  return TAG_LOOKUP.get(tagKey(value)) ?? null;
}

/** 중복 제거·STORY_TAGS 순서 정렬·상한 자르기. */
export function normalizeStoryTags(tags: readonly StoryTag[]): StoryTag[] {
  const set = new Set(tags);
  return STORY_TAGS.filter((t) => set.has(t)).slice(0, MAX_STORY_TAGS);
}

/** Project·Experience 공통: 자소서 소재(STAR) 필드. 모두 선택. */
const storyProps = () => ({
  situation: long(1000).optional().describe("상황·목표(S·T)"),
  action: long(1000).optional().describe("내가 한 행동·방법·선택 이유(A)"),
  result: long(1000).optional().describe("결과(R). 수치가 있으면 수치"),
  learned: long(1000).optional().describe("배운 점·가치관·이후 변화"),
  categories: z.array(z.enum(STORY_TAGS)).min(1).max(MAX_STORY_TAGS).optional().describe("자소서 소재 분류(최대 3개)"),
});

export const NODE_PROP_SCHEMAS = {
  Company: z.object({
    name: short(),
    industry: short().optional(),
    location: short().optional(),
    description: long().optional(),
    url: url().optional(),
  }),
  Role: z.object({
    title: short(),
    department: short().optional(),
    employmentType: short(40).optional().describe("정규직·계약직·인턴·프리랜서 등"),
    startDate: date().optional(),
    endDate: date().optional(),
    current: z.boolean().optional().describe("현재 재직 중이면 true"),
    summary: long().optional(),
  }),
  Project: z.object({
    name: short(),
    summary: long().optional(),
    myRole: short().optional().describe("이 프로젝트에서 본인이 맡은 역할"),
    teamSize: z.number().int().min(1).max(100000).optional(),
    startDate: date().optional(),
    endDate: date().optional(),
    url: url().optional(),
    ...storyProps(),
  }),
  Experience: z.object({
    title: short(),
    kind: short(40).optional().describe("동아리·대외활동·봉사·공모전·연구 등"),
    organization: short().optional(),
    description: long().optional(),
    myRole: short().optional().describe("이 경험에서 본인이 맡은 역할"),
    startDate: date().optional(),
    endDate: date().optional(),
    ...storyProps(),
  }),
  Skill: z.object({
    name: short(80),
    category: z.enum(SKILL_CATEGORIES).optional(),
    level: short(40).optional().describe("숙련도(사용자 표현 그대로)"),
  }),
  Achievement: z.object({
    summary: short(300),
    metric: short(80).optional().describe("지표 이름, 예: 전환율"),
    value: short(80).optional().describe("수치·결과, 예: 12% → 18%"),
    date: date().optional(),
  }),
  Education: z.object({
    school: short(),
    degree: short(40).optional().describe("학사·석사·박사·고졸 등"),
    major: short().optional(),
    startDate: date().optional(),
    endDate: date().optional(),
    status: short(40).optional().describe("졸업·재학·휴학·중퇴 등"),
  }),
  Certification: z.object({
    name: short(),
    issuer: short().optional(),
    date: date().optional(),
    score: short(40).optional(),
  }),
} satisfies Record<NodeLabel, z.ZodObject>;

export type NodePropsMap = { [L in NodeLabel]: z.infer<(typeof NODE_PROP_SCHEMAS)[L]> };
export type NodeProps<L extends NodeLabel = NodeLabel> = NodePropsMap[L];

/** 노드의 대표 속성(목록·그래프 표시용 이름). */
export const NODE_TITLE_KEY: Record<NodeLabel, string> = {
  Company: "name",
  Role: "title",
  Project: "name",
  Experience: "title",
  Skill: "name",
  Achievement: "summary",
  Education: "school",
  Certification: "name",
};

/** 노드 1개당 속성 키 화이트리스트. 서비스는 이 키만 Neo4j에 쓴다. */
export function allowedPropKeys(label: NodeLabel): string[] {
  return Object.keys(NODE_PROP_SCHEMAS[label].shape);
}

// ---------------------------------------------------------------------------
// 그래프 값
// ---------------------------------------------------------------------------

export type GraphNode = {
  [L in NodeLabel]: { id: string; label: L; props: NodePropsMap[L]; createdAt: number; updatedAt: number };
}[NodeLabel];

export interface GraphPerson {
  id: typeof PERSON_ID;
  /** 표시 이름(사용자 이름, 없으면 null). */
  name: string | null;
}

export interface GraphEdge {
  /** `${type}:${from}:${to}` */
  id: string;
  type: RelType;
  from: string;
  to: string;
}

export interface CareerGraph {
  person: GraphPerson;
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export function edgeId(type: RelType, from: string, to: string): string {
  return `${type}:${from}:${to}`;
}

export function nodeDisplayName(node: Pick<GraphNode, "label" | "props">): string {
  const v = (node.props as Record<string, unknown>)[NODE_TITLE_KEY[node.label]];
  return typeof v === "string" && v ? v : NODE_LABEL_META[node.label].name;
}

/** 사용자당 노드 수 상한, 변경안 1건의 연산 수 상한. */
export const MAX_NODES_PER_USER = 1000;
export const MAX_OPS_PER_BATCH = 60;

// ---------------------------------------------------------------------------
// 변경 연산 (직접 편집 API와 그래프 채팅 변경안이 함께 쓴다)
// ---------------------------------------------------------------------------

/** 한 변경안 안에서 새로 만드는 노드의 임시 이름. 기존 노드 id·PERSON_ID와 겹치지 않도록 접두사를 강제한다. */
export const TempRefSchema = z
  .string()
  .regex(/^new:[A-Za-z0-9_-]{1,32}$/)
  .describe('새 노드 임시 참조. "new:" + 영문·숫자, 예: new:1, new:company');

/** 노드 참조: PERSON_ID("me"), 기존 노드 id, 또는 같은 변경안에서 앞서 addNode로 만든 임시 ref. */
export const NodeRefSchema = z.string().min(1).max(64).describe('"me"(본인), 기존 노드 id, 또는 같은 변경안의 임시 ref(new:...)');

function addNodeVariant<L extends NodeLabel>(label: L) {
  return z.object({
    op: z.literal("addNode"),
    ref: TempRefSchema,
    label: z.literal(label),
    props: NODE_PROP_SCHEMAS[label],
  });
}

function updateNodeVariant<L extends NodeLabel>(label: L) {
  // 바꿀 키만 넣는다. null은 그 속성을 지운다(대표 속성은 지울 수 없다 — 서비스가 막는다).
  const shape = NODE_PROP_SCHEMAS[label].shape as Record<string, z.ZodType>;
  const partial = Object.fromEntries(
    Object.entries(shape).map(([k, s]) => [k, (s instanceof z.ZodOptional ? (s.unwrap() as z.ZodType) : s).nullable().optional()]),
  );
  return z.object({
    op: z.literal("updateNode"),
    id: z.string().min(1).max(64),
    label: z.literal(label),
    props: z.object(partial),
  });
}

const AddNodeOps = NODE_LABELS.map(addNodeVariant) as unknown as [ReturnType<typeof addNodeVariant>, ...ReturnType<typeof addNodeVariant>[]];
const UpdateNodeOps = NODE_LABELS.map(updateNodeVariant) as unknown as [
  ReturnType<typeof updateNodeVariant>,
  ...ReturnType<typeof updateNodeVariant>[],
];

export const DeleteNodeOpSchema = z.object({ op: z.literal("deleteNode"), id: z.string().min(1).max(64) });
export const AddEdgeOpSchema = z.object({ op: z.literal("addEdge"), type: RelTypeSchema, from: NodeRefSchema, to: NodeRefSchema });
export const DeleteEdgeOpSchema = z.object({ op: z.literal("deleteEdge"), type: RelTypeSchema, from: NodeRefSchema, to: NodeRefSchema });

/**
 * 엄격한 연산 스키마(직접 편집 API 입력 검증용). 라벨별 속성까지 검사한다.
 * LLM 구조화 출력에는 쓰지 않는다(유니온·선택 필드가 많아 무겁다) — LLM은 아래 LlmGraphOpSchema를 쓰고 toGraphOps로 바꾼다.
 */
export const GraphOpSchema = z.union([
  ...AddNodeOps,
  ...UpdateNodeOps,
  DeleteNodeOpSchema,
  AddEdgeOpSchema,
  DeleteEdgeOpSchema,
]) as unknown as z.ZodType<GraphOp>;

export type AddNodeOp = { [L in NodeLabel]: { op: "addNode"; ref: string; label: L; props: NodePropsMap[L] } }[NodeLabel];
export type UpdateNodeOp = {
  [L in NodeLabel]: { op: "updateNode"; id: string; label: L; props: { [K in keyof NodePropsMap[L]]?: NodePropsMap[L][K] | null } };
}[NodeLabel];
export type DeleteNodeOp = z.infer<typeof DeleteNodeOpSchema>;
export type AddEdgeOp = z.infer<typeof AddEdgeOpSchema>;
export type DeleteEdgeOp = z.infer<typeof DeleteEdgeOpSchema>;
export type GraphOp = AddNodeOp | UpdateNodeOp | DeleteNodeOp | AddEdgeOp | DeleteEdgeOp;

export const GraphOpsSchema = z.array(GraphOpSchema).max(MAX_OPS_PER_BATCH);

// ---------------------------------------------------------------------------
// LLM용 평평한 연산 형식 → GraphOp
// ---------------------------------------------------------------------------

/**
 * LLM 구조화 출력용 연산: 모든 필드가 필수이고 해당 없는 값은 빈 문자열이다(유니온·선택 필드 없음).
 * props는 [{key, value}] 문자열 쌍이다. updateNode에서 value가 ""이면 그 속성을 지운다.
 */
export const LlmGraphOpSchema = z.object({
  op: z.enum(["addNode", "updateNode", "deleteNode", "addEdge", "deleteEdge"]),
  ref: z.string().describe('addNode: 새 노드 임시 참조 "new:<영문·숫자>". 그 밖에는 ""'),
  id: z.string().describe('updateNode·deleteNode: 기존 노드 id. 그 밖에는 ""'),
  label: z.enum([...NODE_LABELS, ""]).describe('addNode·updateNode: 노드 라벨. 그 밖에는 ""'),
  props: z
    .array(z.object({ key: z.string(), value: z.string() }))
    .describe("addNode·updateNode: 속성 키와 값(문자열). 숫자·참거짓도 문자열로. 날짜는 YYYY, YYYY-MM, YYYY-MM-DD. 그 밖에는 []"),
  type: z.enum([...REL_TYPES, ""]).describe('addEdge·deleteEdge: 관계 타입. 그 밖에는 ""'),
  from: z.string().describe('addEdge·deleteEdge: 시작 노드("me", 기존 id, 또는 new:...). 그 밖에는 ""'),
  to: z.string().describe('addEdge·deleteEdge: 끝 노드. 그 밖에는 ""'),
});
export type LlmGraphOp = z.infer<typeof LlmGraphOpSchema>;

/** 날짜 속성 키(모든 라벨 공통 이름). */
const DATE_KEYS = new Set(["startDate", "endDate", "date"]);

/** 모델이 자주 쓰는 날짜 표기("2021.03", "2021/3", "2021년 3월 5일")를 YYYY-MM(-DD)로. 모르는 형식은 그대로 둔다. */
export function normalizeGraphDate(value: string): string {
  const v = value.trim();
  if (DATE_RE.test(v) || v.length > 30) return v;
  const m = /^(\d{4})\s*(?:[.\/-]|년)\s*(\d{1,2})\s*(?:월)?(?:\s*(?:[.\/-])?\s*(\d{1,2})\s*일?)?\.?$/.exec(v);
  if (!m) return v;
  const pad = (x: string) => x.padStart(2, "0");
  return m[3] ? `${m[1]}-${pad(m[2]!)}-${pad(m[3])}` : `${m[1]}-${pad(m[2]!)}`;
}

/** 붙여 볼 최대 단어 수("책임감 직업윤리 고객지향" 같은 별칭). */
const MAX_TAG_WORDS = 3;

/**
 * "collaboration, 리더십 | foo" → 알려진 분류(정렬·상한)와 모르는 값. 쉼표·|·/·가운뎃점은 경계이고, 공백으로 나뉜 단어는
 * 가장 긴 별칭부터 맞춘다("리더십 문제 해결" → leadership + problem-solving).
 */
export function parseStoryTags(value: string): { tags: StoryTag[]; unknown: string[] } {
  const tags: StoryTag[] = [];
  const unknown: string[] = [];
  for (const segment of value.split(/[,|/·]+/)) {
    const words = segment.split(/\s+/).filter(Boolean);
    let i = 0;
    while (i < words.length) {
      let matched = 0;
      for (let len = Math.min(MAX_TAG_WORDS, words.length - i); len >= 1; len--) {
        const t = resolveStoryTag(words.slice(i, i + len).join(" "));
        if (t) {
          tags.push(t);
          matched = len;
          break;
        }
      }
      if (matched === 0) {
        unknown.push(words[i]!);
        i += 1;
      } else i += matched;
    }
  }
  return { tags: normalizeStoryTags(tags), unknown };
}

/** 문자열 값을 속성 타입으로. 숫자는 수가 하나뿐일 때만("약 5명" → 5), 범위("3-4", "5~6명")는 그대로 둬 검증에서 빠지게 한다. */
function coerceProp(key: string, schema: z.ZodType, value: string): unknown {
  const inner = schema instanceof z.ZodOptional ? schema.unwrap() : schema;
  if (inner instanceof z.ZodBoolean) return /^(true|yes|1|예|네|y)$/i.test(value.trim());
  if (inner instanceof z.ZodNumber) {
    const nums = value.replace(/,/g, "").match(/\d+(?:\.\d+)?/g) ?? [];
    return nums.length === 1 ? Number(nums[0]) : value;
  }
  if (DATE_KEYS.has(key)) return normalizeGraphDate(value);
  return value;
}

/**
 * LLM 연산을 엄격한 GraphOp로 바꾼다. 형식이 틀린 연산은 버리고 사유를 errors에 남긴다(변경안 전체를 버리지 않는다).
 * 존재 여부·소유권·관계 방향 검사는 여기서 하지 않는다 — applyGraphOps가 한다.
 * opts.max: 앞에서부터 볼 연산 수(기본 MAX_OPS_PER_BATCH, 이력서 가져오기는 MAX_IMPORT_OPS).
 */
export function toGraphOps(llmOps: readonly LlmGraphOp[], opts: { max?: number } = {}): { ops: GraphOp[]; errors: string[] } {
  const ops: GraphOp[] = [];
  const errors: string[] = [];
  llmOps.slice(0, opts.max ?? MAX_OPS_PER_BATCH).forEach((o, i) => {
    let candidate: unknown;
    if (o.op === "addNode" || o.op === "updateNode") {
      if (!o.label) {
        errors.push(`#${i + 1} ${o.op}: label이 없습니다`);
        return;
      }
      const shape = NODE_PROP_SCHEMAS[o.label].shape as Record<string, z.ZodType>;
      const titleKey = NODE_TITLE_KEY[o.label];
      const props: Record<string, unknown> = {};
      for (const { key, value } of o.props) {
        if (!(key in shape)) continue; // 화이트리스트 밖 키는 버린다
        if (value.trim() === "") {
          if (o.op === "updateNode") props[key] = null;
          continue;
        }
        const inner = shape[key] instanceof z.ZodOptional ? (shape[key] as z.ZodOptional).unwrap() : shape[key];
        if (inner instanceof z.ZodArray) {
          // 문자열 배열(자소서 소재 분류): 쪼개서 id로 바꾸고, 모르는 값은 버리고 알린다. 남은 것이 없으면 그 속성만 뺀다.
          const { tags, unknown } = parseStoryTags(value);
          if (unknown.length > 0) errors.push(`#${i + 1} ${o.op}: 속성 ${key}의 알 수 없는 값 '${unknown.join(", ").slice(0, 40)}'은(는) 뺐습니다`);
          if (tags.length > 0) props[key] = tags;
          continue;
        }
        const coerced = coerceProp(key, shape[key]!, value.trim());
        // 속성 하나가 형식에 안 맞으면 그 속성만 뺀다(노드와 그 노드를 잇는 관계까지 통째로 버리지 않게). 대표 속성은 남겨 아래에서 노드째 거른다.
        if (key !== titleKey && !shape[key]!.safeParse(coerced).success) {
          errors.push(`#${i + 1} ${o.op}: 속성 ${key} 값 '${value.trim().slice(0, 40)}'은(는) 형식이 맞지 않아 뺐습니다`);
          continue;
        }
        props[key] = coerced;
      }
      candidate = o.op === "addNode" ? { op: o.op, ref: o.ref, label: o.label, props } : { op: o.op, id: o.id, label: o.label, props };
    } else if (o.op === "deleteNode") {
      candidate = { op: o.op, id: o.id };
    } else {
      candidate = { op: o.op, type: o.type, from: o.from, to: o.to };
    }
    const r = GraphOpSchema.safeParse(candidate);
    if (r.success) ops.push(r.data);
    else errors.push(`#${i + 1} ${o.op}: ${r.error.issues.map((x) => `${x.path.join(".") || "(root)"} ${x.message}`).join("; ").slice(0, 200)}`);
  });
  return { ops, errors };
}

/** 그래프 채팅이 낸 변경안. 사용자가 확인하면 applyGraphOps(userId, ops)로 적용한다. */
export interface GraphProposal {
  ops: GraphOp[];
  /** 변경안 한 줄 요약(사용자 확인 화면용). */
  summary: string;
}

/** applyGraphOps 결과: 임시 ref → 새로 만든 노드 id, 적용된 연산 수. */
export interface ApplyGraphOpsResult {
  created: Record<string, string>;
  applied: number;
}

/** 연산을 사람이 읽을 한 줄로(변경안 확인 목록용). 노드 이름은 graph·같은 변경안의 addNode에서 찾는다. */
export function describeGraphOp(op: GraphOp, graph?: Pick<CareerGraph, "nodes"> | null, batch?: readonly GraphOp[]): string {
  const name = (ref: string): string => {
    if (ref === PERSON_ID) return "나";
    const added = batch?.find((o): o is AddNodeOp => o.op === "addNode" && o.ref === ref);
    if (added) return nodeDisplayName(added);
    const n = graph?.nodes.find((x) => x.id === ref);
    return n ? nodeDisplayName(n) : ref;
  };
  switch (op.op) {
    case "addNode":
      return `${NODE_LABEL_META[op.label].name} 추가: ${nodeDisplayName(op)}`;
    case "updateNode":
      return `${NODE_LABEL_META[op.label].name} 수정: ${name(op.id)} (${Object.keys(op.props).join(", ")})`;
    case "deleteNode":
      return `삭제: ${name(op.id)}`;
    case "addEdge":
      return `연결(${REL_RULES[op.type].name}): ${name(op.from)} → ${name(op.to)}`;
    case "deleteEdge":
      return `연결 해제(${REL_RULES[op.type].name}): ${name(op.from)} → ${name(op.to)}`;
  }
}
