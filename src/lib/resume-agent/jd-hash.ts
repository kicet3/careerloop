/**
 * JD 비교용 정규화·해시(서버 전용 — node:crypto). 공백만 다른 JD는 같은 JD로 본다.
 * 저장된 JD 분석 재사용(jd-source.ts)과 지원 동기 추천의 'JD가 바뀌었는가'(src/lib/resumes/motivation.ts)가 같은 함수를 쓴다.
 */
import { createHash } from "node:crypto";

/** 공백(줄바꿈 포함)을 한 칸으로, 앞뒤 공백 제거. */
export function normalizeJd(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

/** 정규화한 JD의 sha256(hex). 빈 JD도 해시를 갖는다. */
export function jdHash(text: string | null | undefined): string {
  return createHash("sha256").update(normalizeJd(text)).digest("hex");
}
