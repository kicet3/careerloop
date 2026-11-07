-- 경험 그래프 이력서 에이전트(docs/RESUME-AGENT.md, src/lib/resume-agent/jobs.ts).
-- 작업(resume_agent_jobs)은 여러 함수 호출에 걸쳐 단계(resume_agent_steps)를 하나씩 진행한다. 리스(lease_id·lease_expires_at)를 잡은
-- 호출만 단계를 실행한다. 탈퇴하면 함께 지워지고(CASCADE), 만든 이력서를 지우면 resume_id는 null이 된다.

-- CreateTable
CREATE TABLE "resume_agent_jobs" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "run_id" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'running',
    "current_step" TEXT NOT NULL DEFAULT 'r0.jd',
    "round" INTEGER NOT NULL DEFAULT 0,
    "label" TEXT NOT NULL,
    "input" JSONB,
    "provider" TEXT,
    "error" TEXT,
    "failed_step" TEXT,
    "resume_id" TEXT,
    "report" JSONB,
    "progress" JSONB,
    "usage" JSONB,
    "lease_id" TEXT,
    "lease_expires_at" TIMESTAMPTZ(3),
    "graph_fingerprint" TEXT,
    "deployment_id" TEXT,
    "schema_version" INTEGER NOT NULL DEFAULT 1,
    "chain_error" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 1,
    "continuations" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completed_at" TIMESTAMPTZ(3),

    CONSTRAINT "resume_agent_jobs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "resume_agent_steps" (
    "id" TEXT NOT NULL,
    "job_id" TEXT NOT NULL,
    "key" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "round" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'pending',
    "output" JSONB,
    "summary" JSONB,
    "error" TEXT,
    "usage" JSONB,
    "model" TEXT,
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "started_at" TIMESTAMPTZ(3),
    "finished_at" TIMESTAMPTZ(3),

    CONSTRAINT "resume_agent_steps_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "resume_agent_jobs_user_status_idx" ON "resume_agent_jobs"("user_id", "status");

-- CreateIndex
CREATE INDEX "resume_agent_jobs_user_idx" ON "resume_agent_jobs"("user_id", "created_at");

-- CreateIndex
CREATE INDEX "resume_agent_jobs_resume_idx" ON "resume_agent_jobs"("resume_id");

-- CreateIndex
CREATE UNIQUE INDEX "resume_agent_steps_job_key_unique" ON "resume_agent_steps"("job_id", "key");

-- AddForeignKey
ALTER TABLE "resume_agent_jobs" ADD CONSTRAINT "resume_agent_jobs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_agent_jobs" ADD CONSTRAINT "resume_agent_jobs_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_agent_steps" ADD CONSTRAINT "resume_agent_steps_job_id_fkey" FOREIGN KEY ("job_id") REFERENCES "resume_agent_jobs"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase Data API(anon/authenticated 키)로 읽고 쓰지 못하게 RLS를 켠다(정책 없음 = 전부 거부, 앱은 소유자 역할로 우회) — 기존 테이블과 같은 정책.
ALTER TABLE "resume_agent_jobs" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "resume_agent_steps" ENABLE ROW LEVEL SECURITY;
