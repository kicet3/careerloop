import { after } from "next/server";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { errorResponse } from "@/lib/diagnoses/http";
import { prepareRetry } from "@/lib/diagnoses/service";
import { runDiagnosis } from "@/lib/panel/runner";

export const runtime = "nodejs";
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;

  try {
    await prepareRetry(id, user.id);
    after(async () => {
      try {
        await runDiagnosis(id);
      } catch (err) {
        console.error("[runDiagnosis retry]", id, err);
      }
    });
    return Response.json({ id }, { status: 202 });
  } catch (err) {
    return errorResponse(err, "POST /api/diagnoses/[id]/retry");
  }
}
