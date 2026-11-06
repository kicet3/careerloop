-- AI 이력서 초안 작업(resume_draft_jobs)과 앱 안 알림(notifications).
-- 새 이력서 '초안 만들기'는 작업 행만 만들고 응답한 뒤 after()에서 초안을 쓴다(진행 화면이 폴링) — src/lib/resumes/draft-jobs.ts.
-- 오래 걸리는 백그라운드 작업이 끝나면 notifications 행을 만든다(상단 알림 버튼이 폴링) — src/lib/notifications/service.ts.
-- 둘 다 탈퇴하면 users와 함께 지워진다(ON DELETE CASCADE). 초안 작업이 만든 이력서를 지우면 resume_id는 null이 된다.

-- CreateTable
CREATE TABLE "resume_draft_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "stage" TEXT NOT NULL DEFAULT 'material',
    "label" TEXT NOT NULL,
    "input" JSONB,
    "provider" TEXT,
    "error" TEXT,
    "resume_id" TEXT,
    "result" JSONB,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "resume_draft_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL DEFAULT '',
    "link" TEXT,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resume_draft_jobs_user_idx" ON "resume_draft_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "resume_draft_jobs_resume_idx" ON "resume_draft_jobs"("resume_id");

-- CreateIndex
CREATE INDEX "notifications_user_idx" ON "notifications"("user_id", "created_at");

-- AddForeignKey
ALTER TABLE "resume_draft_jobs" ADD CONSTRAINT "resume_draft_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_draft_jobs" ADD CONSTRAINT "resume_draft_jobs_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Supabase Data API(anon·authenticated 역할)에서 감춘다 — 앱은 서버의 Prisma 연결로만 읽고 쓴다.
ALTER TABLE "resume_draft_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "notifications" ENABLE ROW LEVEL SECURITY;
