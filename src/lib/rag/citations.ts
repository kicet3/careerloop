import "server-only";
/**
 * 저장된 답의 인용 재검증(§9 "삭제와 권한 변경") — 화면에서 볼 때마다, 그리고 다음 질문의 이전 대화를 만들 때 쓴다.
 * 스레드 소유 확인(requireQaThread) 뒤에만 부른다. 그래프 근거(노드·관계·경로·집계)는 본인 그래프(getCareerGraph)로 만든 스냅샷에서
 * 최종 검증(final-validate.ts graphRefStillValid)과 같은 규칙으로 — 경로는 모든 간선과 노드 해시, 집계는 저장한 계획을 다시 계산한다.
 * 청크·원문 구간은 출처를 소유 조건으로 다시 읽어 구간 해시를 비교한다(청크 행 id가 아니라 출처 기준 — 같은 글을 다시 색인해도 유효).
 * 같은 출처는 한 번만 읽는다(가벼운 읽기: 본문만). 없어지거나 바뀐 근거는 exists:false로 표시하고 snippet·pathText를 응답에서 지운다.
 * sourceKey·version·inputIds·sourceRef·aggregatePlan은 서버 전용이라 화면 응답에서 지운다(toClientCitation).
 * 이전 대화(agentAnswerHistoryText)는 fail-closed: exists가 true로 확인된 인용만 인정한다(그래프를 못 읽어 미정이면 그 fact는 뺀다).
 */
import type { ChatMessage, GraphAgentAnswerData, GraphAgentCitation } from "@/lib/domain/chat";
import type { CareerGraph } from "@/lib/domain/graph";
import { readAuthoritativeForCitation } from "./chunks/authoritative";
import type { ChunkSourceType } from "./chunks/build";
import { graphRefStillValid } from "./final-validate";
import type { ValidatedPlan } from "./graph/plan";
import { sha256 } from "./hash";
import { buildOwnedSnapshot, type OwnedSnapshot } from "./snapshot";

type Ref = NonNullable<GraphAgentCitation["sourceRef"]>;
export type CitationSourceReader = (principalUserId: string, sourceType: ChunkSourceType, sourceId: string) => Promise<{ version: string; text: string | null } | null>;
type Source = { version: string; text: string | null } | null;

function snapshotOf(userId: string, graph: CareerGraph | null): OwnedSnapshot | null {
  if (!graph) return null;
  try {
    return buildOwnedSnapshot(graph, userId);
  } catch {
    // 소유자 표시가 없거나 다르면 그래프 근거를 판정하지 않는다(미정 → 화면은 표시 없이, 이전 대화에서는 뺀다).
    return null;
  }
}

/** 출처별 본문을 한 번씩만(병렬) 읽는다. */
async function readSourcesOnce(userId: string, refs: readonly Ref[], read: CitationSourceReader): Promise<Map<string, Source>> {
  const keys = [...new Map(refs.map((r) => [`${r.type}:${r.id}`, r])).values()];
  const texts = await Promise.all(keys.map((r) => read(userId, r.type, r.id).catch(() => null)));
  return new Map(keys.map((r, i) => [`${r.type}:${r.id}`, texts[i] ?? null]));
}

function spanValid(ref: Ref, src: Source | undefined): boolean {
  if (!src) return false;
  // 본문을 읽지 않는 출처(포트폴리오 글): 출처 버전(textKey)이 같으면 같은 글이다.
  if (src.text === null) return src.version === ref.version;
  const text = src.text;
  if (ref.start < 0 || ref.end > text.length || ref.end <= ref.start) return false;
  return sha256(text.slice(ref.start, ref.end)) === ref.hash;
}

function graphValid(c: GraphAgentCitation, snap: OwnedSnapshot): boolean | undefined {
  if (!c.sourceKey || c.version === undefined) return false;
  switch (c.kind) {
    case "node":
      if (c.sourceKey === "me") return true;
      return graphRefStillValid({ kind: "node", sourceKey: c.sourceKey, version: c.version, inputIds: c.inputIds ?? [] }, snap);
    case "edge":
    case "path":
      return graphRefStillValid({ kind: c.kind, sourceKey: c.sourceKey, version: c.version, inputIds: c.inputIds ?? [] }, snap);
    case "aggregate":
      return graphRefStillValid(
        { kind: "aggregate", sourceKey: c.sourceKey, version: c.version, inputIds: c.inputIds ?? [], aggregatePlan: (c.aggregatePlan as ValidatedPlan | undefined) ?? null },
        snap,
      );
    default:
      return undefined;
  }
}

