/**
 * 그래프 채팅 변경안 → 후속 질문 후보(순수). 저장·중복 제거는 followups.ts가 한다.
 *
 * - question: 변경안의 followUpQuestions 그대로.
 * - dropped: 변경안에서 뺀 항목 중 사용자가 채울 수 있는 정보가 빠진 것만 정해진 문장(템플릿)으로 질문을 만든다. LLM을 더 부르지 않는다.
 *   · 문서 가져오기에서 문서에 근거가 없어 뺀 항목(EvidenceGap): 항목째 → "실제 경험이라면 알려 주세요", 숫자 속성 → "실제 수치를 알려 주세요"
 *   · 기간(startDate·endDate·date)·팀 규모(teamSize) 값의 형식이 맞지 않아 뺀 속성(toGraphOps 오류): "YYYY-MM으로 알려 주세요" 등
 *   뺀 항목 질문은 특정 노드·값에 대한 것이라 구조화 항목(targetItem)을 달지 않는다 — 체크리스트가 완료여도 그 질문에 답한 것은 아니다.
 *   중복 합치기, 잘못된 id·관계, 삭제 금지, 프로젝트 범위 밖, 소재 분류 상한 같은 기술적 사유는 질문으로 만들지 않는다(목록에서도 세지 않는다).
 *
 * 프로젝트 귀속(attribution):
 * - 프로젝트 단위 대화 → 그 프로젝트.
 * - 일반 대화 → 연산이 가리키는 Project(기존 노드면 id, 같은 변경안에서 새로 만드는 Project면 ref — 적용할 때 id로 바뀐다).
 *   Project가 아닌 노드는 그 노드와 이어진 Project가 하나뿐일 때만(기존 관계 또는 같은 변경안의 관계). 질문은 프로젝트 이름이
 *   질문에 하나만 들어 있으면 그 프로젝트, 아니면 변경안 전체가 프로젝트 하나에만 붙을 때 그 프로젝트. 정할 수 없으면 미지정(null).
 */
import {
  type CareerGraph,
  type GraphOp,
  type LlmGraphOp,
  NODE_LABEL_META,
  NODE_TITLE_KEY,
  type NodeLabel,
  nodeDisplayName,
} from "@/lib/domain/graph";
import {
  type FollowupKind,
  MAX_FOLLOWUP_DETAIL_CHARS,
  MAX_FOLLOWUP_TEXT_CHARS,
  normalizeFollowupText,
} from "@/lib/domain/followups";
import { assessProjectStructure, PROJECT_STRUCTURE_ITEMS, type ProjectStructureItemId } from "@/lib/graph/project-structure";
import type { EvidenceGap } from "./graph-import";

export interface FollowupCandidate {
  kind: FollowupKind;
  text: string;
  /** kind='dropped': 원래 뺀 사유(droppedOps의 그 줄). */
  detail: string | null;
  targetItem: ProjectStructureItemId | null;
  projectNodeId: string | null;
  /** 같은 변경안에서 새로 만드는 Project의 ref(적용하면 projectNodeId로 바뀐다). */
  projectRef: string | null;
}

/** 변경안 하나에서 쌓을 후속 질문 상한(뺀 항목에서 만든 것). */
export const MAX_DROPPED_FOLLOWUPS_PER_PROPOSAL = 5;

type ProjectTarget = { id: string } | { ref: string };
const targetKey = (t: ProjectTarget) => ("id" in t ? `id:${t.id}` : `ref:${t.ref}`);

/** 같은 대상끼리 하나로. 하나뿐이면 그것, 아니면 null. */
function unique(targets: readonly ProjectTarget[]): ProjectTarget | null {
  const map = new Map(targets.map((t) => [targetKey(t), t]));
  return map.size === 1 ? [...map.values()][0]! : null;
}

/** 귀속 판단에 쓰는 문맥: 그래프와 변경안의 (거르기 전) 연산 전체. */
export interface AttributionContext {
  graph: CareerGraph;
  /** 같은 변경안의 연산(관계로 새 노드가 어느 Project에 붙는지 본다). */
  batch: readonly GraphOp[];
}

