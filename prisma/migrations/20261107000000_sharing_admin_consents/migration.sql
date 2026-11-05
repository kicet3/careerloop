-- 공용 공고(공고 찾기)·공용 이력서·회원 승인(관리자)·동의 기록.
-- 기존 회원은 이 마이그레이션으로 승인(approved) 상태가 된다. 새 가입은 기본값 pending(관리자 승인 대기).
-- 기존 URL 가져오기 공고는 공용 공고로 옮기지 않는다(가입 당시 공유를 알리지 않았으므로 앞으로 가져오는 것만 공유).

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "approved_at" TIMESTAMPTZ(3),
ADD COLUMN     "approved_by" TEXT,
ADD COLUMN     "last_login_at" TIMESTAMPTZ(3),
ADD COLUMN     "role" TEXT NOT NULL DEFAULT 'user',
ADD COLUMN     "status" TEXT NOT NULL DEFAULT 'pending',
ADD COLUMN     "status_changed_at" TIMESTAMPTZ(3);

-- AlterTable
ALTER TABLE "job_postings" ADD COLUMN     "shared_posting_id" TEXT;

-- AlterTable
ALTER TABLE "posting_imports" ADD COLUMN     "refresh" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "shared_posting_id" TEXT,
ADD COLUMN     "url_key" TEXT;

-- AlterTable
ALTER TABLE "company_resumes" ADD COLUMN     "kind" TEXT NOT NULL DEFAULT 'company',
ADD COLUMN     "source_resume_id" TEXT,
ALTER COLUMN "company" SET DEFAULT '',
ALTER COLUMN "role_title" SET DEFAULT '';

-- CreateTable
CREATE TABLE "user_consents" (
    "id" SERIAL NOT NULL,
    "user_id" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" TEXT NOT NULL,
    "agreed" BOOLEAN NOT NULL,
    "source" TEXT NOT NULL,
    "ip_hash" TEXT,
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_consents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "shared_postings" (
    "id" TEXT NOT NULL,
    "url_key" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "platform" TEXT,
    "company" TEXT NOT NULL,
    "role_title" TEXT NOT NULL,
    "jd_text" TEXT,
    "structured" JSONB,
    "structured_version" INTEGER,
    "source_text" TEXT,
    "deadline" TEXT,
    "deadline_time" TEXT,
    "deadline_kind" TEXT NOT NULL DEFAULT 'unspecified',
    "employment_type" TEXT NOT NULL DEFAULT 'unknown',
    "work_type" TEXT NOT NULL DEFAULT 'unknown',
    "location" TEXT,
    "career_level" TEXT NOT NULL DEFAULT 'unknown',
    "extracted_by" TEXT NOT NULL,
    "importer_count" INTEGER NOT NULL DEFAULT 0,
    "created_by" TEXT,
    "hidden_at" TIMESTAMPTZ(3),
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "shared_postings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "user_consents_user_idx" ON "user_consents"("user_id", "type", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "shared_postings_url_key_unique" ON "shared_postings"("url_key");

-- CreateIndex
CREATE INDEX "shared_postings_fetched_idx" ON "shared_postings"("fetched_at");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status", "created_at");

-- CreateIndex
CREATE INDEX "job_postings_shared_idx" ON "job_postings"("shared_posting_id");

-- CreateIndex
CREATE INDEX "company_resumes_user_kind_idx" ON "company_resumes"("user_id", "kind", "updated_at");

-- AddForeignKey
ALTER TABLE "user_consents" ADD CONSTRAINT "user_consents_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "job_postings" ADD CONSTRAINT "job_postings_shared_posting_id_fkey" FOREIGN KEY ("shared_posting_id") REFERENCES "shared_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "shared_postings" ADD CONSTRAINT "shared_postings_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "posting_imports" ADD CONSTRAINT "posting_imports_shared_posting_id_fkey" FOREIGN KEY ("shared_posting_id") REFERENCES "shared_postings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "company_resumes" ADD CONSTRAINT "company_resumes_source_resume_id_fkey" FOREIGN KEY ("source_resume_id") REFERENCES "company_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- 기존 회원: 승인됨.
UPDATE "users" SET "status" = 'approved', "approved_at" = CURRENT_TIMESTAMP, "approved_by" = 'system:migration', "status_changed_at" = CURRENT_TIMESTAMP;

-- 새 테이블도 Supabase Data API에서 감춘다(정책 없음 = 전부 거부, 앱은 소유자 역할이라 우회).
ALTER TABLE "user_consents" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "shared_postings" ENABLE ROW LEVEL SECURITY;
