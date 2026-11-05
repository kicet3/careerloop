/**
 * 공고 원문 링크(클라이언트·서버 공용, 순수). 화면은 이 함수가 돌려준 주소만 <a target="_blank" rel="noopener noreferrer">로 연다.
 * http/https만 허용하고(javascript:·data: 등 거절), 사용자 정보(user:pass@)가 들어 있으면 거절한다.
 */
export function safeSourceUrl(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 2048) return null;
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return null;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password || !u.hostname) return null;
  return u.toString();
}

/** 링크 옆에 보일 짧은 호스트 이름(www. 제외). 잘못된 주소면 "". */
export function sourceHostLabel(raw: string | null | undefined): string {
  const safe = safeSourceUrl(raw);
  return safe ? new URL(safe).hostname.replace(/^www\./, "") : "";
}