function labelOf(ctx: AttributionContext, id: string): NodeLabel | null {
  const added = ctx.batch.find((o) => o.op === "addNode" && o.ref === id);
  if (added && added.op === "addNode") return added.label;
  return ctx.graph.nodes.find((n) => n.id === id)?.label ?? null;
}

const asTarget = (ctx: AttributionContext, id: string): ProjectTarget | null => {
  if (labelOf(ctx, id) !== "Project") return null;
  return ctx.graph.nodes.some((n) => n.id === id) ? { id } : { ref: id };
};

/** 노드(기존 id 또는 새 ref)가 속한 Project 후보: 자기 자신이 Project면 그것, 아니면 이어진 Project들(기존 관계 + 같은 변경안의 관계). */
function projectsOfNode(ctx: AttributionContext, id: string): ProjectTarget[] {
  const self = asTarget(ctx, id);
  if (self) return [self];
  const out: ProjectTarget[] = [];
  const consider = (other: string) => {
    const t = asTarget(ctx, other);
    if (t) out.push(t);
  };
  for (const e of ctx.graph.edges) {
    if (e.from === id) consider(e.to);
    if (e.to === id) consider(e.from);
  }
  for (const o of ctx.batch) {
    if (o.op !== "addEdge") continue;
    if (o.from === id) consider(o.to);
    if (o.to === id) consider(o.from);
  }
  return out;
}

/** 연산 하나가 가리키는 Project(하나로 정해질 때만). */
export function projectOfOp(op: GraphOp, ctx: AttributionContext): ProjectTarget | null {
  switch (op.op) {
    case "addNode":
      return unique(projectsOfNode(ctx, op.ref));
    case "updateNode":
    case "deleteNode":
      return unique(projectsOfNode(ctx, op.id));
    case "addEdge":
    case "deleteEdge": {
      const ends = [asTarget(ctx, op.from), asTarget(ctx, op.to)].filter((t): t is ProjectTarget => t !== null);
      return unique(ends);
    }
  }
}

/** 변경안 전체가 프로젝트 하나에만 붙으면 그 프로젝트. */
export function projectOfBatch(ops: readonly GraphOp[], ctx: AttributionContext): ProjectTarget | null {
  const targets: ProjectTarget[] = [];
  for (const op of ops) {
    const t = projectOfOp(op, ctx);
    if (t) targets.push(t);
  }
  return unique(targets);
}

/** 글에 이름이 들어 있는 Project(기존 + 같은 변경안의 새 Project). 이름이 두 글자 이상이고 하나만 맞을 때만. */
export function projectByName(text: string, ctx: AttributionContext): ProjectTarget | null {
  const hay = normalizeFollowupText(text);
  const hits: ProjectTarget[] = [];
  for (const n of ctx.graph.nodes) {
    if (n.label !== "Project") continue;
    const name = normalizeFollowupText(nodeDisplayName(n));
    if (name.length >= 2 && hay.includes(name)) hits.push({ id: n.id });
  }
  for (const o of ctx.batch) {
    if (o.op !== "addNode" || o.label !== "Project") continue;
    const name = normalizeFollowupText(nodeDisplayName(o));
    if (name.length >= 2 && hay.includes(name)) hits.push({ ref: o.ref });
  }
  return unique(hits);
}

const clip = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** 후속 질문의 detail(원래 뺀 사유)로 저장하는 형태 — droppedOps의 줄과 맞춰 볼 때도 쓴다. */
export const clipFollowupDetail = (reason: string) => clip(reason, MAX_FOLLOWUP_DETAIL_CHARS);

