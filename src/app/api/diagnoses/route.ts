import { after } from "next/server";
import { clientIp, diagnosisIpLimiter } from "@/lib/auth/rate-limit";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { runDeadline } from "@/lib/diagnoses/deadline";
import { parseDiagnosisForm, requestedPostingId, requestedProvider } from "@/lib/diagnoses/form";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { createDiagnosis, listDiagnoses } from "@/lib/diagnoses/service";
import type { CreateDiagnosisResponse } from "@/lib/diagnoses/types";
import { runDiagnosis } from "@/lib/panel/runner";
import { getPosting, POSTING_NOT_FOUND } from "@/lib/postings/service";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// after()로 이어지는 진단 실행(LLM 13회, 직렬 경로 5회)이 이 시간 안에 끝나야 한다. Vercel Pro/Enterprise(fluid
// compute)의 최대값이다. Hobby 플랜은 300 이하로 낮춰야 배포된다(README '배포' 참고). 리터럴이어야 한다.
export const maxDuration = 800;

/** 파일 3개(이력서·JD·포트폴리오, 각 10MB) + 텍스트 여유분. */
const MAX_BODY_BYTES = 32 * 1024 * 1024;

export async function GET() {
  await ensureDatabase();
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const items = await listDiagnoses(user.id);
    return Response.json({ items }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return errorResponse(err, "GET /api/diagnoses");
  }
}

export async function POST(req: Request) {
  const startedAt = Date.now();
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  const ipLimit = diagnosisIpLimiter.hit(clientIp(req));
  if (!ipLimit.ok) {
    return Response.json(
      { error: "이 네트워크에서 오늘 만들 수 있는 진단 수를 넘었습니다. 내일 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSec) } },
    );
  }

  // Content-Length가 없는(chunked) 요청도 바이트를 세며 읽다가 한도를 넘으면 끊는다.
  let form: FormData;
  try {
    form = await readFormDataLimited(req, MAX_BODY_BYTES);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonError("업로드 용량이 너무 큽니다. 파일은 각각 10MB 이하로 올려 주세요.", 413);
    }
    return jsonError("요청 형식이 올바르지 않습니다. multipart/form-data로 보내 주세요.", 400);
  }

  try {
    const provider = await resolveRequestedProvider(requestedProvider(form));
    // 보관 공고로 진단: 내 공고인지 확인하고, JD·직무를 비워 보냈으면 공고의 것을 쓴다.
    const postingId = requestedPostingId(form);
    const posting = postingId ? await getPosting(user.id, postingId) : null;
    if (postingId && !posting) return jsonError(POSTING_NOT_FOUND, 404);
    const { input, warnings } = await parseDiagnosisForm(form, { posting });
    const { id } = await createDiagnosis(user.id, { ...input, postingId: posting?.id ?? null }, provider);
    after(async () => {
      try {
        await runDiagnosis(id, { deadlineAt: runDeadline(startedAt, maxDuration) });
      } catch (err) {
        console.error("[runDiagnosis]", id, err);
      }
    });
    return Response.json({ id, warnings } satisfies CreateDiagnosisResponse, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/diagnoses");
  }
}
