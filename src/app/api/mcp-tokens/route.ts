import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { CreateMcpTokenSchema, type CreatedMcpToken, type McpTokenView } from "@/lib/domain/mcp";
import { createMcpToken, listMcpTokens } from "@/lib/mcp/tokens";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

/** 내 MCP 토큰 목록(원문·해시 없음, 최근 생성 순). → { items } */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const items: McpTokenView[] = await listMcpTokens(user.id);
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/mcp-tokens");
  }
}

/**
 * 새 MCP 토큰 { name, expiresInDays: 30 | 90 | 365 | null }. 원문은 이 응답에만 있다.
 * → 201 { token, view }. 활성 토큰이 이미 10개면 409.
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const input = await readJsonInput(req, CreateMcpTokenSchema, 4 * 1024);
    const created: CreatedMcpToken = await createMcpToken(user.id, input);
    return Response.json(created, { status: 201, headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/mcp-tokens");
  }
}
