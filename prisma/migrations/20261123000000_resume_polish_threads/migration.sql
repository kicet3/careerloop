-- 이력서 AI로 다듬기(kind='resume-polish'): 이력서 한 칸(target_path, 예: experience[0].bullets[1])을 두고 나누는 대화.
-- 스레드는 (user_id, resume_id, target_path)로 찾는다. 이력서를 지우면 대화도 함께 지운다. 다른 종류의 스레드는 두 열 모두 NULL.

-- AlterTable
ALTER TABLE "chat_threads" ADD COLUMN "resume_id" TEXT;
ALTER TABLE "chat_threads" ADD COLUMN "target_path" TEXT;

-- CreateIndex
CREATE INDEX "chat_threads_resume_idx" ON "chat_threads"("resume_id", "target_path");

-- AddForeignKey
ALTER TABLE "chat_threads" ADD CONSTRAINT "chat_threads_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;
