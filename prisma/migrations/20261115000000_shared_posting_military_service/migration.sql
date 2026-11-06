-- 공용 공고 병역특례 태그(shared_postings.military_service): 공고 찾기 카드·상세의 '전문연 가능'·'산업기능요원 가능(보충역)' 태그와
-- '병역특례' 필터용. 값은 앱이 공개 필드(직무명·JD·구역)로 계산해 쓴다(src/lib/postings/military-service.ts — 정규식 판정이라 SQL로는 옮기지 않는다).
-- 기존 행은 military_service_version이 NULL로 남고, 공고 찾기 목록을 읽을 때 앱이 한 번에 묶어 다시 계산해 채운다
-- (지연 백필: src/lib/postings/shared.ts backfillSharedMilitaryService). 판정 규칙을 바꾸면 버전을 올려 같은 길로 다시 계산한다.

-- AlterTable
ALTER TABLE "shared_postings" ADD COLUMN     "military_service" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "military_service_version" INTEGER;
