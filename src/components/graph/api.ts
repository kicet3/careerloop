/**
 * 경력 그래프 API 응답 타입과 브라우저용 호출 도우미(GET /api/graph, POST /api/graph/ops).
 * 그래프가 바뀌면 window에 GRAPH_CHANGED_EVENT를 보낸다 — 채팅 패널이 변경안을 적용했을 때도 같은 이벤트를 쓴다.
 */
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import type { ApplyGraphOpsResult, CareerGraph, GraphOp } from "@/lib/domain/graph";

export interface GraphResponse {
  graph: CareerGraph;
}

export interface ApplyOpsResponse extends ApplyGraphOpsResult {
  graph: CareerGraph;
}

/** 그래프가 바뀌었음을 알리는 window 이벤트. detail.source가 "editor"면 편집 화면이 보낸 것(이미 반영됨). */
export const GRAPH_CHANGED_EVENT = "career-graph:changed";

export function emitGraphChanged(source: string): void {
  window.dispatchEvent(new CustomEvent(GRAPH_CHANGED_EVENT, { detail: { source } }));
}

export class GraphApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "GraphApiError";
  }
}

async function readError(res: Response): Promise<GraphApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  const message = typeof body?.error === "string" ? body.error : `요청이 실패했습니다 (${res.status}).`;
  return new GraphApiError(message, res.status);
}

export async function fetchGraph(signal?: AbortSignal): Promise<CareerGraph> {
  const res = await fetch("/api/graph", { cache: "no-store", signal });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as GraphResponse).graph;
}

export async function postGraphOps(ops: GraphOp[]): Promise<ApplyOpsResponse> {
  const res = await fetch("/api/graph/ops", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ops }),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as ApplyOpsResponse;
}

/** 그래프 채팅을 미리 채운 입력으로 여는 주소(공고 대조·경험 체크리스트가 쓴다). 보내기는 사용자가 누른다. */
export function graphChatHref(message: string): string {
  return `/app/graph?ask=${encodeURIComponent(message.slice(0, MAX_CHAT_MESSAGE_CHARS))}#graph-chat`;
}

/** 같은 화면의 그래프 채팅에 미리 채울 문장을 보내는 window 이벤트. 받은 쪽이 preventDefault()로 처리했다고 알린다. */
export const GRAPH_CHAT_ASK_EVENT = "graph-chat:ask";

/**
 * 같은 화면에 그래프 채팅이 있으면 입력을 바로 채우고 새 대화로 연다(같은 문구를 다시 눌러도 동작한다 — ?ask= 주소는
 * 값이 같으면 다시 채우지 않는다). 받은 채팅이 없으면 false: 호출자가 graphChatHref로 이동한다.
 */
export function askGraphChat(message: string): boolean {
  const ev = new CustomEvent<{ message: string }>(GRAPH_CHAT_ASK_EVENT, {
    detail: { message: message.slice(0, MAX_CHAT_MESSAGE_CHARS) },
    cancelable: true,
  });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** 그래프 화면에서 노드 하나를 보여 달라는 window 이벤트(그래프에 묻기의 출처 칩이 보낸다). */
export const GRAPH_FOCUS_EVENT = "career-graph:focus";

export interface GraphFocusDetail {
  id: string;
  /** 함께 강조할 경로 노드 id(본인 → … → 이 노드). */
  pathIds?: string[];
}

/** 같은 화면의 그래프 보기에 노드를 선택·강조하게 한다. 받은 쪽이 없으면 false. */
export function focusGraphNode(id: string, pathIds?: string[]): boolean {
  const ev = new CustomEvent<GraphFocusDetail>(GRAPH_FOCUS_EVENT, { detail: { id, pathIds }, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}
