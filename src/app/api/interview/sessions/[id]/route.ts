import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { RenameInterviewSessionSchema } from "@/lib/domain/interview";
import { interviewErrorResponse, MAX_INTERVIEW_BODY_BYTES, noStore, sessionNotFound } from "@/lib/interview/http";
import { deleteSession, getSessionDetail, renameSession } from "@/lib/interview/store";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 세션 + 질문 + 질문별 최근 답변 + 근거 줄. */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const detail = await getSessionDetail(user.id, id);
    if (!detail) return sessionNotFound();
    return Response.json(detail, { headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "GET /api/interview/sessions/[id]");
  }
}

/** 제목 바꾸기. */
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const { title } = await readJsonInput(req, RenameInterviewSessionSchema, MAX_INTERVIEW_BODY_BYTES);
    const session = await renameSession(user.id, id, title);
    if (!session) return sessionNotFound();
    return Response.json({ session }, { headers: noStore });
  } catch (err) {
    return interviewErrorResponse(err, "PATCH /api/interview/sessions/[id]");
  }
}

/** 세션·질문·답변·스냅숏 삭제. */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    if (!(await deleteSession(user.id, id))) return sessionNotFound();
    return new Response(null, { status: 204 });
  } catch (err) {
    return interviewErrorResponse(err, "DELETE /api/interview/sessions/[id]");
  }
}
