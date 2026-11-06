/**
 * 경험 그래프 → LLM 프롬프트용 텍스트(순수 함수). id를 함께 적어 LLM이 updateNode·addEdge에서 기존 노드를 가리킬 수 있게 한다.
 * 사용자가 입력한 값이므로 호출자가 데이터 태그로 감싸고 neutralize한다(chat/prompt.ts wrapData).
 */
import {
  type CareerGraph,
  type GraphNode,
  NODE_LABEL_META,
  NODE_LABELS,
  NODE_TITLE_KEY,
  nodeDisplayName,
  PERSON_ID,
  REL_RULES,
} from "@/lib/domain/graph";

const DEFAULT_MAX_CHARS = 12_000;

/** 속성 값 상한을 줄여 가며 맞춰 본다(0이면 속성 없이 이름만). */
const PROP_CAPS = [200, 120, 60, 30, 0] as const;

function propsText(node: GraphNode, cap: number): string {
  if (cap <= 0) return "";
  const titleKey = NODE_TITLE_KEY[node.label];
  const parts = Object.entries(node.props as Record<string, unknown>)
    .filter(([k, v]) => k !== titleKey && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `${k}=${(Array.isArray(v) ? v.join("|") : String(v)).replace(/\s+/g, " ").slice(0, cap)}`);
  return parts.length ? ` (${parts.join(", ")})` : "";
}

interface Section {
  header: string;
  /** 생략 안내에 쓸 이름(예: "회사", "관계"). */
  what: string;
  lines: string[];
}

const sectionLength = (sec: Section) => sec.header.length + 1 + sec.lines.reduce((n, l) => n + l.length + 1, 0);
const joinSections = (secs: Section[]) => secs.map((sec) => [sec.header, ...sec.lines].join("\n")).join("\n");

/**
 * 경험 그래프를 글자 상한 안의 텍스트로. 관계는 노드 바로 뒤가 아니라 맨 끝에 오므로, 앞에서부터 자르면 관계와 뒤쪽 라벨
 * (학력·자격증)이 먼저 사라진다. 그래서 (1) 속성 값을 짧게 줄여 가며 전체를 맞춰 보고, (2) 그래도 넘치면 라벨·관계 구역마다
 * 몫을 나눠 각 구역의 앞부분을 남기고 구역별로 무엇을 몇 개 생략했는지 적는다.
 */
export function graphToText(graph: CareerGraph, opts: { maxChars?: number } = {}): string {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  if (graph.nodes.length === 0) return "(아직 정리된 경력·경험이 없다)";
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const name = (id: string) => (id === PERSON_ID ? "나(me)" : `${byId.get(id) ? nodeDisplayName(byId.get(id)!) : "?"}[${id}]`);
  const edgeLines = graph.edges.map((e) => `- ${name(e.from)} -${e.type}(${REL_RULES[e.type].name})-> ${name(e.to)}`);

  const sectionsWith = (cap: number): Section[] => {
    const secs: Section[] = [];
    for (const label of NODE_LABELS) {
      const nodes = graph.nodes.filter((n) => n.label === label);
      if (nodes.length === 0) continue;
      secs.push({
        header: `## ${NODE_LABEL_META[label].name} (${label})`,
        what: NODE_LABEL_META[label].name,
        lines: nodes.map((n) => `- [${n.id}] ${nodeDisplayName(n)}${propsText(n, cap)}`),
      });
    }
    if (edgeLines.length > 0) secs.push({ header: "## 관계", what: "관계", lines: edgeLines });
    return secs;
  };

  for (const cap of PROP_CAPS) {
    const text = joinSections(sectionsWith(cap));
    if (text.length <= maxChars) return text;
  }

  // 이름만으로도 넘친다: 구역마다 몫을 나눈다(작은 구역부터 채우고 남은 몫은 다음 구역으로 넘긴다).
  const secs = sectionsWith(0);
  const kept = new Map<Section, string[]>();
  let remaining = maxChars;
  const order = [...secs].sort((a, b) => sectionLength(a) - sectionLength(b));
  order.forEach((sec, i) => {
    const share = Math.floor(remaining / (order.length - i));
    const note = (n: number) => `… (생략: ${sec.what} ${n}개 — 그래프가 길어 줄였다)`;
    let used = sec.header.length + 1;
    const lines: string[] = [];
    for (const [j, line] of sec.lines.entries()) {
      const rest = sec.lines.length - j - 1;
      const reserve = rest > 0 ? note(rest).length + 1 : 0;
      if (used + line.length + 1 + reserve > share) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (lines.length < sec.lines.length) {
      const n = sec.lines.length - lines.length;
      lines.push(note(n));
      used += note(n).length + 1;
    }
    kept.set(sec, lines);
    remaining -= used;
  });
  return joinSections(secs.map((sec) => ({ ...sec, lines: kept.get(sec)! })));
}
