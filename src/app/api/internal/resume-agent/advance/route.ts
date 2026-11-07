import { prisma } from "@/lib/db/client";
import { CHAIN_SIGNATURE_HEADER, chainSecret, verifyAdvance } from "@/lib/resume-agent/chain";
import { scheduleAgentAdvance } from "@/lib/resume-agent/http";

export const runtime = "nodejs";
// after()로 이어지는 단계 실행의 시간 상한(resume-agent/jobs.ts AGENT_ROUTE_MAX_DURATION_SEC). 리터럴이어야 한다.
export const maxDuration = 300;

const empty = (status: 202 | 401 | 404) => new Response(null, { status, headers: { "Cache-Control": "no-store" } });

/**
 * 내부 연쇄(서명된 자기 호출). 세션 대신 HMAC 서명(용도 접두 + jobId + runId + exp, 2분)으로 인증하고, 같은 출처 검사는 서명으로 대신한다.
 * 작업 행을 jobId·runId·진행 상태로 찾아 그 행의 userId로만 실행한다(본문에 userId는 없다). 비밀이 없는 배포는 404(존재도 숨김).
 * 응답은 202/401/404뿐이고 본문에 작업 정보를 싣지 않는다. 같은 서명을 다시 보내도 리스 획득이 막아 LLM 호출이 늘지 않는다.
 */
export async function POST(req: Request) {
  const startedAt = Date.now();
  const secret = chainSecret();
  if (!secret) return empty(404);
  const body = (await req.json().catch(() => null)) as { jobId?: unknown; runId?: unknown; exp?: unknown } | null;
  const jobId = typeof body?.jobId === "string" ? body.jobId.slice(0, 64) : "";
  const runId = typeof body?.runId === "string" ? body.runId.slice(0, 64) : "";
  const exp = typeof body?.exp === "number" ? body.exp : NaN;
  const signature = req.headers.get(CHAIN_SIGNATURE_HEADER) ?? "";
  if (!jobId || !runId || !verifyAdvance(secret, { jobId, runId, exp, signature }, startedAt)) return empty(401);
  const row = await prisma.resumeAgentJob.findFirst({ select: { id: true }, where: { id: jobId, runId, status: { in: ["running", "waiting"] } } });
  if (!row) return empty(404);
  scheduleAgentAdvance(row.id, { startedAt, runId });
  return empty(202);
}