function candidate(
  kind: FollowupKind,
  text: string,
  detail: string | null,
  target: ProjectTarget | null,
  targetItem: ProjectStructureItemId | null,
): FollowupCandidate {
  return {
    kind,
    text: clip(text.replace(/\s+/g, " ").trim(), MAX_FOLLOWUP_TEXT_CHARS),
    detail: detail ? clipFollowupDetail(detail) : null,
    // 프로젝트에 붙지 않은 질문은 구조화 항목으로 자동 해결하지 않는다.
    targetItem: target ? targetItem : null,
    projectNodeId: target && "id" in target ? target.id : null,
    projectRef: target && "ref" in target ? target.ref : null,
  };
}

/** 질문 글이 구조화 체크리스트의 질문과 같으면 그 항목. */
export function structureItemOfQuestion(text: string): ProjectStructureItemId | null {
  const key = normalizeFollowupText(text);
  return PROJECT_STRUCTURE_ITEMS.find((d) => normalizeFollowupText(d.question) === key)?.id ?? null;
}

/**
 * 체크리스트 질문과 같은 글이면 그 항목 — 단, 기존 Project에서 그 항목이 이미 완료면 null(완료 상태로는 이 질문에 답했는지 알 수 없다).
 */
function openStructureItem(text: string, target: ProjectTarget | null, ctx: AttributionContext): ProjectStructureItemId | null {
  const item = structureItemOfQuestion(text);
  if (!item || !target || !("id" in target)) return item;
  const state = assessProjectStructure(ctx.graph, target.id)?.items.find((i) => i.id === item)?.state;
  return state === "done" ? null : item;
}

const PROP_NAMES: Record<string, string> = {
  startDate: "시작 시점",
  endDate: "종료 시점",
  date: "날짜",
  teamSize: "팀 규모",
  result: "결과",
  value: "수치",
  metric: "지표",
  summary: "내용",
  situation: "상황·목표",
  action: "한 일",
  learned: "배운 점",
  description: "설명",
};
const propName = (k: string) => PROP_NAMES[k] ?? k;

/** 같은 변경안 안 노드 이름(새 ref면 그 addNode의 이름, 기존 id면 그래프의 이름). */
function nodeName(ctx: AttributionContext, id: string, label?: NodeLabel | ""): string {
  const added = ctx.batch.find((o) => o.op === "addNode" && o.ref === id);
  if (added && added.op === "addNode") return nodeDisplayName(added);
  const n = ctx.graph.nodes.find((x) => x.id === id);
  if (n) return nodeDisplayName(n);
  return label ? NODE_LABEL_META[label].name : "이 항목";
}

/**
 * 문서 가져오기에서 근거가 없어 뺀 것 → 질문. 항목째 뺐으면 실제 경험인지·내용을, 숫자 속성만 뺐으면 실제 수치를 묻는다.
 * 관계·삭제 연산은 다루지 않는다(EvidenceGap은 addNode·updateNode만).
 */
export function questionsFromEvidenceGaps(gaps: readonly EvidenceGap[], ctx: AttributionContext, focus: string | null): FollowupCandidate[] {
  const out: FollowupCandidate[] = [];
  for (const g of gaps) {
    const op = g.op;
    if (op.op !== "addNode" && op.op !== "updateNode") continue;
    const name = op.op === "addNode" ? nodeDisplayName(op) : nodeName(ctx, op.id, op.label);
    const kindName = NODE_LABEL_META[op.label].name;
    const target = focus ? { id: focus } : (projectOfOp(op, ctx) ?? projectByName(g.reason, ctx));
    if (g.keys === null) {
      const text =
        op.op === "addNode"
          ? `${kindName} ‘${name}’은(는) 문서에서 찾지 못해 넣지 않았어요. 실제로 한 경험이라면 언제·어디서 무엇을 했는지 알려 주세요.`
          : `‘${name}’에 넣으려던 내용을 문서에서 찾지 못했어요. 맞는 내용이라면 근거(언제·무엇을·얼마나)를 알려 주세요.`;
      out.push(candidate("dropped", text, g.reason, target, null));
      continue;
    }
    const keys = g.keys.filter((k) => k !== NODE_TITLE_KEY[op.label]);
    const what = (keys.length ? keys : g.keys).map(propName).join("·");
    const text = `‘${name}’의 ${what}에 문서에 없는 숫자가 있어 넣지 않았어요. 실제 수치와 기준(기간·비교 대상)을 알려 주세요.`;
    out.push(candidate("dropped", text, g.reason, target, null));
  }
  return out;
}

