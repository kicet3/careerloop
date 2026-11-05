import { requireApiUser } from "@/lib/auth/session";
import { captureInfoResponse, resolveCaptureTarget } from "@/lib/postings/capture-http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 내 공고의 원문 캡처 상태(PostingCaptureInfo). 직접 입력 공고는 404. */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  return captureInfoResponse(await resolveCaptureTarget(user, { postingId: id }), "GET /api/postings/[id]/capture/info");
}
