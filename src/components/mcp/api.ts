/** MCP 토큰 API 브라우저 호출 도우미(GET·POST /api/mcp-tokens, DELETE /api/mcp-tokens/[id]). */
import type { CreatedMcpToken, CreateMcpTokenInput, McpTokenView } from "@/lib/domain/mcp";

export class McpTokenApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "McpTokenApiError";
  }
}

async function readError(res: Response): Promise<McpTokenApiError> {
  const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
  return new McpTokenApiError(typeof body?.error === "string" ? body.error : `요청이 실패했습니다 (${res.status}).`, res.status);
}

export async function fetchMcpTokens(): Promise<McpTokenView[]> {
  const res = await fetch("/api/mcp-tokens", { cache: "no-store" });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { items: McpTokenView[] }).items;
}

export async function createMcpTokenRequest(input: CreateMcpTokenInput): Promise<CreatedMcpToken> {
  const res = await fetch("/api/mcp-tokens", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  if (!res.ok) throw await readError(res);
  return (await res.json()) as CreatedMcpToken;
}

export async function revokeMcpTokenRequest(id: string): Promise<McpTokenView> {
  const res = await fetch(`/api/mcp-tokens/${encodeURIComponent(id)}`, { method: "DELETE" });
  if (!res.ok) throw await readError(res);
  return ((await res.json()) as { view: McpTokenView }).view;
}
