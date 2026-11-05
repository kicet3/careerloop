/**
 * 업로드 용량 상한. 화면(FileDrop·새 진단 폼)과 서버(POST /api/diagnoses, extractText)가 같은 값을 쓴다.
 * 순수 모듈이라 클라이언트에서도 불러올 수 있다 — 단 어느 값을 쓸지(uploadLimitsFor)는 서버에서 정해 props로 넘긴다.
 *
 * Vercel Functions는 요청 본문이 4.5MB를 넘으면 핸들러에 닿기 전에 413(FUNCTION_PAYLOAD_TOO_LARGE)으로 거절한다.
 * 그래서 Vercel에서는 파일 합계를 4MB로 묶는다(텍스트 필드 — 이력서 4만 자·JD 3만 자 등 — 를 더해도 4.5MB 안).
 */

const MB = 1024 * 1024;

export interface UploadLimits {
  /** 파일 하나의 상한(바이트). */
  perFileBytes: number;
  /** 한 요청에 올리는 파일(이력서·JD·포트폴리오) 합계 상한(바이트). */
  totalFileBytes: number;
  /** 서버가 읽을 요청 본문 상한(파일 합계 + 텍스트 필드 여유). */
  maxBodyBytes: number;
}

/** 자체 호스팅: 파일당 10MB, 파일 3개 합계 30MB. */
export const SELF_HOSTED_UPLOAD_LIMITS: UploadLimits = { perFileBytes: 10 * MB, totalFileBytes: 30 * MB, maxBodyBytes: 32 * MB };
/** Vercel(요청 본문 4.5MB 상한): 파일당·합계 4MB. */
export const VERCEL_UPLOAD_LIMITS: UploadLimits = { perFileBytes: 4 * MB, totalFileBytes: 4 * MB, maxBodyBytes: 4.5 * MB };

/** 이 서버의 업로드 상한(서버에서만 부른다 — 클라이언트에는 VERCEL 변수가 없다). */
export function uploadLimitsFor(env: Record<string, string | undefined> = process.env): UploadLimits {
  return env.VERCEL?.trim() ? VERCEL_UPLOAD_LIMITS : SELF_HOSTED_UPLOAD_LIMITS;
}

/** 4194304 → "4MB", 10485760 → "10MB" */
export function formatMb(bytes: number): string {
  const mb = bytes / MB;
  return `${Number.isInteger(mb) ? mb : mb.toFixed(1)}MB`;
}

/** 413 등에서 보여 줄 안내. */
export function uploadLimitMessage(limits: UploadLimits): string {
  return limits.totalFileBytes < limits.perFileBytes * 3
    ? `파일은 각각 ${formatMb(limits.perFileBytes)} 이하, 모두 합쳐 ${formatMb(limits.totalFileBytes)} 이하로 올려 주세요.`
    : `파일은 각각 ${formatMb(limits.perFileBytes)} 이하로 올려 주세요.`;
}

/** 고른 파일들의 합계가 상한을 넘으면 안내 문구, 아니면 null. */
export function totalUploadError(files: readonly ({ size: number } | null | undefined)[], limits: UploadLimits): string | null {
  const total = files.reduce((sum, f) => sum + (f?.size ?? 0), 0);
  if (total <= limits.totalFileBytes) return null;
  return `올린 파일의 합계(${formatMb(total)})가 ${formatMb(limits.totalFileBytes)}를 넘습니다. 파일 크기를 줄이거나 내용을 직접 붙여넣어 주세요.`;
}
