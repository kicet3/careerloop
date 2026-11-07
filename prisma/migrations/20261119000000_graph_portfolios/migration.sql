-- 경험 그래프로 만드는 포트폴리오(portfolios.kind = 'graph')와 그 생성 작업(portfolio_draft_jobs).
-- 'graph' 포트폴리오의 본문(Markdown)은 'file'과 같이 저장소(text_key)에 두고, 생성 정보(고른 프로젝트 id·공고 id·메모·채울 정보)는 graph_source에 둔다.
-- 작업 흐름은 resume_draft_jobs와 같다 — src/lib/portfolios/graph-jobs.ts. 탈퇴하면 CASCADE, 포트폴리오를 지우면 portfolio_id는 null.

-- AlterTable
ALTER TABLE "portfolios" ADD COLUMN "graph_source" JSONB;

-- CreateTable
CREATE TABLE "portfolio_draft_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT 'material',
    "label" TEXT NOT NULL,
    "input" JSONB,
    "provider" TEXT,
    "error" TEXT,
    "portfolio_id" TEXT,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "portfolio_draft_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portfolio_draft_jobs_user_idx" ON "portfolio_draft_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "portfolio_draft_jobs_portfolio_idx" ON "portfolio_draft_jobs"("portfolio_id");

-- AddForeignKey
ALTER TABLE "portfolio_draft_jobs" ADD CONSTRAINT "portfolio_draft_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "portfolio_draft_jobs" ADD CONSTRAINT "portfolio_draft_jobs_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Supabase Data API(anon·authenticated 역할)에서 감춘다 — 앱은 서버의 Prisma 연결로만 읽고 쓴다.
ALTER TABLE "portfolio_draft_jobs" ENABLE ROW LEVEL SECURITY;
