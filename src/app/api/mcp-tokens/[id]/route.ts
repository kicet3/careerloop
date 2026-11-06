import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { revokeMcpToken } from "@/lib/mcp/tokens";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 내 MCP 토큰 폐기(바로 효력). 내 토큰이 아니면 404. 이미 폐기했어도 200. → { view } */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const view = id.length <= 64 ? await revokeMcpToken(user.id, id) : null;
    if (!view) return jsonError("토큰을 찾을 수 없습니다.", 404);
    return Response.json({ view }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/mcp-tokens/[id]");
  }
}
