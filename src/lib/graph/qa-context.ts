/**
 * 그래프에 묻기 — ⑤ 컨텍스트 생성(순수 함수). 리랭크한 상위 K개 노드에 번호를 붙여 답변 LLM에 줄 출처 표를 만든다.
 * 같은 번호 → 노드 표(GraphSource)를 서버가 들고 있다가 답의 [n]을 검증한다(graph-qa.ts answerFromOutput).
 */
import type { GraphSource } from "@/lib/domain/chat";
import { type CareerGraph, type GraphNode, NODE_LABEL_META, NODE_LABELS, NODE_TITLE_KEY } from "@/lib/domain/graph";
import type { ExperienceChecklist } from "./completeness";
import { experienceCategory } from "@/lib/domain/experience-categories";
import { pathToText } from "./paths";
import type { Ranked } from "./rerank";

export const CONTEXT_MAX_CHARS = 7000;
export const PER_SOURCE_MAX = 900;
const OVERVIEW_MAX = 400;
/** 속성 값 상한을 줄여 가며 맞춘다(graph/text.ts PROP_CAPS와 같은 방식). */
const PROP_CAPS = [200, 120, 60] as const;
/** 검색어와 직접 맞는 항목이 없을 때 출처 표 앞에 붙이는 안내(답변 LLM·가짜 LLM이 읽는다). */
export const NO_DIRECT_MATCH_NOTE = "(질문과 직접 맞는 항목을 찾지 못해 그래프 개요용 항목만 보낸다)";

function propsLine(node: GraphNode, cap: number): string {
  const titleKey = NODE_TITLE_KEY[node.label];
  const parts = Object.entries(node.props as Record<string, unknown>)
    .filter(([k, v]) => k !== titleKey && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${(Array.isArray(v) ? v.join("|") : String(v)).replace(/\s+/g, " ").slice(0, cap)}`);
  return parts.join("; ");
}

/** 출처 칩에 보일 근거 요약(≤200자). */
export function snippetOf(node: GraphNode): string {
  return propsLine(node, 80).slice(0, 200);
}

function sourceBlock(n: number, r: Ranked, cap: number): string {
  const c = r.candidate;
  const props = propsLine(c.node, cap);
  const text = [`[${n}] ${NODE_LABEL_META[c.node.label].name} · ${c.name}`, `경로: ${pathToText(c.path)}`, props ? `속성: ${props}` : ""]
    .filter(Boolean)
    .join("\n");
  return text.length > PER_SOURCE_MAX ? `${text.slice(0, PER_SOURCE_MAX - 1)}…` : text;
}

/** 그래프 개요(≤400자): 라벨별 개수와 체크리스트에서 빠진 필수 항목 — "그래프에 없음"을 근거 있게 말하게 한다. */
export function graphOverview(graph: CareerGraph, checklist: ExperienceChecklist | null): string {
  const counts = NODE_LABELS.map((l) => [l, graph.nodes.filter((n) => n.label === l).length] as const)
    .map(([l, c]) => `${NODE_LABEL_META[l].name} ${c}`)
    .join(", ");
  const missing = checklist?.categories.filter((c) => c.required && c.state !== "done").map((c) => experienceCategory(c.id).name) ?? [];
  const text = `그래프 개요: ${counts}.${missing.length ? ` 아직 덜 채운 필수 경험: ${missing.join(", ")}.` : ""}`;
  return text.slice(0, OVERVIEW_MAX);
}

export interface BuiltContext {
  /** <graph_sources> 본문. */
  text: string;
  /** 번호 → 노드 표(번호는 1부터, 순위 순). */
  sources: GraphSource[];
  chars: number;
}

/**
 * 상위 K개를 번호 붙인 출처 표로. 예산(maxChars)을 넘으면 속성 값 상한을 줄이고, 그래도 넘으면 낮은 순위부터 뺀다.
 */
export function buildContext(
  selected: readonly Ranked[],
  graph: CareerGraph,
  opts: { maxChars?: number; checklist?: ExperienceChecklist | null; noDirectMatch?: boolean } = {},
): BuiltContext {
  const maxChars = opts.maxChars ?? CONTEXT_MAX_CHARS;
  const overview = graphOverview(graph, opts.checklist ?? null);
  const head = opts.noDirectMatch ? `${NO_DIRECT_MATCH_NOTE}\n\n` : "";
  let items = [...selected];
  for (;;) {
    for (const cap of PROP_CAPS) {
      const blocks = items.map((r, i) => sourceBlock(i + 1, r, cap));
      const text = `${head}${blocks.join("\n\n")}${blocks.length ? "\n\n" : ""}${overview}`;
      if (text.length <= maxChars || cap === PROP_CAPS.at(-1)) {
        if (text.length <= maxChars || items.length <= 1) {
          const sources: GraphSource[] = items.map((r, i) => ({
            n: i + 1,
            nodeId: r.candidate.node.id,
            label: r.candidate.node.label,
            name: r.candidate.name,
            path: r.candidate.path,
            pathText: pathToText(r.candidate.path),
            snippet: snippetOf(r.candidate.node),
          }));
          return { text, sources, chars: text.length };
        }
      }
    }
    items = items.slice(0, -1);
  }
}
