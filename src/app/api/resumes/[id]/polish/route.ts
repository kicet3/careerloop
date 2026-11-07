import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { readSmallJson } from "@/lib/chat/graph-chat";
import { jsonError } from "@/lib/diagnoses/http";
import { isPolishDocumentPath, isPolishPath, PolishTargetPathSchema, PolishUserMessageSchema } from "@/lib/domain/resume-polish";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { resumeNotFound } from "@/lib/resumes/http";
import { getPolishView, listPolishThreads, sendPolishMessage } from "@/lib/resumes/polish";
import { getPolishDocView, sendPolishDocMessage } from "@/lib/resumes/polish-document";

export const runtime = "nodejs";
// 답변을 요청 안에서 만든다(POLISH_TIMEOUT_MS 90초 + 그래프·저장 여유).
export const maxDuration = 120;

type Ctx = { params: Promise<{ id: string }> };
const NO_STORE = { "Cache-Control": "no-store" } as const;

/** ?target=<경로>: 그 칸의 지금 글과 대화(target=document면 전체 이력서 대화와 저장된 칸 글). 없으면 이 이력서의 다듬기 대화 목록. */
export async function GET(req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const target = new URL(req.url).searchParams.get("target");
    if (target === null) {
      const threads = await listPolishThreads(user.id, id);
      if (!threads) return resumeNotFound();
      return Response.json({ threads }, { headers: NO_STORE });
    }
    if (isPolishDocumentPath(target)) return Response.json(await getPolishDocView(user.id, id), { headers: NO_STORE });
    if (!isPolishPath(target)) return jsonError("다듬을 수 없는 항목입니다.", 400);
    return Response.json(await getPolishView(user.id, id, target), { headers: NO_STORE });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/resumes/[id]/polish");
  }
}

const BodySchema = z.object({ targetPath: PolishTargetPathSchema, message: PolishUserMessageSchema, provider: z.string().max(40).nullish() });

/** 요청을 보내고 대안 문구 2~3개(전체 이력서면 답변 + 칸 제안 0~6개)를 받는다(같은 요청 안에서). 결과는 갱신된 대화. */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const body = BodySchema.safeParse(await readSmallJson(req));
    if (!body.success) {
      const msg = body.error.issues[0]?.message ?? "";
      return jsonError(/[가-힣]/.test(msg) ? msg : "요청 형식이 올바르지 않습니다.", 400);
    }
    const provider = await resolveRequestedProvider(body.data.provider ?? null);
    const { targetPath, message } = body.data;
    const view = isPolishDocumentPath(targetPath)
      ? await sendPolishDocMessage(user.id, id, { message, provider })
      : await sendPolishMessage(user.id, id, { targetPath, message, provider });
    return Response.json(view, { headers: NO_STORE });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/resumes/[id]/polish");
  }
}
