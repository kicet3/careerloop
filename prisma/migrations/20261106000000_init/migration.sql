-- CareerLoop 기준(baseline) 마이그레이션: 예전 SQLite(Drizzle 0000~0006) 스키마를 PostgreSQL로 새로 만든다(데이터 이전 없음).
-- 테이블 부분은 `prisma migrate diff --from-empty --to-schema prisma/schema.prisma --script`로 생성했다.

-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateTable
CREATE TABLE "users" (
    "id" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT,
    "password_hash" TEXT,
    "google_sub" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "job_postings" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role_title" TEXT NOT NULL,
    "url" TEXT,
    "url_key" TEXT,
    "platform" TEXT,
    "status" TEXT NOT NULL DEFAULT 'saved',
    "jd_text" TEXT,
    "deadline" TEXT,
    "deadline_time" TEXT,
    "deadline_kind" TEXT NOT NULL DEFAULT 'unspecified',
    "employment_type" TEXT NOT NULL DEFAULT 'unknown',
    "work_type" TEXT NOT NULL DEFAULT 'unknown',
    "location" TEXT,
    "career_level" TEXT NOT NULL DEFAULT 'unknown',
    "note" TEXT,
    "extracted_by" TEXT NOT NULL DEFAULT 'manual',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "job_postings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "posting_imports" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "posting_id" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "posting_imports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnoses" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "target_role" TEXT NOT NULL,
    "situation" TEXT NOT NULL,
    "notes" TEXT,
    "jd_text" TEXT,
    "resume_text" TEXT NOT NULL,
    "resume_file_name" TEXT,
    "portfolio_text" TEXT,
    "portfolio_file_name" TEXT,
    "posting_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'queued',
    "error" TEXT,
    "share_token" TEXT,
    "model" TEXT NOT NULL,
    "provider" TEXT,
    "run_id" TEXT,
    "usage" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "diagnoses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_stages" (
    "id" SERIAL NOT NULL,
    "diagnosis_id" TEXT NOT NULL,
    "stage" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "output" JSONB,
    "error" TEXT,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "diagnosis_stages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "diagnosis_runs" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "diagnosis_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "diagnosis_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_threads" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "diagnosis_id" TEXT,
    "reviewer" TEXT,
    "title" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_threads_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "chat_messages" (
    "id" TEXT NOT NULL,
    "thread_id" TEXT NOT NULL,
    "role" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "data" JSONB,
    "status" TEXT,
    "usage" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chat_messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "company_resumes" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "company" TEXT NOT NULL,
    "role_title" TEXT NOT NULL,
    "jd_text" TEXT,
    "posting_id" TEXT,
    "template_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "current_version_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "company_resumes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_versions" (
    "id" TEXT NOT NULL,
    "resume_id" TEXT NOT NULL,
    "version_no" INTEGER NOT NULL,
    "storage_key" TEXT NOT NULL,
    "note" TEXT,
    "source" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "applications" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "posting_id" TEXT,
    "company" TEXT NOT NULL,
    "role_title" TEXT NOT NULL,
    "stage" TEXT NOT NULL DEFAULT 'applied',
    "applied_at" TEXT,
    "next_step" TEXT,
    "next_date" TEXT,
    "note" TEXT,
    "favorite" BOOLEAN NOT NULL DEFAULT false,
    "resume_id" TEXT,
    "resume_version_id" TEXT,
    "resume_label" TEXT,
    "submitted_key" TEXT,
    "diagnosis_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "applications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "application_events" (
    "id" SERIAL NOT NULL,
    "application_id" TEXT NOT NULL,
    "from_stage" TEXT,
    "to_stage" TEXT NOT NULL,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "application_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rate_events" (
    "id" SERIAL NOT NULL,
    "bucket" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rate_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_email_unique" ON "users"("email");

-- CreateIndex
CREATE UNIQUE INDEX "users_google_sub_unique" ON "users"("google_sub");

-- CreateIndex
CREATE INDEX "sessions_user_idx" ON "sessions"("user_id");

-- CreateIndex
CREATE INDEX "job_postings_user_idx" ON "job_postings"("user_id", "updated_at");

-- CreateIndex
CREATE UNIQUE INDEX "job_postings_url_uq" ON "job_postings"("user_id", "url_key");

-- CreateIndex
CREATE INDEX "posting_imports_user_idx" ON "posting_imports"("user_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "diagnoses_share_token_unique" ON "diagnoses"("share_token");

-- CreateIndex
CREATE INDEX "diagnoses_user_idx" ON "diagnoses"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "diagnoses_posting_idx" ON "diagnoses"("posting_id");

-- CreateIndex
CREATE UNIQUE INDEX "diagnosis_stage_uq" ON "diagnosis_stages"("diagnosis_id", "stage");

-- CreateIndex
CREATE INDEX "diagnosis_runs_user_idx" ON "diagnosis_runs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "diagnosis_runs_diag_idx" ON "diagnosis_runs"("diagnosis_id");

-- CreateIndex
CREATE INDEX "chat_threads_user_idx" ON "chat_threads"("user_id", "kind", "updated_at");

-- CreateIndex
CREATE INDEX "chat_threads_diag_idx" ON "chat_threads"("diagnosis_id", "reviewer");

-- CreateIndex
CREATE INDEX "chat_messages_thread_idx" ON "chat_messages"("thread_id", "created_at");

-- CreateIndex
CREATE INDEX "company_resumes_user_idx" ON "company_resumes"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "company_resumes_posting_idx" ON "company_resumes"("posting_id");

-- CreateIndex
CREATE UNIQUE INDEX "resume_versions_no_uq" ON "resume_versions"("resume_id", "version_no");

-- CreateIndex
CREATE INDEX "applications_user_idx" ON "applications"("user_id", "updated_at");

-- CreateIndex
CREATE INDEX "applications_posting_idx" ON "applications"("posting_id");

-- CreateIndex
CREATE INDEX "application_events_app_idx" ON "application_events"("application_id", "at");

-- CreateIndex
CREATE INDEX "rate_events_key_idx" ON "rate_events"("bucket", "key", "created_at");

-- AddForeignKey
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_imports" ADD CONSTRAINT "posting_imports_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_imports" ADD CONSTRAINT "posting_imports_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnoses" ADD CONSTRAINT "diagnoses_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_stages" ADD CONSTRAINT "diagnosis_stages_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnoses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "diagnosis_runs" ADD CONSTRAINT "diagnosis_runs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnoses"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_resumes" ADD CONSTRAINT "company_resumes_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_resumes" ADD CONSTRAINT "company_resumes_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_versions" ADD CONSTRAINT "resume_versions_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_posting_id_fkey" FOREIGN KEY ("posting_id") REFERENCES "job_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "applications" ADD CONSTRAINT "applications_diagnosis_id_fkey" FOREIGN KEY ("diagnosis_id") REFERENCES "diagnoses"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "application_events" ADD CONSTRAINT "application_events_application_id_fkey" FOREIGN KEY ("application_id") REFERENCES "applications"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Supabase Data API(PostgREST, anon/authenticated 키)로 테이블을 읽고 쓰지 못하게 모든 테이블에 RLS를 켠다(정책 없음 = 전부 거부).
-- 앱은 테이블 소유자(postgres) 역할로 접속하므로 RLS를 우회한다.
ALTER TABLE "users" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "sessions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "job_postings" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "posting_imports" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diagnoses" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diagnosis_stages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "diagnosis_runs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_threads" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "chat_messages" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "company_resumes" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_versions" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "applications" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "application_events" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "rate_events" ENABLE ROW LEVEL SECURITY;
-- prisma migrate가 만드는 이력 테이블도 Data API에서 감춘다(PGlite 테스트처럼 이 테이블이 없는 곳에서는 건너뛴다).
DO $$
BEGIN
  IF to_regclass('public._prisma_migrations') IS NOT NULL THEN
    ALTER TABLE "_prisma_migrations" ENABLE ROW LEVEL SECURITY;
  END IF;
END $$;
