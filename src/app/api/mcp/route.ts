/**
 * MCP 서버 엔드포인트(Streamable HTTP, 상태 없음·JSON 응답). 외부 AI 앱(Claude Code·Cursor·Claude Desktop)이 개인 토큰
 * (Authorization: Bearer clp_…)으로 토큰 주인의 경험 그래프를 읽는다. 쿠키 세션은 보지 않는다. 설계·운영은 docs/MCP.md.
 *
 * 순서: MCP_DISABLED → Origin 검사 → 토큰 인증(사용자 상태·동의를 요청마다 다시 본다) → 사용자당 레이트 리밋 → 본문 읽기
 * → 요청마다 새 McpServer·transport로 처리. 로그에는 사용자·토큰 앞부분·메서드·도구·상태·시간만 남긴다(토큰·인자·결과 없음).
 */
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { hitDbLimit, MCP_REQUEST_LIMIT } from "@/lib/auth/db-rate-limit";
import type { CareerGraph } from "@/lib/domain/graph";
import { getCareerGraph, graphEnabled } from "@/lib/graph/service";
import { authenticateMcpRequest, jsonRpcErrorBody } from "@/lib/mcp/auth";
import { checkMcpOrigin, MCP_CORS_PREFLIGHT_HEADERS, mcpCorsHeaders } from "@/lib/mcp/origin";
import { createCareerLoopMcpServer, type McpToolName } from "@/lib/mcp/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 30;

/** 요청 본문 상한(JSON-RPC 요청은 작다). */
const MAX_BODY_BYTES = 256 * 1024;

function withHeaders(res: Response, headers: Record<string, string>): Response {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(headers)) h.set(k, v);
  h.set("Cache-Control", "no-store");
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function rpcError(status: number, code: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json(jsonRpcErrorBody(code, message), { status, headers: { "Cache-Control": "no-store", ...headers } });
}

async function readBody(req: Request): Promise<{ text: string } | { tooLarge: true }> {
  if (Number(req.headers.get("content-length")) > MAX_BODY_BYTES) return { tooLarge: true };
  if (!req.body) return { text: "" };
  const reader = req.body.getReader();
  const decoder = new TextDecoder();
  let size = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      return { tooLarge: true };
    }
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode() };
}

/** 로그용: JSON-RPC 메서드와 tools/call의 도구 이름(인자는 보지 않는다). */
function describeRpc(body: unknown): { method: string; tool: string | null } {
  const one = (m: unknown) => {
    const o = m as { method?: unknown; params?: { name?: unknown } } | null;
    const method = typeof o?.method === "string" ? o.method.slice(0, 60) : "(response)";
    const tool = method === "tools/call" && typeof o?.params?.name === "string" ? o.params.name.slice(0, 60) : null;
    return { method, tool };
  };
  if (Array.isArray(body)) return { method: `batch(${body.length})`, tool: null };
  return one(body);
}

export async function POST(req: Request): Promise<Response> {
  const started = Date.now();
  if (process.env.MCP_DISABLED === "1") return new Response("Not Found", { status: 404, headers: { "Cache-Control": "no-store" } });

  const origin = checkMcpOrigin(req.headers.get("origin"));
  if (!origin.ok) return rpcError(403, -32000, "허용되지 않은 요청 출처입니다.");
  const cors = mcpCorsHeaders(origin.allowOrigin);

  const authed = await authenticateMcpRequest(req);
  if (!authed.ok) return withHeaders(authed.response, cors);
  const { user, token } = authed.auth;

  let method = "(unknown)";
  let tool: string | null = null;
  let toolStatus: "ok" | "error" | null = null;
  const log = (status: number) =>
    console.info(
      `[mcp] user=${user.id} token=${token.prefix} method=${method}${tool ? ` tool=${tool}` : ""}${toolStatus ? ` result=${toolStatus}` : ""} status=${status} ms=${Date.now() - started}`,
    );

  const limit = await hitDbLimit(MCP_REQUEST_LIMIT, user.id);
  if (!limit.ok) {
    log(429);
    return rpcError(429, -32000, "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.", { ...cors, "Retry-After": String(limit.retryAfterSec) });
  }

  const body = await readBody(req);
  if ("tooLarge" in body) {
    log(413);
    return rpcError(413, -32600, "요청 본문이 너무 큽니다.", cors);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    log(400);
    return rpcError(400, -32700, "Parse error: Invalid JSON", cors);
  }
  ({ method, tool } = describeRpc(parsed));

  let graphPromise: Promise<CareerGraph> | null = null;
  const server = createCareerLoopMcpServer({
    user,
    graphEnabled: graphEnabled(),
    loadGraph: () => (graphPromise ??= getCareerGraph(user.id, { personName: user.name })),
    onToolResult: (_t: McpToolName, status) => {
      toolStatus = status;
    },
  });
  const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
  try {
    await server.connect(transport);
    const res = await transport.handleRequest(req, { parsedBody: parsed });
    // JSON 응답 모드라 본문은 이미 다 만들어졌다 — 닫기 전에 읽어 두어 close가 본문을 끊지 않게 한다.
    const text = res.body ? await res.text() : null;
    log(res.status);
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    headers.set("Cache-Control", "no-store");
    return new Response(text, { status: res.status, headers });
  } catch (err) {
    console.error("[mcp] 요청 처리 실패", err);
    log(500);
    return rpcError(500, -32603, "서버 오류가 났습니다.", cors);
  } finally {
    await transport.close().catch(() => {});
    await server.close().catch(() => {});
  }
}

function methodNotAllowed(req: Request): Response {
  // 상태 없는 서버라 서버→클라이언트 SSE 스트림(GET)과 세션 종료(DELETE)를 지원하지 않는다.
  // 허용한 출처의 브라우저 클라이언트가 CORS 오류 대신 405를 읽도록 CORS 헤더를 붙인다.
  const origin = checkMcpOrigin(req.headers.get("origin"));
  const cors = origin.ok ? mcpCorsHeaders(origin.allowOrigin) : {};
  return new Response(JSON.stringify(jsonRpcErrorBody(-32000, "Method not allowed.")), {
    status: 405,
    headers: { ...cors, Allow: "POST", "Content-Type": "application/json", "Cache-Control": "no-store" },
  });
}

export function GET(req: Request): Response {
  return methodNotAllowed(req);
}

export function DELETE(req: Request): Response {
  return methodNotAllowed(req);
}

/** CORS 사전 요청: 허용한 출처(origin.ts)에만 답한다. */
export function OPTIONS(req: Request): Response {
  const originHeader = req.headers.get("origin");
  const origin = checkMcpOrigin(originHeader);
  if (!originHeader || !origin.ok || !origin.allowOrigin) return new Response(null, { status: 403, headers: { "Cache-Control": "no-store" } });
  return new Response(null, { status: 204, headers: { ...mcpCorsHeaders(origin.allowOrigin), ...MCP_CORS_PREFLIGHT_HEADERS } });
}
