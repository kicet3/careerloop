-- JD 맞춤 작성 팁(task 'resume-jd-tips'). 이력서당 마지막 하나, (user_id, jd_hash)로 같은 사용자의 같은 JD 팁을 다시 쓴다.

-- CreateTable
CREATE TABLE "resume_jd_tips" (
    "resume_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "jd_hash" TEXT NOT NULL,
    "tips" JSONB NOT NULL,
    "model" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_jd_tips_pkey" PRIMARY KEY ("resume_id")
);

-- CreateIndex
CREATE INDEX "resume_jd_tips_user_hash_idx" ON "resume_jd_tips"("user_id", "jd_hash");

-- AddForeignKey
ALTER TABLE "resume_jd_tips" ADD CONSTRAINT "resume_jd_tips_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_jd_tips" ADD CONSTRAINT "resume_jd_tips_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase Data API(anon/authenticated 키)로 읽고 쓰지 못하게 RLS를 켠다(정책 없음 = 전부 거부, 앱은 소유자 역할로 우회) — 기존 테이블과 같은 정책.
ALTER TABLE "resume_jd_tips" ENABLE ROW LEVEL SECURITY;
