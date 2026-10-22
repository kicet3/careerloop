/**
 * 인용 검증: 모델이 낸 quote가 이력서 원문에 실제로 있는지 확인한다.
 * PDF 추출로 줄바꿈·공백이 달라지거나, 모델이 글머리표·따옴표 모양을 바꾸는 정도는 허용한다.
 */

const MIN_QUOTE_CHARS = 4;
const ELLIPSIS_RE = /…|\.{3,}/;

/** 줄머리 글머리표(목록 기호). '-'·'*'·숫자 목록 표시는 줄 앞에 있을 때만 지운다. */
const LEADING_BULLET_RE = /^[\s\-–—*•◦▪▫●○■□►▶‣⁃∙·]+|^\d{1,2}[.)]\s+/u;

export function normalizeForQuote(text: string): string {
  const lines = text
    .normalize("NFKC")
    .replace(/[​-‍⁠﻿­]/g, "")
    .split(/\r?\n|\r/)
    .map((line) => line.replace(LEADING_BULLET_RE, ""));
  return (
    lines
      .join(" ")
      .replace(/[‘’‚‛′`´]/g, "'")
      .replace(/[“”„‟″«»「」『』]/g, '"')
      .replace(/[‐‑‒–—―−﹘﹣]/g, "-")
      .replace(/[•◦▪▫●○■□►▶‣⁃∙]/g, " ")
      // Markdown 강조 기호는 모델이 붙이거나 빼는 경우가 많다
      .replace(/\*{1,3}|_{2,}|#{1,6}\s/g, " ")
      .toLowerCase()
      // 공백은 모두 제거한다(PDF 추출 시 한글 띄어쓰기가 깨지는 경우 대비)
      .replace(/\s+/g, "")
  );
}

/** 끝의 문장부호 차이(마침표 유무 등)는 무시한다. */
function trimEdgePunct(s: string): string {
  return s.replace(/^["'(\[]+/, "").replace(/[.,;:!?"')\]]+$/, "");
}

/**
 * quote가 이력서에 (정규화 후) 부분 문자열로 있으면 true.
 * '…' 또는 '...'로 생략된 인용은 생략 전후 조각들이 순서대로 나타나면 true.
 */
export function verifyQuote(resumeText: string, quote: string): boolean {
  if (!quote || !resumeText) return false;
  const haystack = normalizeForQuote(resumeText);
  const segments = quote
    .normalize("NFKC")
    .split(ELLIPSIS_RE)
    .map((seg) => trimEdgePunct(normalizeForQuote(seg)))
    .filter((seg) => seg.length > 0);
  if (segments.length === 0) return false;
  const total = segments.reduce((n, seg) => n + seg.length, 0);
  if (total < MIN_QUOTE_CHARS) return false;

  let from = 0;
  for (const seg of segments) {
    const at = haystack.indexOf(seg, from);
    if (at < 0) return false;
    from = at + seg.length;
  }
  return true;
}
