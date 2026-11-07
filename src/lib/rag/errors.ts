/**
 * 에이전트 RAG 오류(docs/AGENTIC-GRAPH-RAG.md §7.4, §8.6). 세 경우를 구분한다(사양 테스트 17):
 * - empty: 정상적으로 0건(LLM에 {status:"empty"}로 돌려준다 — 오류가 아니다).
 * - query_error: 계획 거부·시간 초과·저장소 오류(LLM에 {status:"error", code}로 돌려주고 루프는 계속된다).
 * - security_violation: 검증 실패(SecurityViolation). LLM에 돌려주지 않고 요청 전체를 중단한다. 대체 경로(기존 QA)로도 넘어가지 않는다.
 * 원래 오류의 message·cause·stack은 밖으로 내보내지 않는다(sanitizeError) — Prisma·드라이버 오류에는 파라미터·원문 일부가 실릴 수 있다.
 */

export const SECURITY_CODES = Object.freeze([
  "foreign_node",
  "foreign_edge",
  "unowned_node",
  "chunk_owner_mismatch",
  "source_owner_mismatch",
  "aggregate_mismatch",
  "derived_foreign_input",
  "unknown_label",
  "unknown_kind",
  "policy_changed",
] as const);
export type SecurityCode = (typeof SECURITY_CODES)[number];

/** 검증 실패 — fail-closed. 메시지는 코드뿐이다(데이터·id를 담지 않는다). */
export class SecurityViolation extends Error {
  constructor(readonly code: SecurityCode) {
    super(code);
    this.name = "SecurityViolation";
  }
}

/** 요청 도중 권한 버전이 바뀜(정지·동의 철회·비밀번호 변경). LLM을 더 부르지 않고 멈춘다. */
export class PolicyChangedError extends Error {
  constructor() {
    super("policy_changed");
    this.name = "PolicyChangedError";
  }
}

/** 요청 시작 시 사용자가 승인 상태가 아니거나 필수 동의가 없다(after() 안에서 다시 확인). */
export class AccessRevokedError extends Error {
  constructor() {
    super("access_revoked");
    this.name = "AccessRevokedError";
  }
}

/** 도구 실행의 쿼리 오류(데이터 없음). LLM에 code만 돌려준다. */
export type QueryErrorCode = "invalid_args" | "plan_rejected" | "not_found" | "timeout" | "unavailable" | "too_broad" | "budget";
export class ToolQueryError extends Error {
  constructor(
    readonly code: QueryErrorCode,
    readonly hint?: string,
  ) {
    super(code);
    this.name = "ToolQueryError";
  }
}

export type RagErrorKind = "empty" | "query_error" | "security_violation" | "access_revoked" | "unavailable" | "llm" | "timeout" | "internal";

/** 정제된 오류: 종류·코드·원래 오류 이름만. */
export class RagError extends Error {
  constructor(
    readonly kind: RagErrorKind,
    readonly code: string,
    readonly originalName?: string,
  ) {
    super(`${kind}:${code}`);
    this.name = "RagError";
  }
}

/** 임의 오류 → RagError(메시지·스택·cause는 버린다). */
export function sanitizeError(err: unknown): RagError {
  if (err instanceof RagError) return err;
  if (err instanceof SecurityViolation) return new RagError("security_violation", err.code, err.name);
  if (err instanceof PolicyChangedError) return new RagError("access_revoked", "policy_changed", err.name);
  if (err instanceof AccessRevokedError) return new RagError("access_revoked", "access_revoked", err.name);
  if (err instanceof ToolQueryError) return new RagError("query_error", err.code, err.name);
  const name = err instanceof Error ? err.name : typeof err;
  // 그래프 소유자 표시가 요청 사용자와 다름(graph/owner.ts) — 다른 사용자의 그래프가 섞였다: 보안 실패.
  if (name === "GraphOwnerMismatchError") return new RagError("security_violation", "unowned_node", name);
  if (name === "GraphUnavailableError") return new RagError("unavailable", "graph_unavailable", name);
  if (name === "LlmPermanentError") {
    const reason = (err as { reason?: unknown }).reason;
    return new RagError("llm", typeof reason === "string" ? reason : "unknown", name);
  }
  if (name === "TimeoutError" || name === "AbortError") return new RagError("timeout", "timeout", name);
  return new RagError("internal", "internal", name.slice(0, 40));
}
