import { requireApiUser } from "@/lib/auth/session";
import { answerNotFound, interviewErrorResponse, noStore } from "@/lib/interview/http";
import { getAnswer } from "@/lib/interview/store";

export const runtime = "nodejs";

/** 답변·피드백 상태 확인(폴링). */
export async function GET(_req: Request, { params }: { params: Promise<{ aid: string }> }) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { aid } = await params;
  try {
    const answer = await getAnswer(user.id, aid);
    if (!answer) return answerNotFound();
    return Response.json({ answer }, { headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "GET /api/interview/answers/[aid]");
  }
}
