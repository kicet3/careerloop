/**
 * LLM에 보이는 근거 본문 만들기(순수). 값은 모두 스냅샷·권위 원문에서 온다(원시 도구 결과의 텍스트를 쓰지 않는다).
 * 본문은 neutralizeChat(CHAT_TAGS·패널 태그 무력화)을 거치고, 본문 안의 evidence_id 모양 문자열(ev_ + 22자)·handle 표식은
 * 서버가 붙인 줄 머리에만 나오게 바꿔 쓴다(문서가 가짜 근거 id를 심어도 LLM이 헷갈리지 않게).
 */
import { NODE_LABEL_META, type NodeLabel, REL_RULES, type RelType } from "@/lib/domain/graph";
import { neutralizeChat } from "@/lib/chat/prompt";
import type { AggregateGroup } from "./graph/eval-in-memory";
import type { ValidatedPlan } from "./graph/plan";
import type { OwnedSnapshot, SnapLabel, SnapNode } from "./snapshot";

export const CONTENT_MAX = 900;
export const CHUNK_RENDER_MAX = 800;

/** 본문 안의 근거 id·handle 표식 무력화(단어 결합자 U+2060을 끼운다). */
export function maskMarkers(text: string): string {
  return text.replace(/ev_(?=[A-Za-z0-9_-]{22})/g, "ev⁠_").replace(/\[(ev|N\d|C\d)/g, "[⁠$1");
}

export function safeText(text: string, max = CONTENT_MAX): string {
  const t = maskMarkers(neutralizeChat(text)).replace(/\r/g, "");
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export const labelName = (label: SnapLabel | string): string =>
  label === "Person" ? "본인" : label.startsWith("Shared:") ? "공유 개념" : (NODE_LABEL_META[label as NodeLabel]?.name ?? "항목");

const valueText = (v: unknown) => (Array.isArray(v) ? v.join("|") : typeof v === "boolean" ? (v ? "예" : "아니오") : String(v));

export function nodeBody(node: SnapNode, opts: { full?: boolean } = {}): string {
  const cap = opts.full ? 600 : 200;
  const props = Object.entries(node.props)
    .filter(([k, v]) => v !== undefined && v !== null && v !== "" && !(node.label !== "Person" && k === titleKeyOf(node)))
    .map(([k, v]) => `${k}=${valueText(v).replace(/\s+/g, " ").slice(0, cap)}`)
    .join("; ");
  return safeText(`${labelName(node.label)} · ${node.title}${props ? `\n속성: ${props}` : ""}`, opts.full ? 2400 : CONTENT_MAX);
}

function titleKeyOf(node: SnapNode): string | null {
  for (const [k, v] of Object.entries(node.props)) if (v === node.title) return k;
  return null;
}

const shortNode = (s: OwnedSnapshot, id: string) => {
  const n = s.nodes.get(id);
  return n ? `${n.title}(${labelName(n.label)})` : "?";
};

export function edgeBody(s: OwnedSnapshot, from: string, type: RelType, to: string): string {
  return safeText(`${shortNode(s, from)} -[${REL_RULES[type].name}]-> ${shortNode(s, to)}`);
}

export function pathBody(s: OwnedSnapshot, nodeIds: readonly string[], edgeKeys: readonly string[]): string {
  const parts: string[] = [shortNode(s, nodeIds[0]!)];
  for (let i = 0; i < edgeKeys.length; i++) {
    const [from, type] = edgeKeys[i]!.split("|");
    const forward = from === nodeIds[i];
    const rel = REL_RULES[type as RelType]?.name ?? type;
    parts.push(forward ? ` -[${rel}]-> ` : ` <-[${rel}]- `, shortNode(s, nodeIds[i + 1]!));
  }
  return safeText(`경로: ${parts.join("")}`);
}

export function aggregateBody(s: OwnedSnapshot, plan: ValidatedPlan, groups: readonly AggregateGroup[]): string {
  if (plan.ret.kind !== "aggregate") return "";
  const r = plan.ret;
  const what = `${r.fn}(${labelName(plan.vars[r.varIndex]!.label)}${r.prop ? `.${r.prop}` : ""})`;
  const by = r.groupBy ? ` 그룹: ${labelName(plan.vars[r.groupBy.varIndex]!.label)}.${r.groupBy.prop}` : "";
  const lines = groups.map((g) => `${r.groupBy ? `${g.key ?? "(없음)"}: ` : ""}${g.value ?? "(없음)"}`);
  void s;
  return safeText(`집계 ${what}${by}\n${lines.join("\n")}`);
}

export function chunkBody(label: string, text: string): string {
  return safeText(`${label}\n${text}`, CHUNK_RENDER_MAX + 140);
}
