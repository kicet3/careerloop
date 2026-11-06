import { after } from "next/server";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { PostingPasteImportInputSchema } from "@/lib/domain/postings";
import { MAX_POSTING_BODY_BYTES, postingErrorResponse, postingImportBurstLimiter, tooManyRequests } from "@/lib/postings/http";
import { createImport, runImportThenCapture } from "@/lib/postings/imports";
import { findSharedPostingByUrl } from "@/lib/postings/shared";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// after()로 이어지는 AI 분석(전체 180초 상한)이 이 시간 안에 끝나야 한다. 리터럴이어야 한다.
export const maxDuration = 300;

/**
 * 본문 붙여넣어 가져오기 시작: 링크로 읽을 수 없는 공고(보안 검사·봇 차단 등)를 사용자가 브라우저에서 복사한 페이지 본문으로 가져온다.
 * URL 가져오기(POST /api/postings/import)와 같은 작업·제한을 쓰고, 페이지 읽기 대신 붙여넣은 본문을 분석한다(결과는 링크 공용 공고로 올리지 않는다 — imports.runImport).
 * url을 비우면 원문만 붙여넣기('직접 추가'의 AI 추가): 링크 검사·공고 찾기 재사용·중복 판별 없이 본문만 분석해 공고를 만든다(202만, 409 existingId 없음).
 * - 202 { jobId, job }: 새 작업(진행 상황은 GET /api/postings/import/[jobId]).
 * - 200 { jobId, job, fromShared: true }: 공고 찾기에 같은 링크의 공고가 있어 바로 담았다(AI 없음).
 * - 409 { existingId }: 이미 보관한 URL. 409(existingId 없음): 같은 URL을 가져오는 중.
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const burst = postingImportBurstLimiter.hit(user.id);
  if (!burst.ok) return tooManyRequests("가져오기 요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", burst.retryAfterSec);
  try {
    const { url, pageText } = await readJsonInput(req, PostingPasteImportInputSchema, MAX_POSTING_BODY_BYTES);
    const cached = (await findSharedPostingByUrl(url)) !== null;
    const provider = cached ? null : await resolveRequestedProvider(null);
    const { job, fromShared } = await createImport(user.id, url, { pasted: true });
    // 원문 캡처는 하지 않는다 — 서버가 열 수 없는(봇 차단) 페이지라 보안 검사 화면만 찍힌다.
    if (fromShared) {
      return Response.json({ jobId: job.id, job, fromShared: true }, { status: 200 });
    }
    after(() => runImportThenCapture(job.id, { pastedText: pageText, ...(provider ? { provider } : {}) }));
    return Response.json({ jobId: job.id, job }, { status: 202 });
  } catch (err) {
    return postingErrorResponse(err, "POST /api/postings/import/paste");
  }
}
