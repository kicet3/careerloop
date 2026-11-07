import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { deleteEditDraft, getEditDraft, putEditDraft } from "@/lib/resumes/edit-draft";
import { readJsonInput, resumeDraftWriteLimiter, resumeNotFound } from "@/lib/resumes/http";
import { RESUME_EDIT_DRAFT_CHANGED, SaveResumeEditDraftSchema, type ResumeEditDraftClash } from "@/lib/resumes/types";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

// 오류 응답(jsonError)도 no-store다.
const noStore = { "Cache-Control": "no-store" };

/**
 * 이력서 임시 저장본(새 버전을 만들지 않는 작업본, src/lib/resumes/edit-draft.ts). 소유자만 — 남의 이력서는 404.
 * GET → { draft | null, currentVersionId }. PUT { document, baseVersionId, templateId?, expectedUpdatedAt? } → 같은 모양(다른 탭·기기가 그 사이 작업본을 바꿨으면 409 draft_changed). DELETE → 204.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const result = await getEditDraft(user.id, id);
    if (!result) return resumeNotFound();
    return Response.json(result, { headers: noStore });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/draft");
  }
}

export async function PUT(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limited = rateLimited(user.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    const input = await readJsonInput(req, SaveResumeEditDraftSchema);
    const result = await putEditDraft(user.id, id, input);
    if (!result) return resumeNotFound();
    if ("clashAt" in result) {
      const body: ResumeEditDraftClash = {
        error: "다른 탭이나 기기에서 이 이력서의 임시 저장본이 바뀌었습니다. 어느 내용을 남길지 골라 주세요.",
        code: RESUME_EDIT_DRAFT_CHANGED,
        draftUpdatedAt: result.clashAt,
      };
      return Response.json(body, { status: 409, headers: noStore });
    }
    return Response.json(result, { headers: noStore });
  } catch (err) {
    return featureErrorResponse(err, "PUT /api/resumes/[id]/draft");
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const limited = rateLimited(user.id);
  if (limited) return limited;
  const { id } = await params;
  try {
    if (!(await deleteEditDraft(user.id, id))) return resumeNotFound();
    return new Response(null, { status: 204, headers: noStore });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/resumes/[id]/draft");
  }
}

function rateLimited(userId: string): Response | null {
  const hit = resumeDraftWriteLimiter.hit(userId);
  if (hit.ok) return null;
  return Response.json(
    { error: "임시 저장 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요." },
    { status: 429, headers: { "Retry-After": String(hit.retryAfterSec), ...noStore } },
  );
}
