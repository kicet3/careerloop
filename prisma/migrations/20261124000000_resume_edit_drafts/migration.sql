-- 이력서 임시 저장(src/lib/resumes/edit-draft.ts): 편집 화면이 새 버전을 만들지 않고 이어서 고칠 작업본을 이력서당 하나 둔다.
-- 소유자만 읽고 쓴다(user_id 조건). '저장(새 버전)'하면 지운다. base_version_id는 작업을 시작한 버전(FK 없음 — 충돌 확인용).
-- 이력서를 지우거나 탈퇴하면 함께 지워진다(CASCADE). 미리보기 공유·PDF는 저장된 버전만 쓴다.

-- CreateTable
CREATE TABLE "resume_edit_drafts" (
    "resume_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "base_version_id" TEXT,
    "template_id" TEXT,
    "document" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "resume_edit_drafts_pkey" PRIMARY KEY ("resume_id")
);

-- CreateIndex
CREATE INDEX "resume_edit_drafts_user_idx" ON "resume_edit_drafts"("user_id");

-- AddForeignKey
ALTER TABLE "resume_edit_drafts" ADD CONSTRAINT "resume_edit_drafts_resume_id_fkey" FOREIGN KEY ("resume_id") REFERENCES "company_resumes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "resume_edit_drafts" ADD CONSTRAINT "resume_edit_drafts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Supabase Data API(anon/authenticated 키)로 읽고 쓰지 못하게 RLS를 켠다(정책 없음 = 전부 거부, 앱은 소유자 역할로 우회) — 기존 테이블과 같은 정책.
ALTER TABLE "resume_edit_drafts" ENABLE ROW LEVEL SECURITY;
