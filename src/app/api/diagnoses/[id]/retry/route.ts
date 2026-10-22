import { after } from "next/server";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { runDeadline } from "@/lib/diagnoses/deadline";
import { errorResponse } from "@/lib/diagnoses/http";
import { prepareRetry } from "@/lib/diagnoses/service";
import { runDiagnosis } from "@/lib/panel/runner";

export const runtime = "nodejs";
// POST /api/diagnoses와 같다(남은 단계를 after()로 이어서 실행). Hobby 플랜은 300 이하로 낮춘다.
export const maxDuration = 800;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
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
        await runDiagnosis(id, { deadlineAt: runDeadline(startedAt, maxDuration) });
      } catch (err) {
        console.error("[runDiagnosis retry]", id, err);
      }
    });
    return Response.json({ id }, { status: 202 });
  } catch (err) {
    return errorResponse(err, "POST /api/diagnoses/[id]/retry");
  }
}
