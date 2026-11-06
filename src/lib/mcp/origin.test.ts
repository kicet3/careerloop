/** /api/mcp Origin 검사: 없음 통과, 앱 주소·MCP_ALLOWED_ORIGINS만 허용, "null"·다른 출처 거절, 개발 모드 localhost. */
import { describe, expect, it } from "vitest";
import { checkMcpOrigin, configuredMcpOrigins, mcpCorsHeaders } from "./origin";

const prod = { APP_ENV: "PRODUCTION", APP_URL: "https://resume.snowlink.team" };

describe("checkMcpOrigin", () => {
  it("Origin이 없으면 통과(CORS 헤더 없음)", () => {
    expect(checkMcpOrigin(null, prod)).toEqual({ ok: true, allowOrigin: null });
  });

  it("앱 주소는 허용, 다른 출처·null·잘못된 값은 거절", () => {
    expect(checkMcpOrigin("https://resume.snowlink.team", prod)).toEqual({ ok: true, allowOrigin: "https://resume.snowlink.team" });
    expect(checkMcpOrigin("https://evil.example", prod)).toEqual({ ok: false });
    expect(checkMcpOrigin("http://resume.snowlink.team", prod)).toEqual({ ok: false });
    expect(checkMcpOrigin("null", prod)).toEqual({ ok: false });
    expect(checkMcpOrigin("not a url", prod)).toEqual({ ok: false });
    expect(checkMcpOrigin("http://localhost:6274", prod)).toEqual({ ok: false });
  });

  it("MCP_ALLOWED_ORIGINS(전체 origin, 쉼표)", () => {
    const env = { ...prod, MCP_ALLOWED_ORIGINS: " https://claude.ai , bad value,https://inspector.example:8443/path" };
    expect(configuredMcpOrigins(env)).toEqual(["https://claude.ai", "https://inspector.example:8443"]);
    expect(checkMcpOrigin("https://claude.ai", env)).toEqual({ ok: true, allowOrigin: "https://claude.ai" });
    expect(checkMcpOrigin("https://inspector.example:8443", env).ok).toBe(true);
    expect(checkMcpOrigin("https://inspector.example", env).ok).toBe(false);
  });

  it("개발 모드는 localhost·127.0.0.1(아무 포트)도 허용", () => {
    expect(checkMcpOrigin("http://localhost:6274", {}).ok).toBe(true);
    expect(checkMcpOrigin("http://127.0.0.1:3000", {}).ok).toBe(true);
    expect(checkMcpOrigin("https://evil.example", {}).ok).toBe(false);
  });

  it("APP_ENV를 PRODUCTION으로 두지 않은 배포(NODE_ENV=production)는 localhost를 허용하지 않는다", () => {
    expect(checkMcpOrigin("http://localhost:6274", { NODE_ENV: "production" })).toEqual({ ok: false });
    expect(checkMcpOrigin("http://localhost:6274", { NODE_ENV: "production", MCP_ALLOWED_ORIGINS: "http://localhost:6274" }).ok).toBe(true);
  });

  it("CORS 헤더는 허용한 origin 하나만, 와일드카드·자격 증명 없음", () => {
    expect(mcpCorsHeaders(null)).toEqual({});
    const h = mcpCorsHeaders("https://claude.ai");
    expect(h["Access-Control-Allow-Origin"]).toBe("https://claude.ai");
    expect(Object.keys(h)).not.toContain("Access-Control-Allow-Credentials");
  });
});
