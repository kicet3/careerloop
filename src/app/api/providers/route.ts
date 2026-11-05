import { requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { errorResponse } from "@/lib/diagnoses/http";
import { listProviderOptions } from "@/lib/providers/options";
import { listConnections } from "@/lib/providers/service";

export const runtime = "nodejs";

/** 새 진단에서 고를 수 있는 엔진과 CLI 엔진 연결 상태. */
export async function GET() {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const [options, connections] = await Promise.all([listProviderOptions(), listConnections()]);
    return Response.json({ options, connections }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/providers");
  }
}
