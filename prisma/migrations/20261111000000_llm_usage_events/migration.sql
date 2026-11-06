-- LLM 토큰 사용량 원장(llm_usage_events): AI 호출 1건당 1행. 프롬프트·응답 본문은 저장하지 않는다.
-- 비용은 USD 백만분의 1 단위 정수(cost_micro_usd), 가격을 모르는 모델·CLI 엔진은 NULL.
-- 탈퇴하면 그 사용자의 행도 지워진다(ON DELETE CASCADE).

-- CreateTable
CREATE TABLE "llm_usage_events" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT,
    "task" TEXT NOT NULL,
    "stage" TEXT,
    "provider" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "input_tokens" INTEGER NOT NULL DEFAULT 0,
    "output_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_read_tokens" INTEGER NOT NULL DEFAULT 0,
    "cache_write_tokens" INTEGER NOT NULL DEFAULT 0,
    "cost_micro_usd" BIGINT,
    "ok" BOOLEAN NOT NULL,
    "error_reason" TEXT,
    "reference_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "llm_usage_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "llm_usage_events_user_idx" ON "llm_usage_events"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "llm_usage_events_created_idx" ON "llm_usage_events"("created_at");

-- AddForeignKey
ALTER TABLE "llm_usage_events" ADD CONSTRAINT "llm_usage_events_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase Data API(anon·authenticated 역할)에서 감춘다 — 앱은 서버의 Prisma 연결로만 읽고 쓴다.
ALTER TABLE "llm_usage_events" ENABLE ROW LEVEL SECURITY;
