import "server-only";
/**
 * 새 기능(그래프·채팅·이력서) 라우트 공용 오류 응답. 기능 오류는 메시지·상태 그대로, LLM 실패는 사용자 문구(502),
 * 나머지는 진단 라우트와 같은 처리(diagnoses/http.ts errorResponse: 서비스 오류는 그대로, 그 밖은 로그 후 500).
 */
import Anthropic from "@anthropic-ai/sdk";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { GraphOpError, GraphUnavailableError } from "@/lib/graph/errors";
import { LlmPermanentError } from "@/lib/llm/types";
import { stageErrorMessage } from "@/lib/panel/runner";
import { StorageConfigError, StorageKeyError } from "@/lib/storage";

/** 기능 모듈이 사용자에게 그대로 보여도 되는 오류를 던질 때 쓴다(예: 404·409). */
export class FeatureError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "FeatureError";
  }
}

export function featureErrorResponse(err: unknown, context: string): Response {
  if (err instanceof FeatureError || err instanceof GraphOpError || err instanceof GraphUnavailableError || err instanceof StorageKeyError) {
    return jsonError(err.message, err.status);
  }
  if (err instanceof StorageConfigError) {
    // 운영 설정 누락(시작 검사를 통과했다면 생기지 않는다) — 로그를 남기고 503 안내.
    console.error(`[${context}]`, err.message);
    return jsonError("저장소가 아직 준비되지 않았습니다. 잠시 후 다시 시도해 주세요.", err.status);
  }
  if (err instanceof LlmPermanentError) {
    console.warn(`[${context}] LLM 실패: ${err.reason}`);
    return jsonError(stageErrorMessage(err).replace("이 단계의 ", ""), 502);
  }
  if (isGraphConnectionError(err)) {
    // 일시 장애: 스택 대신 한 줄 경고, 클라이언트에는 503(버그인 500과 구분).
    console.warn(`[${context}] Neo4j 연결 실패: ${(err as { code?: unknown }).code ?? ""} ${(err as Error).message.slice(0, 200)}`);
    return jsonError("경력 그래프 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  }
  const llmStatus = transientLlmStatus(err);
  if (llmStatus !== null) {
    console.warn(`[${context}] LLM 호출 실패: ${(err as Error).name} ${(err as Error).message.slice(0, 200)}`);
    // SDK 연결 오류는 name이 'Error'라 stageErrorMessage가 알아보지 못한다: 문구를 직접 고른다.
    const message =
      err instanceof Anthropic.APIConnectionError ? "AI 서비스에 연결하지 못했습니다. 잠시 뒤 다시 시도해 주세요." : stageErrorMessage(err);
    return jsonError(message, llmStatus);
  }
  return errorResponse(err, context);
}

/** Neo4j 드라이버의 연결·세션 오류(서버 꺼짐·재시작·연결 획득 시간 초과). 드라이버를 불러오지 않고 이름·코드로 본다. */
export function isGraphConnectionError(err: unknown): boolean {
  if (!(err instanceof Error) || err.name !== "Neo4jError") return false;
  const e = err as Error & { code?: unknown; retryable?: unknown; retriable?: unknown };
  return (
    e.code === "ServiceUnavailable" ||
    e.code === "SessionExpired" ||
    e.retryable === true ||
    e.retriable === true ||
    /connection acquisition timed out/i.test(e.message)
  );
}

/**
 * LlmPermanentError가 아닌 LLM 호출 오류(Anthropic SDK의 429·5xx·연결 오류, CLI 과부하 status 529)면 응답 상태, 아니면 null.
 * 한도·과부하·연결 오류는 503(잠시 뒤 재시도), 그 밖의 상태 오류는 502. 문구는 진단과 같은 stageErrorMessage.
 */
export function transientLlmStatus(err: unknown): number | null {
  if (!(err instanceof Error)) return null;
  if (err instanceof Anthropic.APIConnectionError) return 503;
  const status = (err as { status?: unknown }).status;
  // 상태를 가진 다른 서비스 오류(IngestError 등 하위 클래스)는 errorResponse가 처리한다: SDK 오류와 CLI가 던지는 일반 Error만 본다.
  const llmLike = err instanceof Anthropic.APIError || err.constructor === Error;
  if (typeof status !== "number" || !llmLike) return null;
  if (status === 429 || status === 529 || status >= 500) return 503;
  return 502;
}
