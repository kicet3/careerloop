import { requireApiUser } from "@/lib/auth/session";
import { captureInfoResponse, resolveCaptureTarget } from "@/lib/postings/capture-http";

export const runtime = "nodejs";

type Ctx = { params: Promise<{ id: string }> };

/** 공용 공고 원문 캡처 상태(PostingCaptureInfo). */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  return captureInfoResponse(await resolveCaptureTarget(user, { sharedId: id }), "GET /api/shared-postings/[id]/capture/info");
}
