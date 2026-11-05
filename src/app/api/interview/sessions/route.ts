import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { CreateInterviewSessionSchema } from "@/lib/domain/interview";
import { interviewErrorResponse, MAX_INTERVIEW_BODY_BYTES, noStore, scheduleGeneration } from "@/lib/interview/http";
import { startInterviewSession } from "@/lib/interview/service";
import { listSessions } from "@/lib/interview/store";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// after()로 이어지는 질문 생성(LLM 1회)이 이 시간 안에 끝나야 한다(INTERACTIVE_LLM_TIMEOUT_MS 240초 + 여유).
export const maxDuration = 300;

/** 내 면접 연습 목록. */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json({ sessions: await listSessions(user.id) }, { headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "GET /api/interview/sessions");
  }
}

/** 새 면접 연습: 근거 스냅숏을 저장하고 202. 질문은 백그라운드에서 만든다 — 클라이언트는 세션을 폴링한다. */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const input = await readJsonInput(req, CreateInterviewSessionSchema, MAX_INTERVIEW_BODY_BYTES);
    const { session, runId, provider } = await startInterviewSession(user.id, input);
    scheduleGeneration(user.id, session.id, runId, provider);
    return Response.json({ session }, { status: 202, headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "POST /api/interview/sessions");
  }
}
