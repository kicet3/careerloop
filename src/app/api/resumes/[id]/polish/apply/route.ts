import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ApplyPolishSchema } from "@/lib/domain/resume-polish";
import { readJsonInput } from "@/lib/resumes/http";
import { applyPolishSuggestion } from "@/lib/resumes/polish";

export const runtime = "nodejs";

/** 제안 하나를 적용해 새 버전을 만든다(되돌리기는 버전 목록의 복원). 그 칸이 제안 뒤에 바뀌었으면 409. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const input = await readJsonInput(req, ApplyPolishSchema, 4 * 1024);
    const result = await applyPolishSuggestion(user.id, id, input);
    return Response.json(result, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/resumes/[id]/polish/apply");
  }
}
