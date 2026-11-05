/**
 * 모델 출력의 근거 검사(순수): 인용·항목이 공고 본문(원문 또는 모델에 준 무력화 본문)에 실제로 있는지.
 * - 1차: NFC 정규화·공백 접기 후 부분 문자열.
 * - 2차: 공백을 모두 지우고 비교(한국 공고는 줄바꿈·표 때문에 띄어쓰기가 원문과 달라지는 일이 많다).
 * 리스트 항목은 비교 전에 앞의 글머리(-•·■①1. 등)를 떼고(stripBullet), 그대로 없으면 끝 문장부호도 떼어 다시 본다.
 */
import { neutralizeChat } from "@/lib/chat/prompt";

const normalize = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();
const squash = (s: string) => s.normalize("NFC").replace(/\s+/g, "");

/** 항목 앞 글머리(기호·원문자·번호)를 뗀다. */
export function stripBullet(text: string): string {
  return text
    .normalize("NFC")
    .trim()
    .replace(/^(?:(?:[-–—•·∙◦▪▫■□◆◇▶▷►○●◎※*✓✔☑#>]|[①-⑳]|\(?\d{1,2}[.)]|\(?[a-zA-Z가-힣][.)](?=\s))\s*)+/u, "")
    .trim();
}

/** 끝 문장부호까지 뗀 비교용 문구. */
export function stripTrailingPunct(text: string): string {
  return text.replace(/[\s.,;:·、。]+$/u, "").trim();
}

export type EvidenceCheck = (quote: string) => boolean;

/** 본문에 근거 문구가 있는지 판정하는 함수. 2자 미만은 근거로 보지 않는다. */
export function evidenceChecker(pageText: string, opts: { ignoreCase?: boolean } = {}): EvidenceCheck {
  const fold = (s: string) => (opts.ignoreCase ? s.toLowerCase() : s);
  const sources = [pageText, neutralizeChat(pageText)];
  const spaced = sources.map((t) => fold(normalize(t)));
  const squashed = sources.map((t) => fold(squash(t)));
  return (quote: string) => {
    const q = fold(normalize(quote));
    if (q.length < 2) return false;
    if (spaced.some((h) => h.includes(q))) return true;
    const sq = fold(squash(quote));
    return sq.length >= 2 && squashed.some((h) => h.includes(sq));
  };
}
