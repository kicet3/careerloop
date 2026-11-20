import "server-only";
/**
 * 에이전트 라우트 공용: 실행기(맥미니)로 넘기기, 동시 작업 상한(409 + 진행 중인 작업 id), 백그라운드 이어 가기 예약.
 * after() 콜백 안에서는 요청 객체를 읽지 않는다 — 마감 시각은 라우트 첫 줄에서 계산해 넘긴다.
 */
import { after } from "next/server";
import { featureErrorResponse } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import { agentRunnerOrigin, chainSecret, requestChain, type ChainResult } from "./chain";
import { advanceAgentJob, agentDeadline, AgentBusyError } from "./jobs";

export const noStore = { "Cache-Control": "no-store" } as const;

export function agentErrorResponse(err: unknown, context: string): Response {
  if (err instanceof AgentBusyError) {
    return Response.json({ error: err.message, code: "busy", agentJobId: err.jobId }, { status: 409, headers: noStore });
  }
  return featureErrorResponse(err, context);
}

/**
 * 실행기(맥미니, RESUME_AGENT_RUNNER_URL)가 설정돼 있으면 서명 호출로 넘긴다. 202를 받으면 true(이 배포는 실행하지 않는다).
 * 실행기가 없거나 응답이 없으면 false — 호출자가 지금처럼 여기서 실행한다. 던지지 않는다.
 */
export async function handOffToRunner(
  jobId: string,
  opts: { userId?: string; runId?: string },
  deps: { env?: Record<string, string | undefined>; chain?: (job: { id: string; runId: string }, env: Record<string, string | undefined>) => Promise<ChainResult> } = {},
): Promise<boolean> {
  const env = deps.env ?? process.env;
  if (!agentRunnerOrigin(env) || !chainSecret(env)) return false;
  try {
    const runId =
      opts.runId ??
      (await prisma.resumeAgentJob.findFirst({ select: { runId: true }, where: { id: jobId, ...(opts.userId ? { userId: opts.userId } : {}), status: { in: ["running", "waiting"] } } }))?.runId;
    if (!runId) return false;
    const res = await (deps.chain ?? ((j, e) => requestChain(j, e, fetch, Date.now(), "runner")))({ id: jobId, runId }, env);
    if (res.ok) return true;
    // 넘기기 실패는 조용히 지나가지 않게 남긴다(비밀 불일치 401·nginx 미설정 404·시계 차이 등 — 이때는 이 배포가 실행해 함수 시간을 쓴다).
    console.warn(`[resume-agent] 실행기 넘기기 실패(${res.error}) — 이 배포에서 실행합니다. job=${jobId}`);
    await prisma.resumeAgentJob.updateMany({ where: { id: jobId, runId }, data: { chainError: `handoff:${res.error}`.slice(0, 200) } }).catch(() => undefined);
    return false;
  } catch (err) {
    console.warn(`[resume-agent] 실행기 넘기기 오류(${(err as Error)?.name ?? "error"}) — 이 배포에서 실행합니다. job=${jobId}`);
    return false;
  }
}

/**
 * 응답 뒤 이어서 실행한다(라우트 핸들러 안에서만). startedAt은 요청 시작 시각(after도 같은 시간 안에서 돈다).
 * 실행기가 받으면 거기서 실행하고, 못 받으면(꺼짐·연결 실패) 이 배포에서 실행한다 — 두 곳이 겹쳐도 리스가 하나만 통과시킨다.
 */
export function scheduleAgentAdvance(jobId: string, opts: { startedAt: number; userId?: string; runId?: string }): void {
  const deadlineAt = agentDeadline(opts.startedAt);
  after(async () => {
    if (await handOffToRunner(jobId, opts)) return;
    await advanceAgentJob(jobId, { userId: opts.userId, runId: opts.runId, deadlineAt });
  });
}
