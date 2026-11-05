import { after } from "next/server";
import { DIAGNOSIS_IP_LIMIT, hitDbLimit, ipKey } from "@/lib/auth/db-rate-limit";
import { clientIp } from "@/lib/auth/rate-limit";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { runDeadline } from "@/lib/diagnoses/deadline";
import { parseDiagnosisForm, requestedPostingId, requestedProvider } from "@/lib/diagnoses/form";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { createDiagnosis, listDiagnoses } from "@/lib/diagnoses/service";
import type { CreateDiagnosisResponse } from "@/lib/diagnoses/types";
import { runDiagnosis } from "@/lib/panel/runner";
import { uploadLimitMessage, uploadLimitsFor } from "@/lib/ingest/upload-limits";
import { getPosting, POSTING_NOT_FOUND } from "@/lib/postings/service";
import { resolveRequestedProvider } from "@/lib/providers/options";

export const runtime = "nodejs";
// after()로 이어지는 진단 실행(LLM 13회, 직렬 경로 5회)의 시간 상한. 300초는 모든 Vercel 플랜에서 배포된다.
// Vercel에서는 runner가 maxDuration - 30초에 스스로 멈추고, 진행 화면이 남은 단계를 자동으로 이어서 실행한다(재시도 횟수와 별개).
// Pro/Enterprise(fluid compute)라면 800까지 올릴 수 있다(README '배포' 참고). Next가 정적으로 읽으므로 리터럴이어야 한다.
export const maxDuration = 300;


export async function GET() {
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
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  const ipLimit = await hitDbLimit(DIAGNOSIS_IP_LIMIT, ipKey(clientIp(req)));
  if (!ipLimit.ok) {
    return Response.json(
      { error: "이 네트워크에서 오늘 만들 수 있는 진단 수를 넘었습니다. 내일 다시 시도해 주세요." },
      { status: 429, headers: { "Retry-After": String(ipLimit.retryAfterSec) } },
    );
  }

  // Content-Length가 없는(chunked) 요청도 바이트를 세며 읽다가 한도를 넘으면 끊는다.
  // 상한: 자체 호스팅은 파일 3개(각 10MB) + 텍스트 여유분, Vercel은 플랫폼의 요청 본문 상한 4.5MB(src/lib/ingest/upload-limits.ts).
  const limits = uploadLimitsFor();
  let form: FormData;
  try {
    form = await readFormDataLimited(req, limits.maxBodyBytes);
  } catch (err) {
    if (err instanceof BodyTooLargeError) {
      return jsonError(`업로드 용량이 너무 큽니다. ${uploadLimitMessage(limits)}`, 413);
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
