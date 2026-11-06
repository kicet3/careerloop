-- 공용 공고 회사 키(shared_postings.company_key): 공고 찾기 '회사' 필터·회사 목록용. 값은 앱이 회사 이름으로 계산해 쓴다
-- (src/lib/domain/company.ts companyKey — NFKC·법인 표기 제거 규칙이라 SQL로는 옮기지 않는다. SQL로 비슷하게 채우면 앱 규칙과 어긋난 키가 남는다).
-- 기존 행은 NULL로 남고, 공고 찾기 목록·회사 목록을 읽을 때 앱이 묶어 계산해 채운다(지연 백필: src/lib/postings/shared.ts backfillSharedCompanyKeys).
-- 규칙을 바꾸면 새 마이그레이션에서 "company_key" = NULL로 되돌려 같은 길로 다시 채운다.

-- AlterTable
ALTER TABLE "shared_postings" ADD COLUMN     "company_key" TEXT;

-- CreateIndex
CREATE INDEX "shared_postings_company_key_idx" ON "shared_postings"("company_key");
