import { FeatureError } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { createLlmClient, LlmPermanentError } from "@/lib/llm";
import { PostingExtractError } from "@/lib/postings/extract";
import {
  DAILY_POSTING_STRUCTURE_LIMIT,
  postingErrorResponse,
  postingImportBurstLimiter,
  postingNotFound,
  postingStructureDailyLimiter,
  safePostingAiError,
  tooManyRequests,
} from "@/lib/postings/http";
import { restructurePosting } from "@/lib/postings/restructure";
import { getPosting } from "@/lib/postings/service";
import { ProviderServiceError } from "@/lib/providers/errors";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// 요청 안에서 AI 정리를 기다린다(withLlmDeadline 240초 상한). 리터럴이어야 한다.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** 'AI로 다시 정리': 저장된 본문으로 구역을 다시 뽑아 저장한다 → { posting }. */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  const burst = postingImportBurstLimiter.hit(user.id);
  if (!burst.ok) return tooManyRequests("요청이 너무 잦습니다. 잠시 후 다시 시도해 주세요.", burst.retryAfterSec);
  try {
    // 남의 공고·없는 공고는 횟수를 쓰지 않고 404.
    if (!(await getPosting(user.id, id))) return postingNotFound();
    // 엔진이 없으면 횟수를 쓰기 전에 알린다.
    const provider = await resolveRequestedProvider(null);
    const daily = postingStructureDailyLimiter.hit(user.id);
    if (!daily.ok) {
      return tooManyRequests(`AI로 다시 정리는 하루 ${DAILY_POSTING_STRUCTURE_LIMIT}번까지 할 수 있습니다. 내일 다시 시도해 주세요.`, daily.retryAfterSec);
    }
    const posting = await restructurePosting(user.id, id, { llm: createLlmClient(provider, { userId: user.id, referenceId: id }), signal: req.signal });
    if (!posting) return postingNotFound();
    return Response.json({ posting });
  } catch (err) {
    if (err instanceof FeatureError) return postingErrorResponse(err, "POST /api/postings/[id]/structure");
    if (err instanceof ProviderServiceError) return jsonError(err.message, err.status);
    if (err instanceof PostingExtractError) return jsonError(err.message, 422);
    if (err instanceof LlmPermanentError) {
      return jsonError(safePostingAiError(err, { fallback: "공고를 정리하지 못했습니다. 잠시 후 다시 시도해 주세요." }), 502);
    }
    return postingErrorResponse(err, "POST /api/postings/[id]/structure");
  }
}
