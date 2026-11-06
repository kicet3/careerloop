import "server-only";
/**
 * MCP 요청 인증(Bearer 개인 토큰). 쿠키는 보지 않는다 — 브라우저 세션으로는 /api/mcp를 쓸 수 없다.
 * 순서: IP 실패 한도 → 헤더 형식 → 토큰 행(없음·폐기·만료) → 사용자 상태·필수 동의(요청마다 다시 본다) → 범위.
 * 사용자 id는 토큰 행에서만 정한다. 실패 응답 본문은 JSON-RPC 오류 형식(id null)이다.
 */
import { ACCESS_API_ERRORS, accessDecision } from "@/lib/auth/access";
import { clientIp, createRateLimiter } from "@/lib/auth/rate-limit";
import { isUserStatus, type UserStatus } from "@/lib/domain/users";
import { MCP_TOKEN_MAX_LEN, MCP_TOKEN_PREFIX, type McpScope } from "@/lib/domain/mcp";
import type { ConsentType } from "@/lib/legal/consents";
import { getMissingConsents } from "@/lib/legal/service";
import { findMcpToken, type McpTokenRecord, touchMcpToken } from "./tokens";

export const MCP_REALM = "careerloop";
/** JSON-RPC 오류 코드(서버 정의 영역): 인증·권한 실패. */
export const MCP_AUTH_ERROR_CODE = -32001;

export interface McpAuthContext {
  user: { id: string; name: string | null };
  token: { id: string; prefix: string };
}

export type McpAuthResult = { ok: true; auth: McpAuthContext } | { ok: false; response: Response };

export interface McpAuthDeps {
  findToken?: (token: string) => Promise<McpTokenRecord | null>;
  missingConsents?: (userId: string) => Promise<readonly ConsentType[]>;
  touch?: (id: string, lastUsedAt: Date | null) => Promise<void>;
  now?: () => number;
  env?: Record<string, string | undefined>;
}

const globalForMcp = globalThis as unknown as { __mcpAuthFailLimiter?: ReturnType<typeof createRateLimiter> };
/** 인증 실패: IP당 10분 30회(토큰 추측 방지). 성공한 요청은 세지 않는다. 인스턴스마다 따로 센다. */
export const mcpAuthFailLimiter = (globalForMcp.__mcpAuthFailLimiter ??= createRateLimiter({ limit: 30, windowMs: 10 * 60_000 }));

export function jsonRpcErrorBody(code: number, message: string, data?: unknown) {
  return { jsonrpc: "2.0" as const, id: null, error: { code, message, ...(data !== undefined ? { data } : {}) } };
}

function authFail(status: number, message: string, wwwAuthenticate: string | null, data?: unknown): Response {
  const headers: Record<string, string> = { "Cache-Control": "no-store" };
  if (wwwAuthenticate) headers["WWW-Authenticate"] = wwwAuthenticate;
  return Response.json(jsonRpcErrorBody(MCP_AUTH_ERROR_CODE, message, data), { status, headers });
}

/** Authorization 헤더에서 토큰 원문. 형식이 틀리면 null(DB를 보지 않는다). */
export function bearerToken(header: string | null): string | null {
  if (!header) return null;
  const m = /^Bearer[ \t]+(\S+)[ \t]*$/i.exec(header.trim());
  if (!m) return null;
  const token = m[1]!;
  if (token.length > MCP_TOKEN_MAX_LEN || !token.startsWith(MCP_TOKEN_PREFIX)) return null;
  return token;
}

const REQUIRED_SCOPE: McpScope = "graph:read";

export async function authenticateMcpRequest(req: Request, deps: McpAuthDeps = {}): Promise<McpAuthResult> {
  const now = deps.now?.() ?? Date.now();
  const ip = clientIp(req, deps.env);
  const blocked = mcpAuthFailLimiter.peek(ip, now);
  if (!blocked.ok) {
    return {
      ok: false,
      response: Response.json(jsonRpcErrorBody(MCP_AUTH_ERROR_CODE, "인증 실패가 너무 많습니다. 잠시 후 다시 시도해 주세요."), {
        status: 429,
        headers: { "Retry-After": String(blocked.retryAfterSec), "Cache-Control": "no-store" },
      }),
    };
  }
  const fail = (status: number, message: string, wwwAuthenticate: string | null, data?: unknown): McpAuthResult => {
    mcpAuthFailLimiter.hit(ip, now);
    return { ok: false, response: authFail(status, message, wwwAuthenticate, data) };
  };

  const header = req.headers.get("authorization");
  const raw = bearerToken(header);
  if (!raw) {
    // 헤더가 아예 없으면 토큰 추측이 아니다 — 실패로 세지 않는다(클라이언트가 처음 붙을 때 401로 인증 필요를 알린다).
    if (!header) return { ok: false, response: authFail(401, "인증 토큰이 필요합니다.", `Bearer realm="${MCP_REALM}"`) };
    return fail(401, "인증 토큰 형식이 올바르지 않습니다.", `Bearer realm="${MCP_REALM}", error="invalid_token"`);
  }

  const row = await (deps.findToken ?? findMcpToken)(raw);
  const invalid = `Bearer realm="${MCP_REALM}", error="invalid_token"`;
  if (!row) return fail(401, "유효하지 않은 토큰입니다.", invalid);
  if (row.revokedAt) return fail(401, "폐기된 토큰입니다.", invalid);
  if (row.expiresAt && row.expiresAt.getTime() <= now) return fail(401, "만료된 토큰입니다.", invalid);

  const status: UserStatus = isUserStatus(row.user.status) ? row.user.status : "pending";
  const missing =
    status === "rejected" || status === "suspended" ? [] : await (deps.missingConsents ?? getMissingConsents)(row.user.id);
  const decision = accessDecision(status, missing);
  if (decision !== "ok") {
    const e = ACCESS_API_ERRORS[decision];
    return { ok: false, response: authFail(403, e.error, null, { code: e.code }) };
  }

  if (!row.scopes.includes(REQUIRED_SCOPE)) {
    return {
      ok: false,
      response: authFail(403, "이 토큰에는 경험 그래프 읽기 권한이 없습니다.", `Bearer realm="${MCP_REALM}", error="insufficient_scope", scope="${REQUIRED_SCOPE}"`),
    };
  }

  // 마지막 사용 시각(5분 간격) — 응답을 기다리게 하지 않는다.
  void (deps.touch ?? touchMcpToken)(row.id, row.lastUsedAt).catch((err) => console.warn("[mcp] last_used_at 갱신 실패", (err as Error).message));
  return { ok: true, auth: { user: { id: row.user.id, name: row.user.name }, token: { id: row.id, prefix: row.prefix } } };
}
