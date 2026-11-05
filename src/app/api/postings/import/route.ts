import { after } from "next/server";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { PostingImportInputSchema } from "@/lib/domain/postings";
import { postingErrorResponse, postingImportBurstLimiter, tooManyRequests } from "@/lib/postings/http";
import { runPostingCapture } from "@/lib/postings/capture";
import { createImport, listRecentImports, queueCaptureForShared, runImportThenCapture } from "@/lib/postings/imports";
import { findSharedPostingByUrl } from "@/lib/postings/shared";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// after()로 이어지는 가져오기(페이지 읽기 20초 + AI 분석, 전체 180초 상한)와 이어지는 원문 캡처(75초 상한)가
// 이 시간 안에 끝나야 한다. 리터럴이어야 한다.
export const maxDuration = 300;

/** 최근 24시간의 가져오기 작업(목록 화면이 진행 상황을 이어 보여 준다). */
export async function GET() {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json({ items: await listRecentImports(user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/postings/import");
  }
}

/**
 * 공고 URL 가져오기 시작.
 * - 202 { jobId, job }: 새 작업(또는 같은 URL로 진행 중인 작업).
 * - 200 { jobId, job, fromShared: true }: 공고 찾기에 있던 공고를 바로 담았다(job.status 'completed', AI·페이지 읽기 없음).
 * - 409 { existingId }: 이미 보관한 URL(refresh: true면 그 공고를 다시 가져오는 작업을 만든다).
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const burst = postingImportBurstLimiter.hit(user.id);
  if (!burst.ok) return tooManyRequests("가져오기 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", burst.retryAfterSec);
  try {
    const { url, refresh } = await readJsonInput(req, PostingImportInputSchema, 8 * 1024);
    // 공고 찾기에 있는 공고는 AI 엔진 없이 담을 수 있다. 그 밖에는 엔진이 없으면 작업을 만들기 전에 409로 알린다(하루 횟수를 쓰지 않게).
    const cached = !refresh && (await findSharedPostingByUrl(url)) !== null;
    const provider = cached ? null : await resolveRequestedProvider(null);
    const { job, reused, fromShared } = await createImport(user.id, url, { refresh });
    if (fromShared) {
      // 공고 찾기에 있던 공고: 원문 캡처가 아직 없거나 실패했으면 백그라운드로 찍는다(응답을 막지 않는다).
      const sharedId = job.sharedPostingId;
      if (sharedId && (await queueCaptureForShared(sharedId))) after(() => runPostingCapture(sharedId));
      return Response.json({ jobId: job.id, job, fromShared: true }, { status: 200 });
    }
    if (!reused) {
      // 가져오기가 끝나면 같은 백그라운드 작업에서 원문 캡처를 이어서 한다(가져오기 결과를 기다리게 하지 않는다).
      after(() => runImportThenCapture(job.id, provider ? { provider } : {}));
    }
    return Response.json({ jobId: job.id, job }, { status: 202 });
  } catch (err) {
    return postingErrorResponse(err, "POST /api/postings/import");
  }
}
