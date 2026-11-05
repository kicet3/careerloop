import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { createResumeFromInput, resumeDraftLimiter } from "@/lib/resumes/create";
import { jsonError } from "@/lib/diagnoses/http";
import { withResumePostingDefaults } from "@/lib/postings/defaults";
import { getPosting, POSTING_NOT_FOUND } from "@/lib/postings/service";
import { parseJsonInput, readJsonBody } from "@/lib/resumes/http";
import { listResumes } from "@/lib/resumes/service";
import { CreateResumeInputSchema, type CreateResumeResponse } from "@/lib/resumes/types";

export const runtime = "nodejs";
// AI 초안(LLM 1회)이 요청 안에서 끝나야 한다. 계정 로그인(CLI) 엔진은 느릴 수 있다.
export const maxDuration = 300;

export async function GET() {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    return Response.json({ items: await listResumes(user.id) }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes");
  }
}

/**
 * 새 이력서: 출처가 그래프·진단이면 AI 초안, 빈 문서면 바로 v1.
 * postingId(보관 공고)를 주면 내 공고인지 확인하고, 비운 회사·직무·JD를 공고 값으로 채운 뒤 이력서를 공고에 연결한다.
 */
export async function POST(req: Request) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  try {
    let raw = await readJsonBody(req);
    const postingId = (raw as { postingId?: unknown } | null)?.postingId;
    if (typeof postingId === "string" && postingId.trim()) {
      const posting = await getPosting(user.id, postingId.trim().slice(0, 64));
      if (!posting) return jsonError(POSTING_NOT_FOUND, 404);
      raw = withResumePostingDefaults(raw, posting);
    }
    const input = parseJsonInput(CreateResumeInputSchema, raw);
    if (input.source.kind !== "blank") {
      const limit = resumeDraftLimiter.hit(user.id);
      if (!limit.ok) {
        return Response.json(
          { error: "오늘 만들 수 있는 AI 초안 수를 넘었습니다. 빈 문서로 시작하거나 내일 다시 시도해 주세요." },
          { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
        );
      }
    }
    const created = await createResumeFromInput(user, input, { signal: req.signal });
    return Response.json(created satisfies CreateResumeResponse, { status: 201 });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/resumes");
  }
}
