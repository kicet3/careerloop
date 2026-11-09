import "server-only";
/**
 * 장시간 AI 작업 디스패치(docs/PYTHON-WORKER.md §3.1). 라우트는 작업 행을 만든 뒤 지금의 after(() => run…Job(...)) 대신
 * dispatchJob(kind, { id, runId, provider }, () => run…Job(...))을 부른다.
 *
 * - 스위치(WORKER_URL·WORKER_JOBS)가 켜져 있고 엔진이 'anthropic'이면 응답 뒤(after) POST {WORKER_URL}/v1/jobs/{kind}를 보낸다(5초 타임아웃).
 *   202면 끝이다. 그 밖(연결 실패·타임아웃·4xx·5xx)이면 같은 after 안에서 fallback을 실행한다 — 지금처럼 Vercel에서 실행한다.
 * - 스위치가 꺼져 있거나 CLI 엔진(claude-cli·codex-cli)이면 워커로 보내지 않고 after(fallback)만 예약한다.
 *   CLI 엔진은 사용자 계정 로그인 정보가 Vercel 쪽에만 있어 워커가 실행할 수 없다(워커도 409로 거절한다).
 * - 본문에는 작업 id와 runId만 싣는다. 워커는 user_id를 DB 작업 행에서 다시 읽는다.
 * - 한 작업이 두 번 실행되지 않는 것은 양쪽 실행부의 runId·status 조건부 UPDATE가 보장한다(여기서는 보장하지 않는다).
 */
import { after } from "next/server";
import type { ProviderId } from "@/lib/domain/providers";
import { isJobEnabled, workerConfig, type WorkerConfig, type WorkerJobKind } from "./config";
import { signedHeaders } from "./sign";

export const DISPATCH_TIMEOUT_MS = 5000;

export interface DispatchPayload {
  id: string;
  runId: string;
  /** 작업 행의 엔진. 'anthropic'만 워커로 보낸다. */
  provider: ProviderId | string | null;
}

export type DispatchOutcome =
  | { sent: true }
  | { sent: false; reason: "disabled" | "provider" | "network" | "timeout" | "status"; status?: number };

export interface DispatchDeps {
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  after?: (task: () => Promise<void>) => void;
  nowSec?: () => number;
  timeoutMs?: number;
}

/** 워커로 보낼 수 있는지(스위치·엔진). 보낼 수 있으면 설정, 아니면 사유. */
function routeFor(kind: WorkerJobKind, payload: DispatchPayload, env: Record<string, string | undefined>): WorkerConfig | "disabled" | "provider" {
  const cfg = workerConfig(env);
  if (!cfg || !isJobEnabled(cfg.jobs, kind)) return "disabled";
  if (payload.provider !== "anthropic") return "provider";
  return cfg;
}

/** 워커에 작업을 넘긴다. 202면 { sent: true }. 던지지 않는다. */
export async function sendToWorker(kind: WorkerJobKind, payload: DispatchPayload, deps: DispatchDeps = {}): Promise<DispatchOutcome> {
  const route = routeFor(kind, payload, deps.env ?? process.env);
  if (route === "disabled" || route === "provider") return { sent: false, reason: route };
  const path = `/v1/jobs/${kind}`;
  const body = JSON.stringify({ id: payload.id, runId: payload.runId });
  const headers = { "content-type": "application/json", ...signedHeaders(route.secret, "POST", path, body, deps.nowSec?.()) };
  try {
    const res = await (deps.fetch ?? fetch)(`${route.url}${path}`, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(deps.timeoutMs ?? DISPATCH_TIMEOUT_MS),
      redirect: "error",
      cache: "no-store",
    });
    // 본문은 읽지 않고 버린다(연결을 붙잡지 않게).
    await res.body?.cancel().catch(() => undefined);
    if (res.status === 202) return { sent: true };
    console.warn(`[worker] dispatch ${kind} ${payload.id} → ${res.status}, Vercel에서 실행`);
    return { sent: false, reason: "status", status: res.status };
  } catch (err) {
    const timeout = err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError");
    console.warn(`[worker] dispatch ${kind} ${payload.id} ${timeout ? "timeout" : "network error"}, Vercel에서 실행`);
    return { sent: false, reason: timeout ? "timeout" : "network" };
  }
}

/**
 * 작업 실행 예약. 워커가 202로 받으면 fallback은 실행하지 않고, 그 밖에는 fallback을 실행한다(모두 응답 뒤 after 안에서).
 * fallback은 지금 라우트가 after()에 넘기던 run…Job 호출 그대로다.
 */
export function dispatchJob(kind: WorkerJobKind, payload: DispatchPayload, fallback: () => Promise<void>, deps: DispatchDeps = {}): void {
  const schedule = deps.after ?? ((task: () => Promise<void>) => after(task));
  const route = routeFor(kind, payload, deps.env ?? process.env);
  if (route === "disabled" || route === "provider") {
    schedule(fallback);
    return;
  }
  schedule(async () => {
    const outcome = await sendToWorker(kind, payload, deps);
    if (!outcome.sent) await fallback();
  });
}
