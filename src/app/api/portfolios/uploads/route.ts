import { randomBytes } from "node:crypto";
import { featureErrorResponse } from "@/lib/api/errors";
import { hitDbLimit, PORTFOLIO_UPLOAD_LIMIT } from "@/lib/auth/db-rate-limit";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { jsonError } from "@/lib/diagnoses/http";
import { PortfolioUploadInitSchema } from "@/lib/domain/portfolios";
import { portfolioStagingKey } from "@/lib/portfolios/http";
import { portfolioKindFromName, portfolioMaxFileBytes, tooLargeMessage, UNSUPPORTED_PORTFOLIO_FILE } from "@/lib/portfolios/original";
import { readJsonInput } from "@/lib/resumes/http";
import { presignPutObject, storageKind } from "@/lib/storage";

export const runtime = "nodejs";

/** 서명 주소 유효 시간(초). */
const PRESIGN_TTL_SEC = 10 * 60;
/** 브라우저가 PUT할 때 보낼 내용 유형(서명에 들어간다 — 실제 형식은 마무리 단계에서 서버가 정한다). */
const UPLOAD_CONTENT_TYPE = "application/octet-stream";

/**
 * 큰 포트폴리오 파일을 R2에 바로 올릴 서명된 PUT 주소. { fileName, size } → 200 { uploadId, url, method: "PUT", headers, expiresIn }.
 * 브라우저는 url에 파일을 PUT한 뒤 { uploadId, fileName }을 POST /api/portfolios(새로)·PUT /api/portfolios/[id](내용 바꾸기)·
 * PUT /api/resumes/[id]/portfolio(이력서에 붙이기)에 JSON으로 보내 마무리한다.
 * - 키는 세션 사용자의 임시 자리 uploads/<userId>/portfolio-<무작위>.<확장자>만 서명한다. 크기·내용 유형을 서명에 넣는다.
 * - 업로드 레이트 리밋(PORTFOLIO_UPLOAD_LIMIT)을 여기서 센다(마무리는 세지 않는다).
 * - 로컬 저장소(개발)면 409 { direct: true } — 화면은 multipart로 보낸다.
 */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const { fileName, size } = await readJsonInput(req, PortfolioUploadInitSchema, 4 * 1024);
    const kind = portfolioKindFromName(fileName);
    if (!kind) return jsonError(UNSUPPORTED_PORTFOLIO_FILE, 415);
    const maxBytes = portfolioMaxFileBytes();
    if (size > maxBytes) return jsonError(tooLargeMessage(maxBytes), 413);
    if (storageKind() !== "r2") return Response.json({ error: "이 서버는 파일을 바로 받습니다.", direct: true }, { status: 409 });

    const limit = await hitDbLimit(PORTFOLIO_UPLOAD_LIMIT, user.id);
    if (!limit.ok) {
      return Response.json(
        { error: "오늘 올릴 수 있는 포트폴리오 파일 수를 넘었습니다. 내일 다시 시도하거나 링크로 붙여 주세요." },
        { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
      );
    }
    const uploadId = `${randomBytes(12).toString("hex")}.${kind}`;
    const url = await presignPutObject(portfolioStagingKey(user.id, uploadId), {
      contentType: UPLOAD_CONTENT_TYPE,
      contentLength: size,
      expiresIn: PRESIGN_TTL_SEC,
    });
    if (!url) return Response.json({ error: "이 서버는 파일을 바로 받습니다.", direct: true }, { status: 409 });
    return Response.json(
      { uploadId, url, method: "PUT", headers: { "Content-Type": UPLOAD_CONTENT_TYPE }, expiresIn: PRESIGN_TTL_SEC, maxBytes },
      { headers: { "Cache-Control": "no-store" } },
    );
  } catch (err) {
    return featureErrorResponse(err, "POST /api/portfolios/uploads");
  }
}
