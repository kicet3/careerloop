/**
 * MCP 연결(외부 AI 앱에서 경험 그래프 읽기) 계약 — 클라이언트·서버 공용. 서버 구현은 src/lib/mcp/*, 설계·운영은 docs/MCP.md.
 * 토큰 원문 형식: "clp_" + 32바이트 난수(base64url, 43자). DB에는 SHA-256 해시만 둔다.
 */
import { z } from "zod";

export const MCP_TOKEN_PREFIX = "clp_";
/** 목록에 보여 줄 원문 앞부분 길이("clp_" + 8자). */
export const MCP_TOKEN_DISPLAY_PREFIX_LEN = 12;
/** 이보다 긴 Bearer 값은 DB를 보기 전에 거절한다. */
export const MCP_TOKEN_MAX_LEN = 200;
/** 사용자당 활성(폐기·만료 전) 토큰 상한. */
export const MAX_ACTIVE_MCP_TOKENS = 10;
/** 폐기한 토큰을 목록에 남겨 두는 기간. */
export const REVOKED_TOKEN_VISIBLE_DAYS = 30;

export const MCP_SCOPES = ["graph:read"] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
export const MCP_DEFAULT_SCOPES: readonly McpScope[] = ["graph:read"];

/** 만료 선택지(일). null = 만료 없음. */
export const MCP_TOKEN_EXPIRY_OPTIONS = [30, 90, 365, null] as const;
export type McpTokenExpiry = (typeof MCP_TOKEN_EXPIRY_OPTIONS)[number];
export const DEFAULT_MCP_TOKEN_EXPIRY: McpTokenExpiry = 90;
export const MCP_TOKEN_EXPIRY_LABELS: Record<string, string> = {
  "30": "30일",
  "90": "90일",
  "365": "1년",
  none: "만료 없음",
};

export const DEFAULT_MCP_TOKEN_NAME = "Claude";
export const MAX_MCP_TOKEN_NAME = 40;

export const CreateMcpTokenSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "이름을 입력해 주세요.")
    .max(MAX_MCP_TOKEN_NAME, `이름은 ${MAX_MCP_TOKEN_NAME}자까지 쓸 수 있습니다.`),
  expiresInDays: z.union([z.literal(30), z.literal(90), z.literal(365), z.null()]),
});
export type CreateMcpTokenInput = z.infer<typeof CreateMcpTokenSchema>;

export type McpTokenStatus = "active" | "expired" | "revoked";

/** 토큰 목록 한 줄(원문·해시 없음). 시각은 epoch ms. */
export interface McpTokenView {
  id: string;
  name: string;
  /** 원문 앞 12자. 화면에는 `${prefix}…`로 보인다. */
  prefix: string;
  scopes: string[];
  createdAt: number;
  lastUsedAt: number | null;
  expiresAt: number | null;
  revokedAt: number | null;
  status: McpTokenStatus;
}

export function mcpTokenStatus(t: { expiresAt: number | null; revokedAt: number | null }, now: number = Date.now()): McpTokenStatus {
  if (t.revokedAt !== null) return "revoked";
  if (t.expiresAt !== null && t.expiresAt <= now) return "expired";
  return "active";
}

export const MCP_TOKEN_STATUS_LABELS: Record<McpTokenStatus, string> = { active: "활성", expired: "만료", revoked: "폐기됨" };

/** POST /api/mcp-tokens 응답: 원문(이번 한 번만)과 목록 한 줄. */
export interface CreatedMcpToken {
  token: string;
  view: McpTokenView;
}

export const MCP_SERVER_NAME = "careerloop";

export interface McpClientSnippet {
  id: "claude-code" | "cursor" | "claude-desktop" | "claude-ai";
  title: string;
  /** 붙여 넣을 내용. null이면 아직 지원하지 않는다(note만 보인다). */
  code: string | null;
  language: "shell" | "json" | null;
  note: string;
}

/** 클라이언트별 설정 예시. token이 없으면 자리 표시자 "<토큰>"을 넣는다. */
export function buildClientSnippets(endpoint: string, token?: string | null): McpClientSnippet[] {
  const t = token || "<토큰>";
  const json = (v: unknown) => JSON.stringify(v, null, 2);
  return [
    {
      id: "claude-code",
      title: "Claude Code",
      code: `claude mcp add --transport http ${MCP_SERVER_NAME} ${endpoint} --header "Authorization: Bearer ${t}"`,
      language: "shell",
      note: "터미널에서 실행합니다. 모든 프로젝트에서 쓰려면 --scope user를 붙이세요.",
    },
    {
      id: "cursor",
      title: "Cursor",
      code: json({ mcpServers: { [MCP_SERVER_NAME]: { url: endpoint, headers: { Authorization: `Bearer ${t}` } } } }),
      language: "json",
      note: "~/.cursor/mcp.json(또는 프로젝트의 .cursor/mcp.json)에 넣습니다.",
    },
    {
      id: "claude-desktop",
      title: "Claude Desktop",
      code: json({
        mcpServers: {
          [MCP_SERVER_NAME]: {
            command: "npx",
            args: ["-y", "mcp-remote", endpoint, "--header", "Authorization:${CAREERLOOP_AUTH}"],
            env: { CAREERLOOP_AUTH: `Bearer ${t}` },
          },
        },
      }),
      language: "json",
      note: "설정 > 개발자 > 설정 편집에서 claude_desktop_config.json에 넣습니다(Node.js 필요, mcp-remote로 연결).",
    },
    {
      id: "claude-ai",
      title: "claude.ai 커스텀 커넥터",
      code: null,
      language: null,
      note: "준비 중입니다(OAuth 연결이 필요합니다).",
    },
  ];
}
