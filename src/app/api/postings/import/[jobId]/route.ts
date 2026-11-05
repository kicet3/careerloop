import { after } from "next/server";
import { requireApiUser } from "@/lib/auth/session";
import { postingErrorResponse } from "@/lib/postings/http";
import { getImport, isImportStale, runImport } from "@/lib/postings/imports";
import { jsonError } from "@/lib/diagnoses/http";

export const runtime = "nodejs";
// 멈춘 작업을 이어서 실행할 때도 POST와 같은 시간이 필요하다.
export const maxDuration = 300;

type Ctx = { params: Promise<{ jobId: string }> };

/** 가져오기 작업 상태. 5분 넘게 멈춘 작업은 다시 실행을 예약한다(runImport의 조건부 차지로 한 번만 실행). */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { jobId } = await params;
  try {
    const job = await getImport(user.id, jobId);
    if (!job) return jsonError("가져오기 작업을 찾을 수 없습니다.", 404);
    if (isImportStale(job)) {
      after(async () => {
        try {
          await runImport(job.id);
        } catch (err) {
          console.error("[runImport]", job.id, err);
        }
      });
    }
    return Response.json({ job }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/postings/import/[jobId]");
  }
}
