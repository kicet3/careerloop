/**
 * Vercel ↔ Python 워커 요청 서명(HMAC-SHA256, docs/PYTHON-WORKER.md §3.2). 양방향 같은 규칙이고 Python 쪽은 worker/app/security/hmac.py다.
 * 순수 모듈(server-only 없음) — 공유 테스트 벡터(worker/tests/fixtures/hmac_vectors.json)를 만드는 스크립트도 이 파일을 쓴다.
 *
 * 서명 = HMAC-SHA256(secret, "worker.v1." + ts + "." + METHOD + "." + path + "." + sha256hex(body))
 * 헤더: X-Worker-Timestamp(unix 초), X-Worker-Signature("v1=" + hex). 허용 오차 ±60초, 비교는 상수 시간.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const TIMESTAMP_HEADER = "X-Worker-Timestamp";
export const SIGNATURE_HEADER = "X-Worker-Signature";
export const SIGNATURE_PREFIX = "v1=";
/** 서명 시각 허용 오차(초). */
export const MAX_CLOCK_SKEW_SEC = 60;
/** 비밀값 최소 길이. 이보다 짧으면 워커는 시작하지 않고, Next.js는 워커로 보내지 않는다. */
export const MIN_SECRET_LENGTH = 32;

export function sha256Hex(body: string | Uint8Array): string {
  return createHash("sha256").update(body).digest("hex");
}

/** 서명할 문자열. method는 대문자로, path는 쿼리 없는 경로(예: /v1/jobs/resume-draft). */
export function canonicalString(ts: string, method: string, path: string, body: string | Uint8Array): string {
  return `worker.v1.${ts}.${method.toUpperCase()}.${path}.${sha256Hex(body)}`;
}

export function signRequest(secret: string, ts: string, method: string, path: string, body: string | Uint8Array): string {
  return SIGNATURE_PREFIX + createHmac("sha256", secret).update(canonicalString(ts, method, path, body)).digest("hex");
}

/** 요청에 붙일 헤더. nowSec는 테스트용. */
export function signedHeaders(
  secret: string,
  method: string,
  path: string,
  body: string | Uint8Array,
  nowSec: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const ts = String(nowSec);
  return { [TIMESTAMP_HEADER]: ts, [SIGNATURE_HEADER]: signRequest(secret, ts, method, path, body) };
}

export type VerifyFailure = "missing" | "malformed" | "expired" | "mismatch";

/** 서명 확인. 통과하면 null, 아니면 실패 사유(응답에는 사유를 싣지 않는다 — 로그용). */
export function verifySignature(
  secret: string,
  headers: { timestamp: string | null | undefined; signature: string | null | undefined },
  method: string,
  path: string,
  body: string | Uint8Array,
  nowSec: number = Math.floor(Date.now() / 1000),
): VerifyFailure | null {
  const { timestamp, signature } = headers;
  if (!timestamp || !signature) return "missing";
  if (!/^\d{1,12}$/.test(timestamp) || !signature.startsWith(SIGNATURE_PREFIX) || !/^[0-9a-f]{64}$/.test(signature.slice(SIGNATURE_PREFIX.length))) {
    return "malformed";
  }
  if (Math.abs(nowSec - Number(timestamp)) > MAX_CLOCK_SKEW_SEC) return "expired";
  const expected = Buffer.from(signRequest(secret, timestamp, method, path, body));
  const got = Buffer.from(signature);
  if (expected.length !== got.length || !timingSafeEqual(expected, got)) return "mismatch";
  return null;
}
