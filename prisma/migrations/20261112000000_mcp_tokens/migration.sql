-- MCP(외부 AI 앱) 접근 토큰(mcp_tokens): 경험 그래프를 MCP로 읽는 개인 토큰. 원문은 저장하지 않고 SHA-256 해시만 둔다.
-- kind는 'pat'(개인 토큰). 'oauth'와 client_id는 OAuth 연결(2단계)용 자리다 — docs/MCP.md.
-- 탈퇴하면 그 사용자의 토큰도 지워진다(ON DELETE CASCADE).

-- CreateTable
CREATE TABLE "mcp_tokens" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "token_hash" TEXT NOT NULL,
    "prefix" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'pat',
    "client_id" TEXT,
    "scopes" TEXT[] DEFAULT ARRAY['graph:read']::TEXT[],
    "expires_at" TIMESTAMPTZ(3),
    "last_used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "mcp_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "mcp_tokens_token_hash_unique" ON "mcp_tokens"("token_hash");

-- CreateIndex
CREATE INDEX "mcp_tokens_user_idx" ON "mcp_tokens"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "mcp_tokens" ADD CONSTRAINT "mcp_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Supabase Data API(anon·authenticated 역할)에서 감춘다 — 앱은 서버의 Prisma 연결로만 읽고 쓴다.
ALTER TABLE "mcp_tokens" ENABLE ROW LEVEL SECURITY;
