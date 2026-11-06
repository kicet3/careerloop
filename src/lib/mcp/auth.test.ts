/** MCP Bearer 인증: 헤더 형식, 없음·폐기·만료 토큰, 사용자 상태·동의, 범위, IP 실패 한도, 마지막 사용 기록. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTokenRecord } from "./tokens";

vi.mock("server-only", () => ({}));

const { authenticateMcpRequest, bearerToken, mcpAuthFailLimiter } = await import("./auth");

const TOKEN = `clp_${"a".repeat(43)}`;
const NOW = Date.parse("2026-11-06T00:00:00Z");

function record(over: Partial<McpTokenRecord> = {}): McpTokenRecord {
  return {
    id: "mcp_1",
    prefix: TOKEN.slice(0, 12),
    scopes: ["graph:read"],
    expiresAt: null,
    revokedAt: null,
    lastUsedAt: null,
    user: { id: "u1", name: "홍길동", status: "approved" },
    ...over,
  };
}

let ipSeq = 0;
let ip = "";
function req(auth?: string, extra: Record<string, string> = {}) {
  return new Request("http://localhost/api/mcp", {
    method: "POST",
    headers: { ...(auth !== undefined ? { Authorization: auth } : {}), "x-forwarded-for": ip, ...extra },
  });
}

const deps = (row: McpTokenRecord | null, missing: string[] = []) => ({
  findToken: vi.fn(async () => row),
  missingConsents: vi.fn(async () => missing as never[]),
  touch: vi.fn(async () => {}),
  now: () => NOW,
  env: {},
});

beforeEach(() => {
  ip = `10.0.0.${++ipSeq}`;
});

describe("bearerToken", () => {
  it("Bearer(대소문자 무시) + clp_ 접두사 + 길이 제한", () => {
    expect(bearerToken(`Bearer ${TOKEN}`)).toBe(TOKEN);
    expect(bearerToken(`bearer   ${TOKEN}  `)).toBe(TOKEN);
    expect(bearerToken(`Basic ${TOKEN}`)).toBeNull();
    expect(bearerToken("Bearer sk_abc")).toBeNull();
    expect(bearerToken(`Bearer clp_${"x".repeat(300)}`)).toBeNull();
    expect(bearerToken(null)).toBeNull();
  });
});

describe("authenticateMcpRequest", () => {
  it("유효한 토큰 → 사용자·토큰 앞부분, 마지막 사용 기록", async () => {
    const d = deps(record());
    const r = await authenticateMcpRequest(req(`Bearer ${TOKEN}`), d);
    expect(r).toEqual({ ok: true, auth: { user: { id: "u1", name: "홍길동" }, token: { id: "mcp_1", prefix: TOKEN.slice(0, 12) } } });
    expect(d.findToken).toHaveBeenCalledWith(TOKEN);
    expect(d.touch).toHaveBeenCalledWith("mcp_1", null);
  });

  it("헤더 없음 → 401 WWW-Authenticate Bearer + JSON-RPC 오류, DB 조회 없음", async () => {
    const d = deps(record());
    const r = await authenticateMcpRequest(req(), d);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.response.status).toBe(401);
    expect(r.response.headers.get("www-authenticate")).toBe('Bearer realm="careerloop"');
    expect(await r.response.json()).toEqual({ jsonrpc: "2.0", id: null, error: { code: -32001, message: "인증 토큰이 필요합니다." } });
    expect(d.findToken).not.toHaveBeenCalled();
  });

  it("형식이 틀린 토큰은 DB를 보지 않고 invalid_token", async () => {
    const d = deps(record());
    const r = await authenticateMcpRequest(req("Bearer nope"), d);
    expect(!r.ok && r.response.status).toBe(401);
    expect(!r.ok && r.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect(d.findToken).not.toHaveBeenCalled();
  });

  it.each([
    ["없는 토큰", null],
    ["폐기된 토큰", record({ revokedAt: new Date(NOW - 1000) })],
    ["만료된 토큰", record({ expiresAt: new Date(NOW) })],
  ])("%s → 401 invalid_token", async (_name, row) => {
    const r = await authenticateMcpRequest(req(`Bearer ${TOKEN}`), deps(row));
    expect(!r.ok && r.response.status).toBe(401);
    expect(!r.ok && r.response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it.each([
    ["suspended", [], "account_suspended"],
    ["rejected", [], "account_rejected"],
    ["pending", [], "approval_pending"],
    ["approved", ["terms"], "consent_required"],
  ])("사용자 %s(빠진 동의 %j) → 403 %s", async (status, missing, code) => {
    const r = await authenticateMcpRequest(req(`Bearer ${TOKEN}`), deps(record({ user: { id: "u1", name: null, status } }), missing));
    expect(!r.ok && r.response.status).toBe(403);
    if (!r.ok) expect((await r.response.json()).error.data).toEqual({ code });
  });

  it("graph:read 범위가 없으면 403 insufficient_scope", async () => {
    const r = await authenticateMcpRequest(req(`Bearer ${TOKEN}`), deps(record({ scopes: [] })));
    expect(!r.ok && r.response.status).toBe(403);
    expect(!r.ok && r.response.headers.get("www-authenticate")).toContain('error="insufficient_scope"');
  });

  it("IP당 실패 30회 넘으면 429(올바른 토큰이어도), 헤더 없음은 세지 않는다", async () => {
    for (let i = 0; i < 5; i++) await authenticateMcpRequest(req(), deps(null));
    for (let i = 0; i < 30; i++) {
      const r = await authenticateMcpRequest(req(`Bearer ${TOKEN}`), deps(null));
      expect(!r.ok && r.response.status).toBe(401);
    }
    const blocked = await authenticateMcpRequest(req(`Bearer ${TOKEN}`), deps(record()));
    expect(!blocked.ok && blocked.response.status).toBe(429);
    expect(!blocked.ok && Number(blocked.response.headers.get("retry-after"))).toBeGreaterThan(0);
    mcpAuthFailLimiter.reset(ip);
    expect((await authenticateMcpRequest(req(`Bearer ${TOKEN}`), deps(record()))).ok).toBe(true);
  });
});
