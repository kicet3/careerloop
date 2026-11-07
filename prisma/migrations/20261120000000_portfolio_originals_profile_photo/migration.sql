-- 포트폴리오 원본 파일 보관(portfolios.original_*)과 프로필 사진(users.photo_key), 이력서별 '사진 넣기'(company_resumes.include_photo).
-- 원본은 users/<u>/portfolios/<id>/original-<꼬리>.<확장자>, 사진은 users/<u>/profile/photo-<꼬리>.jpg — 탈퇴 시 users/<u>/ 접두사와 함께 지운다.
-- 예전 포트폴리오는 원본이 없으므로 null로 둔다(뽑은 글만 보인다).

-- AlterTable
ALTER TABLE "portfolios" ADD COLUMN "original_key" TEXT,
ADD COLUMN "original_mime" TEXT,
ADD COLUMN "original_size" INTEGER;

-- AlterTable
ALTER TABLE "users" ADD COLUMN "photo_key" TEXT;

-- AlterTable
ALTER TABLE "company_resumes" ADD COLUMN "include_photo" BOOLEAN NOT NULL DEFAULT true;
