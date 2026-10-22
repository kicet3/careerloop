import { after } from "next/server";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { parseDiagnosisForm } from "@/lib/diagnoses/form";
import { errorResponse, jsonError } from "@/lib/diagnoses/http";
import { createDiagnosis, listDiagnoses } from "@/lib/diagnoses/service";
import type { CreateDiagnosisResponse } from "@/lib/diagnoses/types";
import { runDiagnosis } from "@/lib/panel/runner";

export const runtime = "nodejs";
// after()로 이어지는 진단 실행(LLM 13회)이 이 시간 안에 끝나야 한다.
export const maxDuration = 300;

/** 파일 2개(각 10MB) + 텍스트 여유분. */
const MAX_BODY_BYTES = 22 * 1024 * 1024;

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
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  const length = Number(req.headers.get("content-length") ?? 0);
  if (length > MAX_BODY_BYTES) return jsonError("업로드 용량이 너무 큽니다. 파일은 각각 10MB 이하로 올려 주세요.", 413);

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return jsonError("요청 형식이 올바르지 않습니다. multipart/form-data로 보내 주세요.", 400);
  }

  try {
    const { input, warnings } = await parseDiagnosisForm(form);
    const { id } = await createDiagnosis(user.id, input);
    after(async () => {
      try {
        await runDiagnosis(id);
      } catch (err) {
        console.error("[runDiagnosis]", id, err);
      }
    });
    return Response.json({ id, warnings } satisfies CreateDiagnosisResponse, { status: 201 });
  } catch (err) {
    return errorResponse(err, "POST /api/diagnoses");
  }
}
