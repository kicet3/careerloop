import { z } from "zod";
import { assertSameOrigin, requireAdminApiUser, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { postingErrorResponse } from "@/lib/postings/http";
import { getSharedPosting, SHARED_POSTING_NOT_FOUND, setSharedPostingHidden } from "@/lib/postings/shared";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 공용 공고 하나(숨김 제외 — 관리자는 숨긴 공고도 본다). */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const posting = await getSharedPosting(id.slice(0, 64), user.id, { includeHidden: user.role === "admin" });
    if (!posting) return jsonError(SHARED_POSTING_NOT_FOUND, 404);
    return Response.json({ posting }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/shared-postings/[id]");
  }
}

const HideSchema = z.object({ hidden: z.boolean() }).strict();

/** 관리자: 공고 찾기에서 숨기기·되돌리기 { hidden }. 개인 페이지·토큰이 든 링크 등 공유되면 안 되는 공고를 내린다. */
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const admin = await requireAdminApiUser();
  if (admin instanceof Response) return admin;
  const { id } = await params;
  try {
    const { hidden } = await readJsonInput(req, HideSchema, 1024);
    if (!(await setSharedPostingHidden(id.slice(0, 64), hidden))) return jsonError(SHARED_POSTING_NOT_FOUND, 404);
    return Response.json({ ok: true, hidden });
  } catch (err) {
    return postingErrorResponse(err, "PATCH /api/shared-postings/[id]");
  }
}
