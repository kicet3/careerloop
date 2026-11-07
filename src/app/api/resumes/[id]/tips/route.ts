import { featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, RESUME_JD_TIPS_LIMIT } from "@/lib/auth/db-rate-limit";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { GenerateJdTipsInputSchema, type ResumeJdTipsResponse } from "@/lib/domain/resume-jd-tips";
import { createLlmClient } from "@/lib/llm";
import { ProviderServiceError } from "@/lib/providers/errors";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { parseJsonInput, readJsonBody, resumeNotFound } from "@/lib/resumes/http";
import { generateJdTips, jdTipsResponse, lookupJdTips, resolveResumeJd, saveJdTips } from "@/lib/resumes/jd-tips";
import { getResumeMeta, getVersionDocument } from "@/lib/resumes/service";

export const runtime = "nodejs";
// 요청 안에서 팁 생성(LLM 1회)을 기다린다. 리터럴이어야 한다.
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };

const noStore = { "Cache-Control": "no-store" };

/** 키워드 포함 여부를 셀 현재 버전 본문(없거나 못 읽으면 null — 팁은 그대로 보인다). */
async function currentDocument(userId: string, resumeId: string) {
  try {
    return (await getVersionDocument(userId, resumeId))?.document ?? null;
  } catch {
    return null;
  }
}

/**
 * JD 맞춤 작성 팁(src/lib/resumes/jd-tips.ts). 남의 이력서·없는 이력서는 404.
 * GET: 저장된 팁 — { status: 'no_jd' | 'none' | 'ready' | 'stale', … }. LLM을 부르지 않는다.
 */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const meta = await getResumeMeta(user.id, id);
    if (!meta) return resumeNotFound();
    const jd = await resolveResumeJd(user.id, meta);
    if (!jd.ok) return Response.json({ status: "no_jd", reason: jd.reason } satisfies ResumeJdTipsResponse, { headers: noStore });
    const lookup = await lookupJdTips(user.id, id, jd.hash);
    const doc = lookup.status === "none" ? null : await currentDocument(user.id, id);
    return Response.json(jdTipsResponse(lookup, doc) satisfies ResumeJdTipsResponse, { headers: noStore });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/tips");
  }
}

/**
 * POST { force? }: 팁 만들기. force가 아니고 지금 JD 팁이 있으면(같은 JD의 다른 내 이력서 팁 포함) LLM 없이 그것을 이 이력서에 저장해 돌려준다.
 * 그 밖(없음·JD가 바뀜·'다시 만들기')은 LLM 1회 — 사용자당 24시간 RESUME_JD_TIPS_LIMIT회. 공용 이력서·JD 없음은 400.
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
    const jd = await resolveResumeJd(user.id, meta);
    if (!jd.ok) {
      return jsonError(jd.reason === "general" ? "JD 맞춤 팁은 지원처별 이력서에서만 만들 수 있습니다." : "이력서에 채용 공고(JD)가 없어 맞춤 팁을 만들 수 없습니다.", 400);
    }
    const raw = await readJsonBody(req, 4 * 1024).catch(() => ({}));
    const input = parseJsonInput(GenerateJdTipsInputSchema, raw ?? {});

    if (!input.force) {
      const lookup = await lookupJdTips(user.id, id, jd.hash);
      if (lookup.status === "ready" && lookup.tips) {
        if (lookup.reused) await saveJdTips(user.id, id, jd.hash, lookup.tips, lookup.model ?? "", new Date(lookup.createdAt ?? Date.now()));
        return Response.json(jdTipsResponse(lookup, await currentDocument(user.id, id)) satisfies ResumeJdTipsResponse, { headers: noStore });
      }
    }

    // 엔진이 없으면 횟수를 쓰기 전에 알린다.
    const provider = await resolveRequestedProvider(null);
    const limit = await hitDbLimit(RESUME_JD_TIPS_LIMIT, user.id);
    if (!limit.ok) {
      return Response.json(
        { error: `JD 맞춤 팁은 하루 ${RESUME_JD_TIPS_LIMIT.limit}번까지 만들 수 있습니다. 내일 다시 시도해 주세요.` },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec), ...noStore } },
      );
    }
    const { tips, model } = await generateJdTips(user, meta, jd.jdText, {
      llm: createLlmClient(provider, { userId: user.id, referenceId: id }),
      signal: req.signal,
    });
    const createdAt = new Date();
    await saveJdTips(user.id, id, jd.hash, tips, model, createdAt);
    const res = jdTipsResponse({ status: "ready", tips, model, createdAt: createdAt.getTime(), reused: false }, await currentDocument(user.id, id));
    return Response.json(res satisfies ResumeJdTipsResponse, { headers: noStore });
  } catch (err) {
    if (err instanceof ProviderServiceError) return jsonError(err.message, err.status);
    return featureErrorResponse(err, "POST /api/resumes/[id]/tips");
  }
}
