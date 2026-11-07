/**
 * 에이전트 RAG 로그(§9). 허용 필드만 받는다 — 질문·인자 값·결과·근거 내용·노드 이름·오류 메시지는 타입상 넣을 수 없다.
 * rag/ 디렉터리에서는 console.*를 쓰지 않고 이 함수만 쓴다(ESLint).
 */

export type RagLogEvent =
  | "security_violation"
  | "agent_error"
  | "agent_done"
  | "agent_fallback"
  | "policy_changed"
  | "access_revoked"
  | "chunk_sync_failed"
  | "version_bump_failed"
  | "reindex_done";

export type RagLogKey = "requestId" | "threadId" | "tool" | "status" | "code" | "counts" | "ms" | "step" | "name";
export type RagLogFields = Partial<Record<RagLogKey, string | number>>;

const ALLOWED: readonly RagLogKey[] = ["requestId", "threadId", "tool", "status", "code", "counts", "ms", "step", "name"];

/** 테스트가 로그 인자를 확인할 수 있게 sink를 바꿀 수 있다(요청 상태가 아니라 출력 대상이라 모듈 전역 가변 상태 규칙의 예외). */
export const ragLogSink: { write: (line: string) => void } = {
  // eslint-disable-next-line no-console -- 이 파일만 출력한다(허용 필드만).
  write: (line) => console.info(line),
};

export function ragLog(event: RagLogEvent, fields: RagLogFields = {}): void {
  const safe: Record<string, string | number> = {};
  for (const k of ALLOWED) {
    const v = fields[k];
    if (typeof v === "number" && Number.isFinite(v)) safe[k] = v;
    else if (typeof v === "string") safe[k] = v.replace(/[^\w.:,=\-]/g, "").slice(0, 80);
  }
  ragLogSink.write(`[rag] ${event} ${JSON.stringify(safe)}`);
}
