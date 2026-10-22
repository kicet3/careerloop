import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { errorResponse } from "@/lib/diagnoses/http";
import { clearShareToken, setShareToken } from "@/lib/diagnoses/service";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 공유 링크 생성(이미 있으면 그대로). 응답: { shareToken, path } */
export async function POST(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    const shareToken = await setShareToken(id, user.id);
    return Response.json({ shareToken, path: `/share/${shareToken}` });
  } catch (err) {
    return errorResponse(err, "POST /api/diagnoses/[id]/share");
  }
}

export async function DELETE(req: Request, { params }: Ctx) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    await clearShareToken(id, user.id);
    return new Response(null, { status: 204 });
  } catch (err) {
    return errorResponse(err, "DELETE /api/diagnoses/[id]/share");
  }
}
