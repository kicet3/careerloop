import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { McpTokens } from "@/components/mcp/McpTokens";
import { Alert } from "@/components/ui/Alert";
import { requireUser } from "@/lib/auth/session";
import { appUrl } from "@/lib/config/env";
import { graphEnabled } from "@/lib/graph/service";
import { listMcpTokens } from "@/lib/mcp/tokens";

export const metadata: Metadata = { title: "MCP 연결" };
export const dynamic = "force-dynamic";

/** MCP 엔드포인트 주소: 앱 주소(APP_URL·Vercel 배포 주소), 없으면(로컬 개발) 이 요청의 호스트. */
async function mcpEndpoint(): Promise<string> {
  const base = appUrl();
  if (base) return `${base.replace(/\/+$/, "")}/api/mcp`;
  const h = await headers();
  const host = h.get("x-forwarded-host")?.split(",")[0]?.trim() || h.get("host") || "localhost:3000";
  const proto = h.get("x-forwarded-proto")?.split(",")[0]?.trim() || (host.startsWith("localhost") || host.startsWith("127.") ? "http" : "https");
  return `${proto}://${host}/api/mcp`;
}

export default async function McpPage() {
  const user = await requireUser("/app/mcp");
  const [tokens, endpoint] = await Promise.all([listMcpTokens(user.id), mcpEndpoint()]);
  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">MCP 연결</h1>
        <p className="mt-1 max-w-prose text-sm text-slate-500">
          Claude Code·Cursor·Claude Desktop 같은 외부 AI 앱이 MCP(Model Context Protocol)로 내{" "}
          <Link href="/app/graph" className="text-indigo-700 underline underline-offset-2">
            경험 그래프
          </Link>
          를 읽게 합니다. 읽기 전용이라 앱이 그래프를 바꾸지는 못합니다. 앱에 넣은 토큰을 폐기하면 바로 연결이 끊깁니다.
        </p>
        <p className="mt-2 max-w-prose text-xs text-slate-500">
          연결한 앱에는 회원님이 요청할 때마다 경험 그래프 내용(노드·관계·이름)이 전달되고, 그 뒤 처리는 그 앱의 정책을 따릅니다. 이메일 등
          계정 정보와 진단·이력서·공고는 전달하지 않습니다.
        </p>
      </div>
      {!graphEnabled() && (
        <Alert tone="warning" title="경험 그래프 저장소가 설정되지 않았습니다">
          이 서버에는 Neo4j 연결 정보가 없어 토큰을 만들어도 도구가 그래프를 읽지 못합니다(연결·도구 목록은 됩니다).
        </Alert>
      )}
      <McpTokens initial={tokens} endpoint={endpoint} />
    </div>
  );
}
