import { after } from "next/server";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { runDeadline } from "@/lib/diagnoses/deadline";
import { errorResponse } from "@/lib/diagnoses/http";
import { prepareRetry } from "@/lib/diagnoses/service";
import { runDiagnosis } from "@/lib/panel/runner";

export const runtime = "nodejs";
// POST /api/diagnoses와 같게 둔다(남은 단계를 after()로 이어서 실행). 리터럴이어야 한다.
export const maxDuration = 300;

export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const startedAt = Date.now();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  // ?continue=1: 시간 예산에 걸려 멈춘 진단의 자동 이어하기(진행 화면이 보낸다). 사용자 재시도 횟수를 쓰지 않는다.
  const continuation = new URL(req.url).searchParams.get("continue") === "1";

  try {
    await prepareRetry(id, user.id, { continuation });
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
