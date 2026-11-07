-- 이미 만든 이력서 '다시 생성'(src/lib/resumes/regenerate.ts): 빠른 초안·에이전트 작업이 새 이력서 대신 이 이력서의 새 버전을 저장한다.
-- target_resume_id가 있으면 다시 생성 작업이다(없으면 새 이력서 만들기). FK는 걸지 않는다 — 실행 중에 이력서를 지우면
-- 작업이 저장 단계에서 '이력서가 없다'로 깔끔하게 실패해야 한다(SET NULL이면 새 이력서 만들기로 바뀐다).
-- 같은 이력서의 진행 중인 다시 생성은 하나만(앱이 이력서별 advisory lock 안에서 센다 — 인덱스로 찾는다).

-- AlterTable
ALTER TABLE "resume_draft_jobs" ADD COLUMN "target_resume_id" TEXT;

-- AlterTable
ALTER TABLE "resume_agent_jobs" ADD COLUMN "target_resume_id" TEXT;

-- CreateIndex
CREATE INDEX "resume_draft_jobs_target_idx" ON "resume_draft_jobs"("target_resume_id");

-- CreateIndex
CREATE INDEX "resume_agent_jobs_target_idx" ON "resume_agent_jobs"("target_resume_id");
