import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { SubmitInterviewAnswerSchema } from "@/lib/domain/interview";
import { interviewErrorResponse, MAX_INTERVIEW_BODY_BYTES, noStore, questionNotFound, scheduleFeedback } from "@/lib/interview/http";
import { submitInterviewAnswer } from "@/lib/interview/service";
import { listAnswers } from "@/lib/interview/store";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// after()로 이어지는 피드백(LLM 1회)이 이 시간 안에 끝나야 한다.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string; qid: string }> };

/** 한 질문의 답변 이력(최신부터). */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, qid } = await params;
  try {
    const answers = await listAnswers(user.id, id, qid);
    if (!answers) return questionNotFound();
    return Response.json({ answers }, { headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "GET /api/interview/sessions/[id]/questions/[qid]/answers");
  }
}

/** 답변 제출 → 202(pending). 피드백은 백그라운드에서 만든다 — 클라이언트는 GET /api/interview/answers/[aid]를 폴링한다. */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id, qid } = await params;
  try {
    const input = await readJsonInput(req, SubmitInterviewAnswerSchema, MAX_INTERVIEW_BODY_BYTES);
    const res = await submitInterviewAnswer(user.id, id, qid, input);
    if (!res) return questionNotFound();
    scheduleFeedback(user.id, res.answer.id, res.provider);
    return Response.json({ answer: res.answer }, { status: 202, headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "POST /api/interview/sessions/[id]/questions/[qid]/answers");
  }
}
