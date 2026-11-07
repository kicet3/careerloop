/**
 * 그래프 변경안의 기간 정리(순수). proposalFromOutput(graph-chat.ts)이 쓴다. 날짜 형식·미래·순서 검사는 plan.ts(sanitizeOpDates)가 하고,
 * 여기서는 '근거가 없는 기간'을 다룬다.
 * - guardInheritedPeriods: 프로젝트 기간이 그 프로젝트가 속한 직무(Role) 기간과 똑같고, 사용자가 그 기간을 말한 적이 없으면 뺀다
 *   (LLM이 그래프의 직무 기간을 하위 프로젝트에 그대로 옮기던 문제). 빠진 기간은 프로젝트 체크리스트('기간·소속')가 한 번 묻는다.
 * - applyRepoPeriod: GitHub 저장소 가져오기에서 기간은 LLM이 아니라 회원님 커밋 기록(첫·최근 커밋 달)으로 넣는다. 이미 있는 값은
 *   덮어쓰지 않고, 진행 중인지는 추측하지 않는다(종료 = 최근 커밋 달, 답변에 확인을 부탁한다).
 */
import { type CareerGraph, type GraphOp, NODE_LABEL_META, type NodeLabel, nodeDisplayName } from "@/lib/domain/graph";
import { datesMentioned, kstMonthOf, mentionedIn, parseGraphDate } from "@/lib/domain/graph-dates";
import type { RepoFacts } from "@/lib/github/types";

type Props = Record<string, unknown>;

/** 사용자가 '직무 기간 그대로'라고 말한 표현(이 경우 직무 기간을 옮겨도 된다). */
const SAME_AS_ROLE_RE =
  /입사\s*(?:때|했을\s*때|하고|한\s*뒤|후)?\s*부터|합류\s*(?:때|했을\s*때|한\s*뒤|후)?\s*부터|처음부터\s*(?:지금|끝|현재|퇴사)|(?:재직|근무|직무)\s*기간\s*(?:내내|동안|전체|과\s*같|이랑\s*같|그대로)|같은\s*기간|(?:입사|재직|근무)\s*(?:내내|기간\s*내내)|퇴사\s*(?:때|할\s*때)\s*까지/;

const dateOf = (v: unknown): string | null => {
  if (typeof v !== "string" || !v.trim()) return null;
  const p = parseGraphDate(v);
  return p.kind === "date" ? p.value : null;
};

interface Period {
  start: string | null;
  end: string | null;
  current: boolean;
}
const periodOf = (p: Props): Period => ({ start: dateOf(p.startDate), end: dateOf(p.endDate), current: p.current === true });

/** 노드 참조(기존 id 또는 같은 변경안의 new: ref) → 라벨·속성(변경안에서 만든·고친 값을 얹는다). */
function nodeIndex(graph: CareerGraph, ops: readonly GraphOp[]): Map<string, { label: NodeLabel; props: Props; name: string }> {
  const idx = new Map<string, { label: NodeLabel; props: Props; name: string }>();
  for (const n of graph.nodes) idx.set(n.id, { label: n.label, props: { ...(n.props as Props) }, name: nodeDisplayName(n) });
  for (const op of ops) {
    if (op.op === "addNode") idx.set(op.ref, { label: op.label, props: { ...(op.props as Props) }, name: nodeDisplayName(op) });
    else if (op.op === "updateNode") {
      const cur = idx.get(op.id);
      if (cur) cur.props = { ...cur.props, ...(op.props as Props) };
    }
  }
  return idx;
}

/** 이 프로젝트(id 또는 ref)를 WORKED_ON으로 가리키는 직무(그래프 + 이 변경안). */
function parentRoles(graph: CareerGraph, ops: readonly GraphOp[], projectKey: string, idx: ReturnType<typeof nodeIndex>): string[] {
  const out = new Set<string>();
  for (const e of graph.edges) if (e.type === "WORKED_ON" && e.to === projectKey && idx.get(e.from)?.label === "Role") out.add(e.from);
  for (const op of ops) if (op.op === "addEdge" && op.type === "WORKED_ON" && op.to === projectKey && idx.get(op.from)?.label === "Role") out.add(op.from);
  return [...out];
}

/**
 * 프로젝트 기간이 소속 직무 기간과 똑같은데(시작과 종료·진행 중이 모두 같다) 사용자가 그 기간을 말한 근거(evidenceText에 그 연월이 있거나
 * '입사 때부터' 같은 표현)가 없으면 그 프로젝트 연산에서 기간(startDate·endDate·current)을 뺀다.
 * evidenceText: 그래프 채팅은 이 대화의 사용자 메시지, 문서 가져오기는 문서 원문.
 */
