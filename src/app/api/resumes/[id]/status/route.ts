import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { changeResumeApplyStatus } from "@/lib/resumes/apply-status";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { ChangeResumeStatusSchema, type ChangeResumeStatusResult } from "@/lib/resumes/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/**
 * 지원 상태 바꾸기(지원 전·지원 중·지원 완료). 공용 이력서는 400, 동시에 바꾼 요청이 있으면 409.
 * '지원 완료'면 연결 공고를 '지원함'으로 두고 지원 기록(제출 사본 고정)을 만들거나 잇는다. 되돌리기 옵션은 ChangeResumeStatusSchema.
 */
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const input = await readJsonInput(req, ChangeResumeStatusSchema, 4 * 1024);
    const result = await changeResumeApplyStatus(user.id, id, input);
    if (!result) return resumeNotFound();
    return Response.json(result satisfies ChangeResumeStatusResult);
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/resumes/[id]/status");
  }
}
