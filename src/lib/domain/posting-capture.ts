/**
 * 공고 원문 페이지 캡처 계약(클라이언트·서버 공용). 공용 공고(shared_postings)마다 한 장을 저장소
 * shared-postings/<sharedPostingId>/capture.webp(또는 .jpg)에 두고, 상태는 shared_postings.capture_* 컬럼에 둔다.
 * 캡처는 URL 가져오기를 막지 않는다(가져오기가 끝난 뒤 after()로 따로 찍는다). 저장 함수는 src/lib/postings/capture-store.ts,
 * 찍는 코드(헤드리스 Chromium)는 src/lib/postings/capture.ts. 이미지는 로그인한 사용자에게 인증 라우트로만 보낸다.
 */

/** pending: 예약됨 · running: 찍는 중 · done: 저장됨 · failed: 실패(다시 시도 가능). null(행 값) = 요청한 적 없음. */
export const POSTING_CAPTURE_STATUSES = ["pending", "running", "done", "failed"] as const;
export type PostingCaptureStatus = (typeof POSTING_CAPTURE_STATUSES)[number];

export const POSTING_CAPTURE_MIMES = ["image/webp", "image/jpeg"] as const;
export type PostingCaptureMime = (typeof POSTING_CAPTURE_MIMES)[number];

/** 캡처 설정. 헤드리스 브라우저 코드와 화면 안내가 같은 값을 쓴다. */
export const POSTING_CAPTURE = {
  viewportWidth: 1280,
  viewportHeight: 900,
  /** 전체 페이지 높이 상한(px). 넘으면 위에서부터 이 높이까지만 찍는다. */
  maxHeight: 20_000,
  /** WebP/JPEG 품질. */
  quality: 70,
  /** 첫 탐색(리다이렉트 포함) 마감. */
  navigationTimeoutMs: 25_000,
  /** 탐색 뒤 지연 로딩·배너 닫기를 기다리는 시간. */
  settleMs: 2_500,
  /** 브라우저 실행부터 저장까지 전체 마감(Vercel 함수 시간 안). */
  totalTimeoutMs: 75_000,
  /** 저장할 이미지 크기 상한. 넘으면 품질을 낮춰 한 번 더 인코딩하고, 그래도 넘으면 실패. */
  maxBytes: 8 * 1024 * 1024,
  /** 페이지가 받는 전체 응답(하위 리소스 포함) 상한 — 넘으면 이후 요청을 막는다. */
  maxTransferBytes: 25 * 1024 * 1024,
  /** 자동(가져오기 직후) 시도 + 다시 시도의 누적 상한. 성공하면 0으로 돌아간다. */
  maxAttempts: 5,
  /** pending/running이 이 시간보다 오래되면 멈춘 작업으로 보고 다시 맡을 수 있다. */
  staleMs: 3 * 60_000,
} as const;

/** 화면용 캡처 정보. 캡처가 없거나 요청한 적 없으면 status 'none'. */
export interface PostingCaptureInfo {
  status: PostingCaptureStatus | "none";
  /** 마지막 성공 시각(ms). */
  capturedAt: number | null;
  mime: PostingCaptureMime | null;
  bytes: number | null;
  width: number | null;
  height: number | null;
  /** 실패 문구(사용자에게 보여도 되는 한국어). */
  error: string | null;
  /** 지금 '다시 시도'를 보여 줄지(실패·없음이고 시도 상한 전, 또는 멈춘 작업). 레이트 리밋은 별도. */
  retryable: boolean;
}

/** 저장소 파일 확장자. */
export function captureExtension(mime: PostingCaptureMime): "webp" | "jpg" {
  return mime === "image/webp" ? "webp" : "jpg";
}
