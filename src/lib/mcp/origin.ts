/**
 * /api/mcp의 Origin 검사(DNS 리바인딩·브라우저 남용 방지, MCP Streamable HTTP 보안 권고).
 * - Origin이 없으면 통과(Claude Code·Cursor·mcp-remote 같은 비브라우저 클라이언트).
 * - 있으면 앱 주소 호스트(trustedOriginHosts, https만)와 MCP_ALLOWED_ORIGINS(쉼표로 구분한 전체 origin)만 허용.
 *   개발 서버(APP_ENV가 PRODUCTION이 아니고 NODE_ENV도 production이 아님)에서는 localhost·127.0.0.1(아무 포트)도 허용한다.
 *   NODE_ENV를 함께 보는 건 APP_ENV를 PRODUCTION으로 두지 않은 스테이징·미리보기 배포(next start, NODE_ENV=production)를 막기 위해서다.
 * - "null"·잘못된 값은 거절. CORS 응답은 허용한 origin 하나만 그대로 돌려주고, "*"나 자격 증명 허용은 쓰지 않는다.
 */
import { isProduction, trustedOriginHosts } from "@/lib/config/env-rules";

type Env = Record<string, string | undefined>;

/** MCP_ALLOWED_ORIGINS → 정규화한 origin 목록(잘못된 값은 버린다). */
export function configuredMcpOrigins(env: Env = process.env): string[] {
  const out: string[] = [];
  for (const raw of (env.MCP_ALLOWED_ORIGINS ?? "").split(",")) {
    const v = raw.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if (u.protocol === "https:" || u.protocol === "http:") out.push(u.origin);
    } catch {
      // 무시
    }
  }
  return out;
}

export type OriginCheck = { ok: true; allowOrigin: string | null } | { ok: false };

export function checkMcpOrigin(origin: string | null, env: Env = process.env): OriginCheck {
  if (origin === null) return { ok: true, allowOrigin: null };
  let url: URL;
  try {
    if (origin === "null") return { ok: false };
    url = new URL(origin);
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return { ok: false };
  const normalized = url.origin;
  if (url.protocol === "https:" && trustedOriginHosts(env).includes(url.host)) return { ok: true, allowOrigin: normalized };
  if (configuredMcpOrigins(env).includes(normalized)) return { ok: true, allowOrigin: normalized };
  if (!isProduction(env) && env.NODE_ENV !== "production" && (url.hostname === "localhost" || url.hostname === "127.0.0.1")) return { ok: true, allowOrigin: normalized };
  return { ok: false };
}

/** 허용한 origin에만 붙이는 CORS 헤더. */
export function mcpCorsHeaders(allowOrigin: string | null): Record<string, string> {
  if (!allowOrigin) return {};
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    Vary: "Origin",
    "Access-Control-Expose-Headers": "WWW-Authenticate, Mcp-Session-Id, Retry-After",
  };
}

/** GET·DELETE도 넣는다: 브라우저 클라이언트가 GET(SSE)·DELETE(세션 종료)를 시도할 때 CORS 오류 대신 405를 보게 하려고. */
export const MCP_CORS_PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Methods": "POST, GET, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Accept, Mcp-Protocol-Version, Mcp-Session-Id, Last-Event-ID",
  "Access-Control-Max-Age": "600",
} as const;
