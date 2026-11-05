import { readJson } from "@/lib/auth/http";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { isCliProviderId } from "@/lib/domain/providers";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { cancelLogin, getConnection, logout, startLogin, submitLoginCode } from "@/lib/providers/service";

export const runtime = "nodejs";

type Params = { params: Promise<{ id: string }> };

/** CLI 엔진 하나의 연결 상태(로그인 진행 상태 포함). ?fresh=1이면 로그인 상태를 새로 확인한다. */
export async function GET(req: Request, { params }: Params) {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!isCliProviderId(id)) return jsonError("알 수 없는 엔진입니다.", 404);
  try {
    const fresh = new URL(req.url).searchParams.get("fresh") === "1";
    return Response.json(await getConnection(id, { fresh }), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/providers/[id]");
  }
}

/**
 * 연결 조작. body: { action: "login" } | { action: "code", code } | { action: "cancel" } | { action: "logout" }
 * 응답은 조작 뒤의 연결 상태.
 */
export async function POST(req: Request, { params }: Params) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  if (!isCliProviderId(id)) return jsonError("알 수 없는 엔진입니다.", 404);

  const body = (await readJson(req)) as { action?: unknown; code?: unknown } | null;
  try {
    switch (body?.action) {
      case "login":
        await startLogin(id);
        break;
      case "code":
        if (typeof body.code !== "string") return jsonError("코드를 입력해 주세요.", 400);
        submitLoginCode(id, body.code);
        break;
      case "cancel":
        cancelLogin(id);
        break;
      case "logout":
        await logout(id);
        break;
      default:
        return jsonError("알 수 없는 요청입니다.", 400);
    }
    return Response.json(await getConnection(id), { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "POST /api/providers/[id]");
  }
}
