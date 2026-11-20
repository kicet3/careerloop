/**
 * 내부 자기 호출(연쇄): 한 함수 호출의 시간 예산이 모자라면 서명된 POST /api/internal/resume-agent/advance로 다음 호출을 연다.
 * - 서명: HMAC-SHA256(RESUME_AGENT_CHAIN_SECRET, "resume-agent.v1." + jobId + "." + runId + "." + exp), exp는 2분. 길이 확인 후 timingSafeEqual.
 * - 실행기(맥미니): RESUME_AGENT_RUNNER_URL이 있으면 같은 서명 호출을 그 서버로 보낸다 — 단계 실행은 실행기가 하고(자체 호스팅 예산 20분),
 *   이 배포(Vercel)는 작업 행 만들기·상태 조회만 한다. 실행기 쪽은 RESUME_AGENT_RUNNER=1(자기에게는 넘기지 않는다). deploy/agent/README.md.
 * - origin: 요청 Host 헤더를 믿지 않는다. 실행기 주소 → APP_ORIGIN → 운영(VERCEL_ENV=production)은 운영 도메인 →
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

/** 두 서버(Vercel ↔ 실행기)의 시계 차이 허용 폭. 같은 서명을 다시 보내도 리스·runId가 중복 실행을 막는다. */
export const CHAIN_CLOCK_SKEW_MS = 60_000;

/** 서명·만료 확인. exp는 now ~ now + TTL 안이어야 한다(양쪽으로 시계 오차 CHAIN_CLOCK_SKEW_MS 허용). */
export function verifyAdvance(secret: string, msg: { jobId: string; runId: string; exp: number; signature: string }, now: number = Date.now()): boolean {
  if (!Number.isSafeInteger(msg.exp) || msg.exp < now - CHAIN_CLOCK_SKEW_MS || msg.exp > now + CHAIN_TTL_MS + CHAIN_CLOCK_SKEW_MS) return false;
  if (!/^[0-9a-f]{64}$/.test(msg.signature)) return false;
  const expected = Buffer.from(signAdvance(secret, msg.jobId, msg.runId, msg.exp), "hex");
  const got = Buffer.from(msg.signature, "hex");
  return got.length === expected.length && timingSafeEqual(got, expected);
}

/** 이 프로세스가 에이전트 실행기(맥미니의 next start)인가. 실행기는 작업을 직접 실행하고, 놓친 작업을 주기적으로 주워 간다(runner-loop.ts). */
export function isAgentRunner(env: Env = process.env): boolean {
  // Vercel 배포에서는 켜지지 않는다(함수는 주기 점검을 유지하지 못하고, 실행기 주소로 넘기는 쪽이어야 한다).
  return env.RESUME_AGENT_RUNNER?.trim() === "1" && !env.VERCEL;
}

/**
 * 단계 실행을 넘길 실행기 origin(RESUME_AGENT_RUNNER_URL — https, 또는 로컬 점검용 http://localhost·127.0.0.1). 없거나 잘못됐으면 null.
 * 실행기 자신에게는 항상 null(자기에게 다시 넘기지 않는다).
 */
export function agentRunnerOrigin(env: Env = process.env): string | null {
  if (isAgentRunner(env)) return null;
  const raw = env.RESUME_AGENT_RUNNER_URL?.trim();
  if (!raw) return null;
  try {
    const u = new URL(raw);
    const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
    return u.protocol === "https:" || (u.protocol === "http:" && local) ? u.origin : null;
  } catch {
    return null;
  }
}

/** 연쇄 대상 origin. null이면 연쇄를 하지 않는다. 실행기가 설정돼 있으면 실행기가 먼저다(안 받으면 자기 호출 — requestChain). */
export function chainOrigin(env: Env = process.env): string | null {
  return agentRunnerOrigin(env) ?? selfOrigin(env);
}

/** 이 배포 자신의 origin(자기 호출 대상). */
function selfOrigin(env: Env): string | null {
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

/** 'auto': 실행기 → (안 받으면) 자기 호출. 'runner': 실행기에만(넘기기 — 실패하면 호출자가 여기서 실행한다). */
export type ChainTarget = "auto" | "runner";

/**
 * 다음 호출 요청(202만 기다린다, 대상마다 5초 상한). 실패해도 던지지 않는다(안전망이 이어 간다).
 * 실행기가 꺼져 있거나 거절하면(버전 불일치 409 등) 자기 호출로 이어 가므로, 실행기 없이도 이 배포의 연쇄는 끊기지 않는다.
 */
export async function requestChain(
  job: { id: string; runId: string },
  env: Env = process.env,
  fetchImpl: typeof fetch = fetch,
  now: number = Date.now(),
  target: ChainTarget = "auto",
): Promise<ChainResult> {
  const secret = chainSecret(env);
  const runner = agentRunnerOrigin(env);
  const self = target === "auto" ? selfOrigin(env) : null;
  const targets = [...(runner ? [{ origin: runner, runner: true }] : []), ...(self ? [{ origin: self, runner: false }] : [])];
  if (!secret || targets.length === 0) return { ok: false, error: "chain_disabled" };
  let last: ChainResult = { ok: false, error: "chain_disabled" };
  for (const t of targets) {
    const exp = now + CHAIN_TTL_MS;
    const headers: Record<string, string> = { "Content-Type": "application/json", [CHAIN_SIGNATURE_HEADER]: signAdvance(secret, job.id, job.runId, exp) };
    // 미리보기 보호 우회 비밀은 자기 배포에만 보낸다(실행기 등 다른 호스트로 내보내지 않는다).
    if (!t.runner && env.VERCEL_ENV === "preview" && env.VERCEL_AUTOMATION_BYPASS_SECRET) headers["x-vercel-protection-bypass"] = env.VERCEL_AUTOMATION_BYPASS_SECRET;
    try {
      const res = await fetchImpl(`${t.origin}/api/internal/resume-agent/advance`, {
        method: "POST",
        headers,
        body: JSON.stringify({ jobId: job.id, runId: job.runId, exp }),
        // 서명 헤더를 다른 곳으로 따라 보내지 않는다(3xx는 실패로 본다).
        redirect: "manual",
        signal: AbortSignal.timeout(5_000),
      });
      if (res.status === 202) return { ok: true };
      last = { ok: false, error: `${t.runner ? "runner_" : ""}status_${res.status}` };
    } catch (err) {
      last = { ok: false, error: `${t.runner ? "runner_" : ""}${((err as Error)?.name ?? "error").slice(0, 60)}` };
    }
  }
  return last;
}
