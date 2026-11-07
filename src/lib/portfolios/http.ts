import "server-only";
/**
 * 포트폴리오 라우트 공용(/api/portfolios·/api/resumes/[id]/portfolio): 파일 업로드 읽기(레이트 리밋 → 크기 제한 → 형식 확인(PDF만) → 텍스트 추출),
 * R2에 바로 올린 파일 마무리(임시 키 읽기 → 확인 → 추출), 업로드 상한, 404·잘림 경고 문구.
 *
 * 업로드 두 경로:
 * - 작은 파일(directMaxBytes 이하 — Vercel 4MB): multipart로 서버에 바로 보낸다.
 * - 큰 파일(maxBytes 이하, 기본 30MB): POST /api/portfolios/uploads로 서명된 PUT 주소를 받아 브라우저가 R2 uploads/<u>/에 바로 올리고,
 *   JSON { uploadId, fileName }으로 마무리한다. 서버가 객체를 읽어 크기·형식(매직 바이트)을 다시 확인하고, 확인한 그 바이트를 users/<u>/portfolios/<id>/에 쓴 뒤 임시 객체를 지운다.
 *   로컬 저장소(개발)는 서명 주소가 없어 multipart만 쓴다(자체 호스팅 상한 = maxBytes).
 */
import { consumeOnceDb, hitDbLimit, PORTFOLIO_UPLOAD_LIMIT } from "@/lib/auth/db-rate-limit";
import { BodyTooLargeError, readFormDataLimited } from "@/lib/diagnoses/body";
import { jsonError } from "@/lib/diagnoses/http";
import { MAX_PORTFOLIO_TEXT_CHARS, PortfolioDescriptionSchema, PortfolioTitleSchema, type PortfolioUploadConfig } from "@/lib/domain/portfolios";
import { IngestError } from "@/lib/ingest/extract";
import { parseJsonInput } from "@/lib/resumes/http";
import { deleteObject, getObject, storageKind, uploadStagingKey } from "@/lib/storage";
import {
  ingestPortfolioFile,
  portfolioDirectMaxBytes,
  portfolioKindFromName,
  portfolioMaxFileBytes,
  portfolioUploadKindFromName,
  tooLargeMessage,
  UNSUPPORTED_PORTFOLIO_FILE,
} from "./original";
import { PORTFOLIO_NOT_FOUND, type PortfolioOriginalInput } from "./service";

export const portfolioNotFound = () => jsonError(PORTFOLIO_NOT_FOUND, 404);

/** R2 서명 주소를 쓸 수 있는지(저장소가 R2). 설정 오류는 false(화면은 multipart로 시도하고 서버가 오류를 알린다). */
function presignAvailable(): boolean {
  try {
    return storageKind() === "r2";
  } catch {
    return false;
  }
}

/**
 * 포트폴리오 업로드 상한.
 * - perFile: multipart로 받는 파일 하나의 상한(Vercel 4MB, 자체 호스팅은 파일 상한).
 * - maxBody: multipart 본문 상한(perFile + 이름·설명 여유).
 * - config: 화면에 넘길 값(maxBytes = R2 서명 업로드가 되면 파일 상한, 아니면 perFile).
 */
export function portfolioUploadLimits(): { perFile: number; maxBody: number; config: PortfolioUploadConfig } {
  const perFile = portfolioDirectMaxBytes();
  const presigned = presignAvailable();
  const onVercel = !!process.env.VERCEL?.trim();
  return {
    perFile,
    maxBody: onVercel ? Math.min(perFile + 256 * 1024, 4.5 * 1024 * 1024) : perFile + 256 * 1024,
    config: { maxBytes: presigned ? Math.max(perFile, portfolioMaxFileBytes()) : perFile, directMaxBytes: perFile, presigned },
  };
}

export function isMultipart(req: Request): boolean {
  return (req.headers.get("content-type") ?? "").toLowerCase().startsWith("multipart/form-data");
}

export interface PortfolioUpload {
  fileName: string;
  text: string;
  warnings: string[];
  /** 보관할 원본(형식 확인을 마친 것). */
  original: PortfolioOriginalInput;
  /** 폼의 title·description(새로 만들 때만 쓴다). 비었으면 undefined. */
  title?: string;
  description?: string;
}

function formString(form: FormData, name: string): string | undefined {
  const v = form.get(name);
  return typeof v === "string" && v.trim() ? v : undefined;
}

/**
 * multipart 업로드(file + 선택 title·description)를 읽어 텍스트를 뽑는다. 사용자당 24시간 PORTFOLIO_UPLOAD_LIMIT회(본문을 읽기 전에 센다).
 * 실패하면 그대로 돌려줄 Response(429·413·400·415 등). 이름·설명 검증 실패는 FeatureError(400).
 */