/** 여러 메시지의 인용을 한 번에: 출처는 메시지 전체에서 모아 한 번씩 읽는다. graph가 null이면 그래프 근거는 미정(undefined)으로 둔다. */
async function revalidateMany(
  userId: string,
  lists: readonly (readonly GraphAgentCitation[])[],
  graph: CareerGraph | null,
  read: CitationSourceReader,
): Promise<GraphAgentCitation[][]> {
  const snap = snapshotOf(userId, graph);
  const refs = lists.flatMap((l) => l.flatMap((c) => ((c.kind === "chunk" || c.kind === "source-span") && c.sourceRef ? [c.sourceRef] : [])));
  const texts = refs.length ? await readSourcesOnce(userId, refs, read) : new Map<string, Source>();
  return lists.map((list) =>
    list.map((c) => {
      let exists: boolean | undefined;
      switch (c.kind) {
        case "node":
        case "edge":
        case "path":
        case "aggregate":
          exists = snap ? graphValid(c, snap) : undefined;
          break;
        case "chunk":
        case "source-span":
          exists = !!c.sourceRef && spanValid(c.sourceRef, texts.get(`${c.sourceRef.type}:${c.sourceRef.id}`));
          break;
        case "derived":
          // 파생 근거는 최종 검증을 통과하지 않는다(저장되지 않음). 남아 있으면 무효.
          exists = false;
          break;
      }
      return exists === undefined ? { ...c } : { ...c, exists };
    }),
  );
}

/** 인용마다 exists를 다시 계산한다. graph가 null(그래프를 못 읽음)이면 그래프 기반 인용은 표시 없이 둔다. */
export async function revalidateCitations(
  userId: string,
  citations: readonly GraphAgentCitation[],
  graph: CareerGraph | null,
  read: CitationSourceReader = readAuthoritativeForCitation,
): Promise<GraphAgentCitation[]> {
  return (await revalidateMany(userId, [citations], graph, read))[0]!;
}

/** 화면 응답용: 서버 전용 필드를 지우고, 없어진 근거는 snippet·pathText를 비운다. */
export function toClientCitation(c: GraphAgentCitation): GraphAgentCitation {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { sourceKey, version, inputIds, sourceRef, aggregatePlan, ...rest } = c;
  if (c.exists === false) return { ...rest, snippet: "", pathText: undefined };
  return rest;
}

/**
 * 이전 대화용 본문: 근거가 지금도 유효하다고 확인된(exists === true) fact만 남긴다 — 삭제·변경한 경험이 이전 답을 통해 다시 LLM에
 * 들어가지 않게. 미정(그래프를 못 읽음)도 뺀다(fail-closed). 인용 번호·근거 id는 넣지 않는다.
 */
export function agentAnswerHistoryText(data: GraphAgentAnswerData): string {
  const ok = new Map(data.citations.map((c) => [c.n, c.exists === true]));
  return data.segments
    .filter((s) => s.kind !== "fact" || (s.citations.length > 0 && s.citations.every((n) => ok.get(n) === true)))
    .map((s) => s.text)
    .join("\n");
}

/** 재검증을 못 할 때의 이전 대화 본문: fact는 모두 빼고 advice·gap만. */
export function agentAnswerHistoryTextWithoutFacts(data: GraphAgentAnswerData): string {
  return data.segments
    .filter((s) => s.kind !== "fact")
    .map((s) => s.text)
    .join("\n");
}

/** 메시지 목록의 에이전트 답 인용을 한 번에 재검증한다(출처는 메시지 전체에서 한 번씩만 읽는다). */
export async function revalidateAgentMessages(
  userId: string,
  messages: readonly ChatMessage[],
  graph: CareerGraph | null,
  read: CitationSourceReader = readAuthoritativeForCitation,
): Promise<ChatMessage[]> {
  const idx = messages.flatMap((m, i) => (m.data?.kind === "graph-agent-answer" ? [i] : []));
  if (idx.length === 0) return [...messages];
  const lists = idx.map((i) => (messages[i]!.data as GraphAgentAnswerData).citations);
  const checked = await revalidateMany(userId, lists, graph, read);
  const out = [...messages];
  idx.forEach((i, k) => {
    const m = messages[i]!;
    out[i] = { ...m, data: { ...(m.data as GraphAgentAnswerData), citations: checked[k]! } };
  });
  return out;
}

/**
 * 이전 대화에 넣을 메시지 목록: 에이전트 답 본문을 재검증된 fact + advice·gap으로 바꾼다. 재검증 자체가 실패하면 fact를 모두 뺀다.
 * 에이전트 경로와 기존 파이프라인(폴백·GRAPH_RAG 꺼짐) 모두 이 목록을 쓴다.
 */
export async function historyMessagesForPrompt(
  userId: string,
  messages: readonly ChatMessage[],
  loadGraph: () => Promise<CareerGraph | null>,
): Promise<ChatMessage[]> {
  if (!messages.some((m) => m.data?.kind === "graph-agent-answer")) return [...messages];
  let checked: ChatMessage[] | null = null;
  try {
    const graph = await loadGraph().catch(() => null);
    checked = await revalidateAgentMessages(userId, messages, graph);
  } catch {
    checked = null;
  }
  const base = checked ?? [...messages];
  return base.map((m) =>
    m.data?.kind === "graph-agent-answer" ? { ...m, content: checked ? agentAnswerHistoryText(m.data) : agentAnswerHistoryTextWithoutFacts(m.data) } : m,
  );
}
