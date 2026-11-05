import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { UpdateInterviewQuestionSchema } from "@/lib/domain/interview";
import { interviewErrorResponse, MAX_INTERVIEW_BODY_BYTES, noStore, questionNotFound } from "@/lib/interview/http";
import { updateQuestion } from "@/lib/interview/store";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

/** 질문 상태(new·practiced·skipped)·별표 바꾸기. */
export async function PATCH(req: Request, { params }: { params: Promise<{ id: string; qid: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, qid } = await params;
  try {
    const patch = await readJsonInput(req, UpdateInterviewQuestionSchema, MAX_INTERVIEW_BODY_BYTES);
    const question = await updateQuestion(user.id, id, qid, patch);
    if (!question) return questionNotFound();
    return Response.json({ question }, { headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "PATCH /api/interview/sessions/[id]/questions/[qid]");
  }
}