const FORMAT_ERROR_RE = /^#(\d+) (addNode|updateNode): 속성 (\w+) 값 '([\s\S]*)'은\(는\) 형식이 맞지 않아 뺐습니다$/;
const DATE_PROPS = new Set(["startDate", "endDate", "date"]);

/**
 * toGraphOps 오류 중 기간·팀 규모 값의 형식이 맞지 않아 뺀 속성 → 질문. 그 밖의 형식 오류(라벨 없음, 알 수 없는 분류, 링크 형식 등)는 질문으로 만들지 않는다.
 * llmOps: LLM이 낸 연산(오류 번호 #n이 가리킨다).
 */
export function questionsFromFormatErrors(
  errors: readonly string[],
  llmOps: readonly LlmGraphOp[],
  ctx: AttributionContext,
  focus: string | null,
): FollowupCandidate[] {
  const out: FollowupCandidate[] = [];
  for (const reason of errors) {
    const m = FORMAT_ERROR_RE.exec(reason);
    if (!m) continue;
    const key = m[3]!;
    if (!DATE_PROPS.has(key) && key !== "teamSize") continue;
    const llm = llmOps[Number(m[1]) - 1];
    if (!llm || !llm.label) continue;
    const label = llm.label;
    const id = llm.op === "addNode" ? llm.ref : llm.id;
    const titleValue = llm.props.find((p) => p.key === NODE_TITLE_KEY[label])?.value.trim();
    const name = (llm.op === "addNode" && titleValue) || nodeName(ctx, id, label);
    const value = m[4]!;
    let target: ProjectTarget | null = focus ? { id: focus } : null;
    if (!target && id) {
      // 노드째 빠지지 않았으면 같은 ref·id로 그래프·변경안에서 찾는다.
      target = unique(projectsOfNode(ctx, id)) ?? projectByName(name, ctx);
    }
    const text = DATE_PROPS.has(key)
      ? `‘${name}’의 ${propName(key)}을(를) ‘${value}’(으)로는 알 수 없어 넣지 않았어요. 연·월(예: 2023-03)로 알려 주세요.`
      : `‘${name}’의 팀 규모를 ‘${value}’(으)로는 알 수 없어 넣지 않았어요. 몇 명이었나요?`;
    out.push(candidate("dropped", text, reason, target, null));
  }
  return out;
}

/** 변경안의 후속 질문 → 후보. 프로젝트 귀속은 위 규칙(이름 → 변경안 전체 → 미지정). */
export function questionsFromFollowUps(
  questions: readonly string[],
  finalOps: readonly GraphOp[],
  ctx: AttributionContext,
  focus: string | null,
): FollowupCandidate[] {
  const batchTarget = focus ? null : projectOfBatch(finalOps, ctx);
  return questions
    .map((q) => q.trim())
    .filter(Boolean)
    .map((q) => {
      const target = focus ? { id: focus } : (projectByName(q, ctx) ?? batchTarget);
      return candidate("question", q, null, target, openStructureItem(q, target, ctx));
    });
}

/** 같은 프로젝트 안에서 정규화한 글이 같은 후보를 하나로(앞의 것을 남긴다). */
export function dedupeCandidates(cands: readonly FollowupCandidate[]): FollowupCandidate[] {
  const seen = new Set<string>();
  const out: FollowupCandidate[] = [];
  for (const c of cands) {
    const key = `${c.projectNodeId ?? ""}|${c.projectRef ?? ""}|${normalizeFollowupText(c.text)}`;
    if (!normalizeFollowupText(c.text) || seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}
