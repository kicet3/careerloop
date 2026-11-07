/**
 * 내부 자기 호출(연쇄): 한 함수 호출의 시간 예산이 모자라면 서명된 POST /api/internal/resume-agent/advance로 다음 호출을 연다.
 * - 서명: HMAC-SHA256(RESUME_AGENT_CHAIN_SECRET, "resume-agent.v1." + jobId + "." + runId + "." + exp), exp는 2분. 길이 확인 후 timingSafeEqual.
 * - origin: 요청 Host 헤더를 믿지 않는다. APP_ORIGIN → 운영(VERCEL_ENV=production)은 운영 도메인 →
 *   미리보기는 배포 고유 주소(VERCEL_URL) + 보호 우회 비밀이 있을 때만. 그 밖은 null(폴링 안전망만).
 * 순수 함수(서명·origin)와 fetch 한 번(requestChain)만 있다.
 */
import { createHmac, timingSafeEqual } from "node:crypto";

type Env = Record<string, string | undefined>;

export const CHAIN_SIGNATURE_HEADER = "x-agent-signature";
export const CHAIN_TTL_MS = 2 * 60_000;
const PURPOSE = "resume-agent.v1.";
const MIN_SECRET_LENGTH = 32;

/** 연쇄 비밀(32자 이상). 없거나 짧으면 null — 내부 라우트는 404, 자기 호출은 꺼진다. */
export function chainSecret(env: Env = process.env): string | null {
  const s = env.RESUME_AGENT_CHAIN_SECRET?.trim() ?? "";
  return s.length >= MIN_SECRET_LENGTH ? s : null;
}

export function signAdvance(secret: string, jobId: string, runId: string, exp: number): string {
  return createHmac("sha256", secret).update(`${PURPOSE}${jobId}.${runId}.${exp}`).digest("hex");
}

/** 서명·만료 확인. exp는 now ~ now + TTL(+5초 시계 오차) 안이어야 한다. */
export function verifyAdvance(secret: string, msg: { jobId: string; runId: string; exp: number; signature: string }, now: number = Date.now()): boolean {
  if (!Number.isSafeInteger(msg.exp) || msg.exp < now || msg.exp > now + CHAIN_TTL_MS + 5_000) return false;
  if (!/^[0-9a-f]{64}$/.test(msg.signature)) return false;
  const expected = Buffer.from(signAdvance(secret, msg.jobId, msg.runId, msg.exp), "hex");
  const got = Buffer.from(msg.signature, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** 연쇄 대상 origin. null이면 자기 호출을 하지 않는다. */
export function chainOrigin(env: Env = process.env): string | null {
  const explicit = env.APP_ORIGIN?.trim();
  if (explicit) {
    try {
      return new URL(explicit).origin;
    } catch {
      return null;
    }
  }
  if (env.VERCEL_ENV === "production" && env.VERCEL_PROJECT_PRODUCTION_URL) return `https://${env.VERCEL_PROJECT_PRODUCTION_URL}`;
  if (env.VERCEL_ENV === "preview" && env.VERCEL_URL && env.VERCEL_AUTOMATION_BYPASS_SECRET) return `https://${env.VERCEL_URL}`;
  return null;
}

/** 연쇄가 가능한 배포인가(비밀 + origin). 진행 화면 안내 문구에 쓴다. */
export function chainEnabled(env: Env = process.env): boolean {
  return chainSecret(env) !== null && chainOrigin(env) !== null;
}

export type ChainResult = { ok: true } | { ok: false; error: string };

/** 다음 호출 요청(202만 기다린다, 5초 상한). 실패해도 던지지 않는다(안전망이 이어 간다). */
export async function requestChain(job: { id: string; runId: string }, env: Env = process.env, fetchImpl: typeof fetch = fetch, now: number = Date.now()): Promise<ChainResult> {
  const secret = chainSecret(env);
  const origin = chainOrigin(env);
  if (!secret || !origin) return { ok: false, error: "chain_disabled" };
  const exp = now + CHAIN_TTL_MS;
  const headers: Record<string, string> = { "Content-Type": "application/json", [CHAIN_SIGNATURE_HEADER]: signAdvance(secret, job.id, job.runId, exp) };
  if (env.VERCEL_ENV === "preview" && env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
  try {
    const res = await fetchImpl(`${origin}/api/internal/resume-agent/advance`, {
      method: "POST",
      headers,
      body: JSON.stringify({ jobId: job.id, runId: job.runId, exp }),
      signal: AbortSignal.timeout(5_000),
    });
    return res.status === 202 ? { ok: true } : { ok: false, error: `status_${res.status}` };
  } catch (err) {
    return { ok: false, error: ((err as Error)?.name ?? "error").slice(0, 60) };
  }
}
