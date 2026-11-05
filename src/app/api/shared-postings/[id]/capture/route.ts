import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { captureImageResponse, captureRetryResponse, resolveCaptureTarget } from "@/lib/postings/capture-http";

export const runtime = "nodejs";
// POST가 after()로 이어 찍는 원문 캡처(전체 75초 상한)가 이 시간 안에 끝나야 한다. 리터럴이어야 한다.
export const maxDuration = 300;

type Ctx = { params: Promise<{ id: string }> };

/** 공용 공고 원문 캡처 이미지(로그인 사용자만, 공개 URL 없음). 없으면 404. */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  return captureImageResponse(await resolveCaptureTarget(user, { sharedId: id }), "GET /api/shared-postings/[id]/capture");
}

/** 원문 캡처 다시 시도 → 202 { capture }. 사용자 24시간 10회·공고 1시간 3회. */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  return captureRetryResponse(user, await resolveCaptureTarget(user, { sharedId: id }), "POST /api/shared-postings/[id]/capture");
}
