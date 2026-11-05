/**
 * HTTP 요청 안에서 LLM을 기다리는 경로(심사위원 채팅·이력서 초안)의 전체 시간 상한. CLI 엔진은 호출 1회 상한이 15분이고
 * 슬롯 대기·재요청이 더해지므로, 요청 signal만 넘기면 수십 분까지 붙잡힐 수 있다.
 * 상한에 걸리면 LLM 호출을 중단하고 사용자에게 보일 FeatureError(504)로 바꾼다. 클라이언트가 먼저 끊은 경우는 그대로 던진다.
 */
import { FeatureError } from "@/lib/api/errors";

/** 라우트 maxDuration(300초) 안에 응답하도록 잡는다. */
export const INTERACTIVE_LLM_TIMEOUT_MS = 240_000;

export async function withLlmDeadline<T>(
  signal: AbortSignal | undefined,
  run: (signal: AbortSignal) => Promise<T>,
  opts: { timeoutMs?: number; message?: string } = {},
): Promise<T> {
  const timeout = AbortSignal.timeout(opts.timeoutMs ?? INTERACTIVE_LLM_TIMEOUT_MS);
  const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
  try {
    return await run(combined);
  } catch (err) {
    if (timeout.aborted && !signal?.aborted) {
      throw new FeatureError(opts.message ?? "AI 답변이 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해 주세요.", 504);
    }
    throw err;
  }
}
