import { DEFAULT_NEXT_PATH } from "./validation";

/** 303 리다이렉트(상대 경로 — 프록시 뒤에서도 브라우저가 연 origin 기준으로 이동한다). */
export function redirectTo(path: string): Response {
  return new Response(null, { status: 303, headers: { Location: path, "Cache-Control": "no-store" } });
}

/** `/login?error=<code>[&next=…]`. next는 safeNextPath()를 거친 값만 넘긴다. */
export function loginErrorPath(code: string, next: string = DEFAULT_NEXT_PATH): string {
  const qs = new URLSearchParams({ error: code });
  if (next !== DEFAULT_NEXT_PATH) qs.set("next", next);
  return `/login?${qs.toString()}`;
}

export function loginErrorRedirect(code: string, next?: string): Response {
  return redirectTo(loginErrorPath(code, next));
}
