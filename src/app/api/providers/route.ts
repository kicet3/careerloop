import { requireApiUser } from "@/lib/auth/session";
import { errorResponse } from "@/lib/diagnoses/http";
import { listProviderOptions } from "@/lib/providers/options";
import { listConnections, publicConnection } from "@/lib/providers/service";

export const runtime = "nodejs";

/**
 * 새 진단에서 고를 수 있는 엔진과 CLI 엔진 연결 상태. 엔진 선택은 승인된 모든 사용자가 하므로 누구나 부를 수 있다.
 * 진행 중인 로그인(인가 링크·1회용 코드)은 관리자에게만 돌려준다(공용 CLI 로그인은 관리자만 다룬다).
 */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const [options, all] = await Promise.all([listProviderOptions(), listConnections()]);
    const connections = user.role === "admin" ? all : all.map(publicConnection);
    return Response.json({ options, connections }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/providers");
  }
}
