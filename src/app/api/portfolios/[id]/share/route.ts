import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { PublishPortfolioShareSchema, UpdatePortfolioShareSchema } from "@/lib/domain/portfolio-shares";
import { portfolioNotFound } from "@/lib/portfolios/http";
import { getShareStatus, publishShare, revokeShare, updateShareOptions } from "@/lib/portfolios/shares";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
// 원본 공개를 고르면 원본(최대 30MB)을 저장소 안에서 복사한다.
export const maxDuration = 60;

type Ctx = { params: Promise<{ id: string }> };

const NO_STORE = { "Cache-Control": "no-store" };

/** 공개 상태(소유자만). → { share: PortfolioShareStatus | null } */
export async function GET(_req: Request, { params }: Ctx) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const got = await getShareStatus(user.id, id.slice(0, 64));
    if (!got) return portfolioNotFound();
    return Response.json(got, { headers: NO_STORE });
  } catch (err) {
    return featureErrorResponse(err, "GET /api/portfolios/[id]/share");
  }
}

/** 공개하기·공개본 업데이트(지금 내용으로 공개본을 새로 만든다). { showName, includeOriginal, allowChat, indexable } → { share } */
export async function POST(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const options = await readJsonInput(req, PublishPortfolioShareSchema, 4 * 1024);
    const share = await publishShare(user.id, id.slice(0, 64), options);
    if (!share) return portfolioNotFound();
    return Response.json({ share }, { headers: NO_STORE });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/portfolios/[id]/share");
  }
}

/** 챗봇·검색 노출만 바꾸기(공개본은 그대로). { allowChat?, indexable? } → { share }. 공개 중이 아니면 404. */
export async function PATCH(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const patch = await readJsonInput(req, UpdatePortfolioShareSchema, 4 * 1024);
    const share = await updateShareOptions(user.id, id.slice(0, 64), patch);
    if (!share) return portfolioNotFound();
    return Response.json({ share }, { headers: NO_STORE });
  } catch (err) {
    return featureErrorResponse(err, "PATCH /api/portfolios/[id]/share");
  }
}

/** 공개 끄기(바로 404가 된다). 공개 중이 아니어도 204. */
export async function DELETE(req: Request, { params }: Ctx) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const { id } = await params;
  try {
    const ok = await revokeShare(user.id, id.slice(0, 64));
    if (ok === null) return portfolioNotFound();
    return new Response(null, { status: 204 });
  } catch (err) {
    return featureErrorResponse(err, "DELETE /api/portfolios/[id]/share");
  }
}
