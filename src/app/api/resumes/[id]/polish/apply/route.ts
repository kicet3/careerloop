import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { z } from "zod";
import { ApplyPolishDocSchema, ApplyPolishItemSchema, ApplyPolishSchema } from "@/lib/domain/resume-polish";
import { readJsonInput } from "@/lib/resumes/http";
import { applyPolishSuggestion } from "@/lib/resumes/polish";
import { applyPolishDocSuggestions, PolishConflictError } from "@/lib/resumes/polish-document";

export const runtime = "nodejs";

/**
 * {messageId, index}: 칸 모드 제안 하나. {messageId, item: true, exclude?}: 칸 모드 항목 제안(여러 칸 한 번에).
 * {messageId, indices, exclude?}: 전체 이력서 모드 제안 여러 개(칸·항목 고치기·항목 추가 — 새 버전 하나).
 */
const BodySchema = z.union([ApplyPolishDocSchema, ApplyPolishItemSchema, ApplyPolishSchema]);

/**
 * 제안을 적용해 새 버전을 만든다(되돌리기는 버전 목록의 복원). 그 칸이 제안 뒤에 바뀌었으면 409.
 * 전체 이력서 모드·항목 제안은 고른 칸 중 하나라도 바뀌었으면 409 + conflicts(바뀐 칸 목록)이고 아무것도 적용하지 않는다.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const input = await readJsonInput(req, BodySchema, 4 * 1024);
    const result = "indices" in input ? await applyPolishDocSuggestions(user.id, id, input) : await applyPolishSuggestion(user.id, id, input);
    return Response.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof PolishConflictError) return Response.json({ error: err.message, conflicts: err.conflicts }, { status: 409 });
    return featureErrorResponse(err, "POST /api/resumes/[id]/polish/apply");
  }
}
