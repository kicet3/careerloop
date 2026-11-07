-- 포트폴리오 공개 링크(src/lib/portfolios/shares.ts): 소유자가 고른 포트폴리오의 공개본(snapshot)을 /p/<token>으로 로그인 없이 보여 준다.
-- 공개 화면·원본·챗봇은 이 행의 공개본만 읽는다. 포트폴리오당 공개 중(revoked_at IS NULL)인 행은 하나(부분 유니크 인덱스).
-- 공개를 끄면 revoked_at을 채우고 공개본 내용을 비운다. 포트폴리오를 지우거나 탈퇴하면 함께 지워진다(CASCADE).

-- CreateTable
CREATE TABLE "portfolio_shares" (
    "id" TEXT NOT NULL,
    "portfolio_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "token" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "content" TEXT NOT NULL DEFAULT '',
    "url" TEXT,
    "owner_name" TEXT,
    "original_key" TEXT,
    "original_mime" TEXT,
    "original_size" INTEGER,
    "content_hash" TEXT NOT NULL,
    "published_at" TIMESTAMPTZ(3) NOT NULL,
    "show_name" BOOLEAN NOT NULL DEFAULT false,
    "include_original" BOOLEAN NOT NULL DEFAULT false,
    "allow_chat" BOOLEAN NOT NULL DEFAULT true,
    "indexable" BOOLEAN NOT NULL DEFAULT false,
    "revoked_at" TIMESTAMPTZ(3),
    "view_count" INTEGER NOT NULL DEFAULT 0,
    "chat_count" INTEGER NOT NULL DEFAULT 0,
    "chat_blocked_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolio_shares_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "portfolio_shares_token_unique" ON "portfolio_shares"("token");

-- CreateIndex
CREATE INDEX "portfolio_shares_portfolio_idx" ON "portfolio_shares"("portfolio_id");

-- CreateIndex
CREATE INDEX "portfolio_shares_user_idx" ON "portfolio_shares"("user_id");

-- 포트폴리오당 공개 중인 링크는 하나(Prisma 스키마로 나타낼 수 없는 부분 유니크 인덱스).
CREATE UNIQUE INDEX "portfolio_shares_active_uq" ON "portfolio_shares"("portfolio_id") WHERE "revoked_at" IS NULL;

-- AddForeignKey
ALTER TABLE "portfolio_shares" ADD CONSTRAINT "portfolio_shares_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_shares" ADD CONSTRAINT "portfolio_shares_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase Data API(anon/authenticated 키)로 읽고 쓰지 못하게 RLS를 켠다(정책 없음 = 전부 거부, 앱은 소유자 역할로 우회) — 기존 테이블과 같은 정책.
ALTER TABLE "portfolio_shares" ENABLE ROW LEVEL SECURITY;
