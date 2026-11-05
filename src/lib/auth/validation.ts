import { z } from "zod";

export type FieldErrors = Partial<Record<string, string>>;

/** zod 오류 → 필드별 첫 메시지. */
export function toFieldErrors(error: z.ZodError): FieldErrors {
  const out: FieldErrors = {};
  for (const issue of error.issues) {
    const key = String(issue.path[0] ?? "form");
    out[key] ??= issue.message;
  }
  return out;
}

export const DEFAULT_NEXT_PATH = "/app";

/**
 * 로그인 후 이동할 경로. 같은 사이트의 상대 경로만 허용하고 나머지는 기본값으로 바꾼다.
 * `//evil.com`, `/\evil.com`, `https://…`, 제어 문자 등 오픈 리다이렉트를 막는다.
 */
export function safeNextPath(next: unknown, fallback: string = DEFAULT_NEXT_PATH): string {
  if (typeof next !== "string" || next.length === 0 || next.length > 2048) return fallback;
  if (!next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  // 브라우저는 탭·개행을 지우고 역슬래시를 슬래시로 읽는다.
  if (/[\u0000-\u001f\u007f\\]/.test(next)) return fallback;
  try {
    const base = "http://same.invalid";
    const url = new URL(next, base);
    if (url.origin !== base) return fallback;
    // 로그인·가입 화면으로 되돌아가는 루프 방지
    if (url.pathname === "/login" || url.pathname === "/signup") return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}
