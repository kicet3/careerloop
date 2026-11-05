-- 공고 구조화(구역별 데이터)와 가져온 페이지 원문. 기존 행은 null로 남는다(화면이 jdText를 즉석 구조화).
ALTER TABLE "job_postings" ADD COLUMN "structured" JSONB, ADD COLUMN "structured_version" INTEGER, ADD COLUMN "source_text" TEXT;
