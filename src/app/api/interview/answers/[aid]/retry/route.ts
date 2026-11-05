import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { answerNotFound, interviewErrorResponse, noStore, scheduleFeedback } from "@/lib/interview/http";
import { retryInterviewFeedback } from "@/lib/interview/service";

export const runtime = "nodejs";
export const maxDuration = 300;

/** 실패했거나 멈춘 피드백 다시 받기 → 202. */
export async function POST(req: Request, { params }: { params: Promise<{ aid: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { aid } = await params;
  try {
    const res = await retryInterviewFeedback(user.id, aid);
    if (!res) return answerNotFound();
    scheduleFeedback(user.id, res.answer.id, res.provider);
    return Response.json({ answer: res.answer }, { status: 202, headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "POST /api/interview/answers/[aid]/retry");
  }
}
