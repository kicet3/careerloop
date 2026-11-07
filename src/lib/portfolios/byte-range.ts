/**
 * HTTP Range(RFC 9110 §14) 한 구간만 다루는 순수 함수. 원본 PDF 보기(?viewer=1)가 큰 파일을 조각으로 받아 가는 데 쓴다.
 * - 여러 구간("bytes=0-1,5-9")·문법이 틀린 값·bytes 밖 단위는 무시한다(none — 명세상 서버는 Range를 무시할 수 있다).
 * - 파일 안에서 시작하지 않는 구간(시작 ≥ 크기, 길이 0인 끝 구간, 빈 파일)은 unsatisfiable(416).
 * - 끝은 파일 끝·maxLength로 자른다(서버가 요청보다 짧게 보내고 Content-Range로 알린다).
 */
export type RangeParse = { kind: "none" } | { kind: "unsatisfiable" } | { kind: "range"; start: number; end: number };

const RANGE_RE = /^bytes=(\d*)-(\d*)$/i;

export function parseRangeHeader(header: string | null | undefined, size: number, maxLength = Number.POSITIVE_INFINITY): RangeParse {
  if (!header) return { kind: "none" };
  const m = RANGE_RE.exec(header.trim());
  if (!m) return { kind: "none" };
  const [, a, b] = m;
  if (!a && !b) return { kind: "none" };
  // 자릿수가 너무 긴 값은 정수로 다룰 수 없다 — 문법 오류로 본다.
  if (a.length > 15 || b.length > 15) return { kind: "none" };
  let start: number;
  let end: number;
  if (!a) {
    // 끝에서 N바이트.
    const suffix = Number(b);
    if (suffix === 0 || size <= 0) return { kind: "unsatisfiable" };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(a);
    end = b ? Number(b) : size - 1;
    if (b && end < start) return { kind: "none" };
    if (start >= size) return { kind: "unsatisfiable" };
    end = Math.min(end, size - 1);
  }
  if (Number.isFinite(maxLength) && maxLength > 0) end = Math.min(end, start + Math.floor(maxLength) - 1);
  return { kind: "range", start, end };
}

/** 206 응답의 Content-Range 값. */
export const contentRangeHeader = (start: number, end: number, size: number) => `bytes ${start}-${end}/${size}`;
/** 416 응답의 Content-Range 값. */
export const unsatisfiedRangeHeader = (size: number) => `bytes */${size}`;
