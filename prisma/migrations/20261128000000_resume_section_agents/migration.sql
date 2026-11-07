-- 구역별 이력서 작성 에이전트(파이프라인 v2, docs/RESUME-SECTION-AGENTS.md §5.1).
-- pipeline_version: 작업 시작 때 고정(기존 행은 1 — 진행 중 v1 작업은 v1 단계 계획으로 끝까지 간다).
-- section: kind='section' 단계 행의 구역 id. 지원 동기 추천은 이력서당 마지막 하나(이력서를 지우면 함께 지운다).

-- AlterTable
ALTER TABLE "resume_agent_jobs" ADD COLUMN "pipeline_version" INTEGER NOT NULL DEFAULT 1;

-- AlterTable
ALTER TABLE "resume_agent_steps" ADD COLUMN "section" TEXT;

-- CreateIndex
CREATE INDEX "resume_agent_steps_job_round_section_idx" ON "resume_agent_steps"("job_id", "round", "section");

-- CreateTable
CREATE TABLE "resume_motivation_suggestions" (
    "resume_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "suggestion" JSONB NOT NULL,
    "source" TEXT NOT NULL,
    "agent_job_id" TEXT,
    "jd_hash" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_motivation_suggestions_pkey" PRIMARY KEY ("resume_id")
);

-- CreateIndex
CREATE INDEX "resume_motivation_suggestions_user_idx" ON "resume_motivation_suggestions"("user_id");

-- AddForeignKey
ALTER TABLE "resume_motivation_suggestions" ADD CONSTRAINT "resume_motivation_suggestions_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- 다른 테이블과 같이 RLS를 켠다(앱은 서비스 역할로만 접근 — 정책 없음 = 클라이언트 키로는 읽지 못한다).
ALTER TABLE "resume_motivation_suggestions" ENABLE ROW LEVEL SECURITY;
