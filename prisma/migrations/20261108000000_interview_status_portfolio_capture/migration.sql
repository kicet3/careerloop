-- 면접 연습(interview_sessions·questions·answers), 이력서 지원 상태·첨부 포트폴리오(company_resumes),
-- 공고 원문 캡처(shared_postings).
-- 기존 지원처별 이력서는 '지원 전'(draft)으로, 이미 지원서를 낸 지원 기록(applied 이후 단계)이 연결된 이력서는 '지원 완료'로 채운다.
-- 공용 이력서(kind='general')는 상태가 없다(null). 기존 공용 공고의 캡처 상태는 null(요청한 적 없음).

-- AlterTable
ALTER TABLE "company_resumes" ADD COLUMN     "apply_status" TEXT,
ADD COLUMN     "apply_status_changed_at" TIMESTAMPTZ(3),
ADD COLUMN     "portfolio_chars" INTEGER,
ADD COLUMN     "portfolio_file_name" TEXT,
ADD COLUMN     "portfolio_kind" TEXT,
ADD COLUMN     "portfolio_text_key" TEXT,
ADD COLUMN     "portfolio_updated_at" TIMESTAMPTZ(3),
ADD COLUMN     "portfolio_url" TEXT,
ADD COLUMN     "submitted_application_id" TEXT;

-- AlterTable
ALTER TABLE "shared_postings" ADD COLUMN     "capture_attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "capture_bytes" INTEGER,
ADD COLUMN     "capture_error" TEXT,
ADD COLUMN     "capture_height" INTEGER,
ADD COLUMN     "capture_key" TEXT,
ADD COLUMN     "capture_mime" TEXT,
ADD COLUMN     "capture_started_at" TIMESTAMPTZ(3),
ADD COLUMN     "capture_status" TEXT,
ADD COLUMN     "capture_width" INTEGER,
ADD COLUMN     "captured_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "interview_sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "resume_id" TEXT,
    "resume_version_id" TEXT,
    "posting_id" TEXT,
    "title" TEXT NOT NULL,
    "resume_label" TEXT NOT NULL,
    "target_label" TEXT,
    "has_portfolio" BOOLEAN NOT NULL DEFAULT false,
    "has_posting" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'generating',
    "error" TEXT,
    "run_id" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "source_key" TEXT,
    "question_count" INTEGER NOT NULL DEFAULT 0,
    "answered_count" INTEGER NOT NULL DEFAULT 0,
    "usage" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "generated_at" TIMESTAMPTZ(3),

    CONSTRAINT "interview_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_questions" (
    "id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "ord" INTEGER NOT NULL,
    "category" TEXT NOT NULL,
    "facet" TEXT,
    "question" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "citations" JSONB NOT NULL,
    "follow_ups" JSONB NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'new',
    "starred" BOOLEAN NOT NULL DEFAULT false,
    "attempt_count" INTEGER NOT NULL DEFAULT 0,
    "best_score" INTEGER,
    "last_answered_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "interview_questions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "interview_answers" (
    "id" TEXT NOT NULL,
    "question_id" TEXT NOT NULL,
    "session_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "duration_sec" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "feedback" JSONB,
    "score" INTEGER,
    "error" TEXT,
    "provider" TEXT,
    "model" TEXT,
    "usage" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "interview_answers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "interview_sessions_user_idx" ON "interview_sessions"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "interview_sessions_resume_idx" ON "interview_sessions"("resume_id");

-- CreateIndex
CREATE UNIQUE INDEX "interview_questions_ord_uq" ON "interview_questions"("session_id", "ord");

-- CreateIndex
CREATE INDEX "interview_answers_question_idx" ON "interview_answers"("question_id", "created_at");

-- CreateIndex
CREATE INDEX "interview_answers_session_idx" ON "interview_answers"("session_id", "created_at");

-- CreateIndex
CREATE INDEX "interview_answers_user_idx" ON "interview_answers"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "company_resumes_user_status_idx" ON "company_resumes"("user_id", "apply_status", "updated_at");

-- AddForeignKey
ALTER TABLE "company_resumes" ADD CONSTRAINT "company_resumes_submitted_application_id_fkey" FOREIGN KEY ("submitted_application_id") REFERENCES "applications"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_sessions" ADD CONSTRAINT "interview_sessions_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_questions" ADD CONSTRAINT "interview_questions_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_question_id_fkey" FOREIGN KEY ("question_id") REFERENCES "interview_questions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "interview_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "interview_answers" ADD CONSTRAINT "interview_answers_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Backfill: 지원처별 이력서 상태
UPDATE "company_resumes" SET "apply_status" = 'draft' WHERE "kind" = 'company';

UPDATE "company_resumes" AS r
SET "apply_status" = 'submitted',
    "submitted_application_id" = a."id",
    "apply_status_changed_at" = a."updated_at"
FROM (
    SELECT DISTINCT ON ("resume_id") "id", "resume_id", "updated_at"
    FROM "applications"
    WHERE "resume_id" IS NOT NULL AND "stage" IN ('applied', 'assignment', 'interview', 'offer', 'rejected')
    ORDER BY "resume_id", "updated_at" DESC, "id" DESC
) AS a
WHERE r."id" = a."resume_id" AND r."kind" = 'company';

-- 새 테이블도 Supabase Data API에서 감춘다(정책 없음 = 전부 거부, 앱은 소유자 역할이라 우회).
ALTER TABLE "interview_sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_questions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "interview_answers" ENABLE ROW LEVEL SECURITY;
