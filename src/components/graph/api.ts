/**
 * 경력 그래프 API 응답 타입과 브라우저용 호출 도우미(GET /api/graph, POST /api/graph/ops).
 * 그래프가 바뀌면 window에 GRAPH_CHANGED_EVENT를 보낸다 — 채팅 패널이 변경안을 적용했을 때도 같은 이벤트를 쓴다.
 */
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