export function guardInheritedPeriods(
  ops: readonly GraphOp[],
  graph: CareerGraph,
  evidenceText: string,
  today?: string,
): { ops: GraphOp[]; dropped: string[] } {
  const idx = nodeIndex(graph, ops);
  const mentioned = datesMentioned(evidenceText, today);
  const sameAsRole = SAME_AS_ROLE_RE.test(evidenceText.normalize("NFKC"));
  const dropped: string[] = [];
  const out = ops.map((op): GraphOp => {
    if ((op.op !== "addNode" && op.op !== "updateNode") || op.label !== "Project") return op;
    const given = op.props as Props;
    // 이 연산이 시작 시점을 넣을 때만 본다 — 종료·진행 중만 고치는 답("아직 진행 중이에요")은 이미 있던 시작과 상관없이 사용자 말이다.
    if (!("startDate" in given)) return op;
    const key = op.op === "addNode" ? op.ref : op.id;
    const mine = periodOf(idx.get(key)?.props ?? given);
    if (!mine.start || (!mine.end && !mine.current)) return op;
    const copied = parentRoles(graph, ops, key, idx).some((rid) => {
      const role = periodOf(idx.get(rid)!.props);
      return role.start === mine.start && role.current === mine.current && (mine.current || role.end === mine.end);
    });
    if (!copied || sameAsRole) return op;
    const said = mentionedIn(mine.start, mentioned) && (mine.current || (mine.end !== null && mentionedIn(mine.end, mentioned)));
    if (said) return op;
    const props = { ...given };
    for (const k of ["startDate", "endDate", "current"]) delete props[k];
    const name = idx.get(key)?.name ?? NODE_LABEL_META.Project.name;
    dropped.push(`‘${name}’의 기간 — 소속 직무 기간을 그대로 옮긴 값이라 뺐습니다(프로젝트 기간은 따로 여쭤볼게요)`);
    return { ...op, props } as GraphOp;
  });
  // 기간만 고치려던 updateNode는 남은 속성이 없으면 뺀다.
  return { ops: out.filter((o) => o.op !== "updateNode" || Object.keys(o.props).length > 0), dropped };
}

export interface RepoPeriod {
  start: string | null;
  end: string | null;
  /** commits: 회원님 첫·최근 커밋. repo: 내 저장소의 생성·최근 반영(내 커밋 기록을 못 읽었을 때). */
  source: "commits" | "repo";
}

/** 저장소 사실 → 프로젝트 기간(KST 달). 남의 저장소에서 내 커밋을 못 읽었으면 null(저장소 생성일은 내 기간이 아니다). */
export function repoPeriod(facts: Pick<RepoFacts, "owner" | "createdAt" | "pushedAt" | "my">): RepoPeriod | null {
  const first = kstMonthOf(facts.my.firstCommitAt);
  const last = kstMonthOf(facts.my.lastCommitAt);
  let period: RepoPeriod | null = null;
  if (first || last) period = { start: first, end: last, source: "commits" };
  else if (facts.owner.toLowerCase() === facts.my.login.toLowerCase()) {
    const created = kstMonthOf(facts.createdAt);
    const pushed = kstMonthOf(facts.pushedAt);
    if (created || pushed) period = { start: created, end: pushed, source: "repo" };
  }
  if (period?.start && period.end && period.start > period.end) return { ...period, end: null };
  return period;
}

/**
 * 저장소 가져오기 변경안의 기간을 커밋 기록으로 바꾼다. LLM이 이 프로젝트에 넣은 기간은 버리고, 프로젝트에 비어 있는 것만 채운다
 * (사용자가 넣은 기간·진행 중 표시는 건드리지 않는다). 넣은 것이 있으면 note(답변에 덧붙일 확인 요청)를 준다.
 */
export function applyRepoPeriod(
  ops: readonly GraphOp[],
  graph: CareerGraph,
  focusId: string,
  period: RepoPeriod | null,
): { ops: GraphOp[]; note: string | null } {
  const project = graph.nodes.find((n) => n.id === focusId && n.label === "Project");
  const stripped = ops
    .map((op): GraphOp => {
      if (op.op !== "updateNode" || op.id !== focusId) return op;
      const props = { ...(op.props as Props) };
      for (const k of ["startDate", "endDate", "current"]) delete props[k];
      return { ...op, props } as GraphOp;
    })
    .filter((o) => o.op !== "updateNode" || Object.keys(o.props).length > 0);
  if (!project || !period) return { ops: stripped, note: null };
  const cur = periodOf(project.props as Props);
  const fill: Props = {};
  if (!cur.start && period.start) fill.startDate = period.start;
  if (!cur.end && !cur.current && period.end && (cur.start ?? period.start ?? "") <= period.end) fill.endDate = period.end;
  if (Object.keys(fill).length === 0) return { ops: stripped, note: null };
  const at = stripped.findIndex((o) => o.op === "updateNode" && o.id === focusId);
  const next = [...stripped];
  if (at >= 0) {
    const o = next[at]!;
    next[at] = { ...o, props: { ...(o as { props: Props }).props, ...fill } } as GraphOp;
  } else next.unshift({ op: "updateNode", id: focusId, label: "Project", props: fill } as GraphOp);
  const basis = period.source === "commits" ? "회원님 커밋 기록" : "저장소 생성·최근 반영 날짜";
  const range = `${String(fill.startDate ?? cur.start ?? "?")} ~ ${String(fill.endDate ?? cur.end ?? "?")}`;
  return {
    ops: next,
    note: `기간은 ${basis} 기준(${range})으로 넣었어요. 실제 진행 기간과 다르거나 지금도 진행 중이면 알려 주세요.`,
  };
}
