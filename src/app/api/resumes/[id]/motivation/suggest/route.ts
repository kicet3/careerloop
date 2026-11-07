import { featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, RESUME_MOTIVATION_LIMIT } from "@/lib/auth/db-rate-limit";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { MotivationSuggestInputSchema, type MotivationSuggestResponse, type SavedMotivationSuggestResponse } from "@/lib/domain/resume-motivation";
import { createLlmClient } from "@/lib/llm";
import { ProviderServiceError } from "@/lib/providers/errors";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { readJsonInput, resumeNotFound } from "@/lib/resumes/http";
import { assertMotivationResume, getSavedMotivationSuggestion, suggestMotivation } from "@/lib/resumes/motivation";
import { getResumeMeta } from "@/lib/resumes/service";

export const runtime = "nodejs";
// 요청 안에서 추천(LLM 1회, 짧은 출력)을 기다린다. 리터럴이어야 한다.
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const noStore = { "Cache-Control": "no-store" };

/**
 * 저장된 마지막 추천(에이전트가 미리 계산했거나 버튼으로 받은 것) → { saved }. LLM 호출 없음.
 * 남의 이력서·없는 이력서는 404, 공용 이력서는 400. jdChanged: 추천을 만든 뒤 이력서 JD가 바뀌었다.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const meta = await getResumeMeta(user.id, id);
    if (!meta) return resumeNotFound();
    assertMotivationResume(meta);
    const saved = await getSavedMotivationSuggestion(user.id, meta.id, meta.jdText);
    return Response.json({ saved } satisfies SavedMotivationSuggestResponse, { headers: noStore });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/motivation/suggest");
  }
}

/**
 * 지원 동기 쓸 거리 추천(지원처별 이력서만): { motivation }(편집 중인 글) → { suggestion }. 결과는 이 이력서의 마지막 추천으로 저장한다.
 * 재료는 문장이 아니다 — 공고가 강조하는 점·이어지는 경험(본인 그래프 노드)·문단 구성·질문·주의점 + [ADD]가 든 초안(src/lib/resumes/motivation.ts).
 * 남의 이력서·없는 이력서는 횟수를 쓰지 않고 404. 사용자당 24시간 RESUME_MOTIVATION_LIMIT회.
 */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const meta = await getResumeMeta(user.id, id);
    if (!meta) return resumeNotFound();
    assertMotivationResume(meta);
    const input = await readJsonInput(req, MotivationSuggestInputSchema, 16 * 1024);
    // 엔진이 없으면 횟수를 쓰기 전에 알린다.
    const provider = await resolveRequestedProvider(null);
    const limit = await hitDbLimit(RESUME_MOTIVATION_LIMIT, user.id);
    if (!limit.ok) {
      return Response.json(
        { error: `지원 동기 추천은 하루 ${RESUME_MOTIVATION_LIMIT.limit}번까지 받을 수 있습니다. 내일 다시 시도해 주세요.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec), ...noStore } },
      );
    }
    const suggestion = await suggestMotivation(user, meta, input, {
      llm: createLlmClient(provider, { userId: user.id, referenceId: id }),
      signal: req.signal,
    });
    return Response.json({ suggestion } satisfies MotivationSuggestResponse, { headers: noStore });
  } catch (err) {
    if (err instanceof ProviderServiceError) return jsonError(err.message, err.status);
    return featureErrorResponse(err, "POST /api/resumes/[id]/motivation/suggest");
  }
}