export async function readPortfolioUpload(req: Request, userId: string): Promise<PortfolioUpload | Response> {
  const { perFile, maxBody } = portfolioUploadLimits();
  const limit = await hitDbLimit(PORTFOLIO_UPLOAD_LIMIT, userId);
  if (!limit.ok) {
    return Response.json(
      { error: "오늘 올릴 수 있는 포트폴리오 파일 수를 넘었습니다. 내일 다시 시도하거나 링크로 붙여 주세요." },
      { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
    );
  }
  let form: FormData;
  try {
    form = await readFormDataLimited(req, maxBody);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError(tooLargeMessage(perFile), 413);
    return jsonError("요청 형식이 올바르지 않습니다. multipart/form-data로 보내 주세요.", 400);
  }
  const title = formString(form, "title");
  const description = formString(form, "description");
  if (title !== undefined) parseJsonInput(PortfolioTitleSchema, title);
  if (description !== undefined) parseJsonInput(PortfolioDescriptionSchema, description);
  const f = form.get("file");
  if (!f || typeof f !== "object" || !("arrayBuffer" in f) || f.size === 0) return jsonError("올릴 포트폴리오 파일을 골라 주세요.", 400);
  const file = f as File;
  const fileName = file.name || "portfolio";
  // PDF만 받는다(이름 먼저 — 본문을 읽기 전에 거른다). 내용(%PDF-)은 ingestPortfolioFile이 다시 확인한다.
  if (!portfolioUploadKindFromName(fileName)) return jsonError(UNSUPPORTED_PORTFOLIO_FILE, 415);
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    const ingested = await ingestPortfolioFile({ name: fileName, bytes }, perFile);
    return {
      fileName,
      text: ingested.text,
      warnings: ingested.warnings,
      title,
      description,
      original: { ext: ingested.spec.ext, mime: ingested.spec.mime, size: bytes.byteLength, source: { bytes } },
    };
  } catch (err) {
    if (err instanceof IngestError) return jsonError(err.message, err.status);
    throw err;
  }
}

/** R2에 바로 올리는 임시 키(uploads/<userId>/portfolio-<꼬리>.<확장자>). uploadId는 '<꼬리>.<확장자>'(PortfolioUploadIdSchema로 검증한 값). */
export function portfolioStagingKey(userId: string, uploadId: string): string {
  return uploadStagingKey(userId, `portfolio-${uploadId}`);
}

/** 업로드 id 하나를 마무리할 수 있는 기간(임시 파일 수명 규칙 1일보다 길게 — 그동안 같은 id로 두 번 마무리하지 못한다). */
const STAGED_UPLOAD_ONCE_MS = 25 * 60 * 60_000;
const STAGED_UPLOAD_ONCE_BUCKET = "portfolio-upload-finalized";

/**
 * R2에 바로 올린 파일 마무리: 세션 사용자의 임시 키만 읽는다(다른 사용자의 업로드 id를 보내도 자기 접두사에서 찾으므로 404).
 * PDF가 아니면(이름 .pdf·내용 %PDF-) 415. 크기·형식이 틀리면 임시 객체를 지우고 오류 Response. 맞으면 PortfolioUpload — 원본은 여기서 확인한 바이트 그대로 저장하고
 * 임시 키는 지우기만 한다(서명 주소로 확인 뒤에 덮어쓴 바이트가 원본이 되지 않는다).
 * 업로드 id는 한 번만 마무리한다(409) — 서명 주소를 다시 써서 레이트 리밋 1회로 여러 번 마무리하지 못하게.
 * 레이트 리밋은 서명 주소를 받을 때(POST /api/portfolios/uploads) 이미 셌다.
 */
export async function readStagedPortfolioUpload(
  userId: string,
  input: { uploadId: string; fileName: string; title?: string; description?: string | null },
): Promise<PortfolioUpload | Response> {
  const maxBytes = portfolioMaxFileBytes();
  const ext = input.uploadId.slice(input.uploadId.lastIndexOf(".") + 1);
  const nameKind = portfolioKindFromName(input.fileName);
  if (nameKind !== ext) return jsonError("업로드 정보가 파일 이름과 맞지 않습니다. 파일을 다시 올려 주세요.", 400);
  const key = portfolioStagingKey(userId, input.uploadId);
  const bytes = await getObject(key);
  if (!bytes) return jsonError("올린 파일을 찾지 못했습니다. 시간이 지났거나 올리기가 끝나지 않았을 수 있습니다. 다시 올려 주세요.", 404);
  if (!(await consumeOnceDb(STAGED_UPLOAD_ONCE_BUCKET, `${userId}:${input.uploadId}`, STAGED_UPLOAD_ONCE_MS))) {
    return jsonError("이미 마무리한 업로드입니다. 파일을 다시 올려 주세요.", 409);
  }
  try {
    if (bytes.byteLength > maxBytes) throw new IngestError(tooLargeMessage(maxBytes), 413);
    const ingested = await ingestPortfolioFile({ name: input.fileName, bytes }, maxBytes);
    return {
      fileName: input.fileName,
      text: ingested.text,
      warnings: ingested.warnings,
      title: input.title?.trim() || undefined,
      description: input.description?.trim() || undefined,
      original: { ext: ingested.spec.ext, mime: ingested.spec.mime, size: bytes.byteLength, source: { bytes, stagedKey: key } },
    };
  } catch (err) {
    await deleteObject(key).catch((e) => console.error("[portfolio] 임시 업로드 삭제 실패", key, e));
    if (err instanceof IngestError) return jsonError(err.message, err.status);
    throw err;
  }
}

export function truncatedWarning(): string {
  return `포트폴리오가 길어 앞부분 ${MAX_PORTFOLIO_TEXT_CHARS.toLocaleString("ko-KR")}자만 저장했습니다. 지원 직무와 관련 있는 부분을 앞에 두면 좋습니다.`;
}

/** 미리보기 글자 수. */
export const PORTFOLIO_PREVIEW_CHARS = 600;
