import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { interviewErrorResponse, noStore, scheduleGeneration, sessionNotFound } from "@/lib/interview/http";
import { restartInterviewGeneration } from "@/lib/interview/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 같은 근거로 질문 다시 만들기. 생성 중이면 409. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const started = await restartInterviewGeneration(user.id, id);
    if (!started) return sessionNotFound();
    scheduleGeneration(user.id, id, started.runId, started.provider);
    return Response.json({ session: started.session }, { status: 202, headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "POST /api/interview/sessions/[id]/regenerate");
  }
}
