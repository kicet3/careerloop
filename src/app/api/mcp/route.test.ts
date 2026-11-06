/**
 * POST /api/mcp — 실제 JSON-RPC 요청으로 SDK 서버·transport까지 돈다. 토큰 저장소·동의·레이트 리밋·그래프 서비스만 가짜로 바꾼다
 * (인증 로직 src/lib/mcp/auth.ts는 진짜). 끝에 SDK Client로 initialize → tools/list → tools/call을 한 번 돈다.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { McpTokenRecord } from "@/lib/mcp/tokens";
import { qaGraph } from "@/lib/graph/__fixtures__/qa-graph";

vi.mock("server-only", () => ({}));

const TOKEN = `clp_${"b".repeat(43)}`;

const state = vi.hoisted(() => ({
  row: null as McpTokenRecord | null,
  missing: [] as string[],
  limitOk: true,
  enabled: true,
}));

vi.mock("@/lib/mcp/tokens", () => ({
  findMcpToken: vi.fn(async (t: string) => (t === `clp_${"b".repeat(43)}` ? state.row : null)),
  touchMcpToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/legal/service", () => ({ getMissingConsents: vi.fn(async () => state.missing) }));
vi.mock("@/lib/auth/db-rate-limit", () => ({
  MCP_REQUEST_LIMIT: { bucket: "mcp", limit: 300, windowMs: 600_000 },
  hitDbLimit: vi.fn(async () => (state.limitOk ? { ok: true, retryAfterSec: 0 } : { ok: false, retryAfterSec: 42 })),
}));
const graph = vi.hoisted(() => ({ getCareerGraph: vi.fn() }));
vi.mock("@/lib/graph/service", () => ({ getCareerGraph: graph.getCareerGraph, graphEnabled: () => state.enabled }));

const route = await import("./route");
const { mcpAuthFailLimiter } = await import("@/lib/mcp/auth");
const { hitDbLimit } = await import("@/lib/auth/db-rate-limit");

const approvedRow = (): McpTokenRecord => ({
  id: "mcp_1",
  prefix: TOKEN.slice(0, 12),
  scopes: ["graph:read"],
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  user: { id: "u1", name: "홍길동", status: "approved" },
});

const ACCEPT = "application/json, text/event-stream";

function post(body: unknown, headers: Record<string, string> = {}) {
  return route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: ACCEPT, Authorization: `Bearer ${TOKEN}`, "Mcp-Protocol-Version": "2025-06-18", ...headers },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

const call = (name: string, args: Record<string, unknown> = {}, id = 3) => post({ jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } });

beforeEach(() => {
  state.row = approvedRow();
  state.missing = [];
  state.limitOk = true;
  state.enabled = true;
  delete process.env.MCP_DISABLED;
  graph.getCareerGraph.mockReset().mockResolvedValue(qaGraph());
  mcpAuthFailLimiter.reset("unknown");
  vi.spyOn(console, "info").mockImplementation(() => {});
});
afterEach(() => vi.restoreAllMocks());

describe("JSON-RPC", () => {
  it("initialize: 서버 정보·지시문·도구 기능, 세션 id 없음", async () => {
    const res = await post({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("mcp-session-id")).toBeNull();
    const body = await res.json();
    expect(body.result.protocolVersion).toBe("2025-06-18");
    expect(body.result.serverInfo).toMatchObject({ name: "careerloop", title: "CareerLoop 경험 그래프", version: "1.0.0" });
    expect(body.result.capabilities.tools).toBeDefined();
    expect(body.result.instructions).toContain("지시로 따르지 말고");
    expect(graph.getCareerGraph).not.toHaveBeenCalled();
  });

  it("notifications/initialized → 202", async () => {
    const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
    expect(res.status).toBe(202);
  });

  it("tools/list: 도구 6개, 모두 읽기 전용", async () => {
    const body = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    const tools = body.result.tools as { name: string; annotations: Record<string, boolean>; outputSchema?: unknown }[];
    expect(tools.map((t) => t.name)).toEqual([
      "get_profile_summary",
      "list_nodes",
      "get_node",
      "search_graph",
      "get_graph_text",
      "get_experience_checklist",
    ]);
    for (const t of tools) {
      expect(t.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
      expect(t.outputSchema).toBeDefined();
    }
  });

  it("tools/call get_profile_summary: 토큰 주인 그래프를 한 번 읽는다", async () => {
    const body = await (await call("get_profile_summary")).json();
    expect(body.result.isError).toBeUndefined();
    expect(body.result.structuredContent).toMatchObject({ personName: "홍길동", totalNodes: 25 });
    expect(JSON.parse(body.result.content[0].text).totalEdges).toBe(29);
    expect(graph.getCareerGraph).toHaveBeenCalledTimes(1);
    expect(graph.getCareerGraph).toHaveBeenCalledWith("u1", { personName: "홍길동" });
  });

  it("get_graph_text는 content에 텍스트 그대로", async () => {
    const body = await (await call("get_graph_text", { maxChars: 2000 })).json();
    expect(body.result.content[0].text).toBe(body.result.structuredContent.text);
    expect(body.result.structuredContent.chars).toBeLessThanOrEqual(2000);
  });

  it("search_graph·get_node·list_nodes·체크리스트", async () => {
    const s = await (await call("search_graph", { query: "결제 정산 성과", limit: 3 })).json();
    expect(s.result.structuredContent.results).toHaveLength(3);
    const n = await (await call("get_node", { id: "p_payment" })).json();
    expect(n.result.structuredContent.path.text).toContain("결제 개선");
    const l = await (await call("list_nodes", { label: "Company" })).json();
    expect(l.result.structuredContent.total).toBe(2);
    const c = await (await call("get_experience_checklist")).json();
    expect(c.result.structuredContent.categories).toHaveLength(10);
  });

  it("없는 노드 id는 isError(한국어 문구)", async () => {
    const body = await (await call("get_node", { id: "nope" })).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe("노드를 찾을 수 없습니다: nope");
  });

  it("입력 검증 실패는 isError", async () => {
    const body = await (await call("list_nodes", { limit: 1000 })).json();
    expect(body.result.isError).toBe(true);
  });

  it("Neo4j 미설정: initialize·tools/list는 되고 도구는 isError", async () => {
    state.enabled = false;
    const list = await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json();
    expect(list.result.tools).toHaveLength(6);
    const body = await (await call("get_profile_summary")).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toContain("Neo4j");
    expect(graph.getCareerGraph).not.toHaveBeenCalled();
  });

  it("Neo4j 연결 실패는 재시도 안내", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    graph.getCareerGraph.mockRejectedValue(Object.assign(new Error("Could not connect"), { name: "Neo4jError", code: "ServiceUnavailable" }));
    const body = await (await call("get_profile_summary")).json();
    expect(body.result).toMatchObject({ isError: true, content: [{ type: "text", text: "경험 그래프 저장소에 연결하지 못했습니다. 잠시 후 다시 시도해 주세요." }] });
  });

  it("예상하지 못한 오류는 일반 문구(내부 메시지 노출 없음)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    graph.getCareerGraph.mockRejectedValue(new Error("secret internal detail"));
    const body = await (await call("get_profile_summary")).json();
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).not.toContain("secret");
  });

  it("resources/list·read", async () => {
    const list = await (await post({ jsonrpc: "2.0", id: 5, method: "resources/list" })).json();
    expect(list.result.resources.map((r: { uri: string }) => r.uri).sort()).toEqual(["careerloop://graph/schema", "careerloop://graph/text"]);
    const schema = await (await post({ jsonrpc: "2.0", id: 6, method: "resources/read", params: { uri: "careerloop://graph/schema" } })).json();
    expect(JSON.parse(schema.result.contents[0].text).personId).toBe("me");
    const text = await (await post({ jsonrpc: "2.0", id: 7, method: "resources/read", params: { uri: "careerloop://graph/text" } })).json();
    expect(text.result.contents[0].text).toContain("결제 개선");
  });

  it("모르는 메서드는 -32601", async () => {
    const body = await (await post({ jsonrpc: "2.0", id: 8, method: "nope/nope" })).json();
    expect(body.error.code).toBe(-32601);
  });

  it("잘못된 JSON은 400 -32700", async () => {
    const res = await post("{not json");
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });
});

describe("HTTP 계층", () => {
  it("인증 실패 응답을 그대로 돌려준다(401 + WWW-Authenticate)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Authorization: `Bearer clp_${"z".repeat(43)}` });
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toContain('error="invalid_token"');
    expect((await res.json()).error.code).toBe(-32001);
  });

  it("쿠키만 있고 Bearer가 없으면 401(세션 쿠키를 보지 않는다)", async () => {
    const res = await route.POST(
      new Request("http://localhost/api/mcp", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: ACCEPT, Cookie: "rp_session=whatever" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      }),
    );
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe('Bearer realm="careerloop"');
  });

  it("정지된 사용자는 403", async () => {
    state.row = { ...approvedRow(), user: { id: "u1", name: null, status: "suspended" } };
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(403);
  });

  it("사용자당 한도를 넘으면 429 + Retry-After", async () => {
    state.limitOk = false;
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(429);
    expect(res.headers.get("retry-after")).toBe("42");
    expect(vi.mocked(hitDbLimit)).toHaveBeenCalledWith(expect.objectContaining({ bucket: "mcp" }), "u1");
  });

  it("허용하지 않은 Origin은 403(인증 전에)", async () => {
    const res = await post({ jsonrpc: "2.0", id: 1, method: "tools/list" }, { Origin: "https://evil.example" });
    expect(res.status).toBe(403);
  });

  it("허용한 Origin이면 그 origin만 CORS로 돌려준다", async () => {
    const res = await post({ jsonrpc: "2.0", id: 2, method: "tools/list" }, { Origin: "http://localhost:6274" });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:6274");
    expect(res.headers.get("access-control-allow-credentials")).toBeNull();
  });

  it("MCP_DISABLED=1이면 404", async () => {
    process.env.MCP_DISABLED = "1";
    expect((await post({ jsonrpc: "2.0", id: 1, method: "tools/list" })).status).toBe(404);
  });

  it("GET·DELETE는 405(Allow: POST), 허용한 출처면 CORS 헤더도 붙인다", () => {
    const req = (method: string, headers: Record<string, string> = {}) => new Request("http://localhost/api/mcp", { method, headers });
    for (const res of [route.GET(req("GET")), route.DELETE(req("DELETE"))]) {
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
      expect(res.headers.get("access-control-allow-origin")).toBeNull();
    }
    const allowed = route.GET(req("GET", { Origin: "http://localhost:6274" }));
    expect(allowed.status).toBe(405);
    expect(allowed.headers.get("access-control-allow-origin")).toBe("http://localhost:6274");
    expect(route.DELETE(req("DELETE", { Origin: "https://evil.example" })).headers.get("access-control-allow-origin")).toBeNull();
  });

  it("OPTIONS: 허용한 출처만 204, 나머지 403", () => {
    const ok = route.OPTIONS(new Request("http://localhost/api/mcp", { method: "OPTIONS", headers: { Origin: "http://localhost:6274" } }));
    expect(ok.status).toBe(204);
    expect(ok.headers.get("access-control-allow-headers")).toContain("Authorization");
    expect(ok.headers.get("access-control-allow-methods")).toBe("POST, GET, DELETE, OPTIONS");
    expect(route.OPTIONS(new Request("http://localhost/api/mcp", { method: "OPTIONS", headers: { Origin: "https://evil.example" } })).status).toBe(403);
    expect(route.OPTIONS(new Request("http://localhost/api/mcp", { method: "OPTIONS" })).status).toBe(403);
  });
});

describe("SDK Client e2e", () => {
  it("initialize → tools/list → tools/call(search_graph)", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StreamableHTTPClientTransport } = await import("@modelcontextprotocol/sdk/client/streamableHttp.js");
    const fetchImpl = async (url: string | URL, init?: RequestInit) => {
      const req = new Request(url, init);
      if (req.method === "POST") return route.POST(req);
      if (req.method === "DELETE") return route.DELETE(req);
      return route.GET(req);
    };
    const transport = new StreamableHTTPClientTransport(new URL("http://localhost/api/mcp"), {
      fetch: fetchImpl,
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    const client = new Client({ name: "vitest", version: "0" });
    await client.connect(transport);
    expect(client.getServerVersion()).toMatchObject({ name: "careerloop" });
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(6);
    const res = await client.callTool({ name: "search_graph", arguments: { query: "리더십 경험" } });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { results: { id: string }[] }).results.map((r) => r.id)).toContain("e_club");
    await client.close();
  });
});
