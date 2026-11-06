-- 공용 공고 먼저(shared-first): 모든 보관 공고(job_postings)가 공용 공고(shared_postings)를 가리킨다.
-- 직접 입력 공고도 공용 공고를 먼저 만들고(url·url_key 없음, extracted_by 'manual') 보관 공고가 연결된다.
-- 회원 탈퇴는 보관 공고만 지우고 공용 공고는 남긴다(created_by는 FK ON DELETE SET NULL).

-- AlterTable: 직접 입력으로 만든 공용 공고는 주소가 없다. url_key 유일 인덱스는 그대로(NULL은 여러 개 허용).
ALTER TABLE "shared_postings" ALTER COLUMN "url_key" DROP NOT NULL,
ALTER COLUMN "url" DROP NOT NULL;

-- 같은 주소(url_key)의 공용 공고가 이미 있으면 숨긴 것이어도 그것에 연결한다(앱의 직접 입력 규칙과 같다). 관리자가 숨긴
-- 주소는 숨긴 공고에 연결돼 숨긴 채로 남고, 같은 내용의 보이는 사본을 만들지 않는다.
UPDATE "job_postings" jp
SET "shared_posting_id" = sp."id"
FROM "shared_postings" sp
WHERE jp."shared_posting_id" IS NULL AND jp."url_key" IS NOT NULL AND sp."url_key" = jp."url_key";

-- Backfill: 나머지 공용 공고에 연결되지 않은 보관 공고마다 공개 필드만 담은 공용 공고를 만든다(메모·상태·원문은 넣지 않는다).
-- id는 앱의 nanoid(21자)와 같은 길이. 주소는 넣지 않는다(직접 입력 공고의 주소는 개인 값일 수 있다).
-- 숨긴 채로(hidden_at = now()) 만든다: 이 공고들은 '직접 붙여넣은 공고는 공유되지 않는다'는 예전 안내 아래 입력됐거나 공유가
-- 생기기 전의 가져오기(로그인·비공개 링크 페이지일 수 있다)라서, 소급해 공고 찾기에 공개하지 않는다. 연결 구조만 맞춘다.
-- platform은 알려진 채용 플랫폼 식별자만 남긴다(그 밖은 호스트 이름이라 사내·비공개 주소일 수 있다 — src/lib/postings/url.ts publicPlatform).
CREATE TEMP TABLE "_shared_backfill" AS
SELECT jp."id" AS "posting_id", substr(md5(random()::text || jp."id" || clock_timestamp()::text), 1, 21) AS "shared_id"
FROM "job_postings" jp
WHERE jp."shared_posting_id" IS NULL;

INSERT INTO "shared_postings" (
    "id", "url_key", "url", "platform", "company", "role_title", "jd_text", "structured", "structured_version",
    "source_text", "deadline", "deadline_time", "deadline_kind", "employment_type", "work_type", "location",
    "career_level", "extracted_by", "importer_count", "created_by", "hidden_at", "fetched_at", "created_at", "updated_at"
)
SELECT b."shared_id", NULL, NULL,
    CASE WHEN jp."platform" IN ('remember', 'wanted', 'linkedin', 'jobkorea', 'saramin', 'incruit', 'rocketpunch', 'groupby',
        'zighang', 'peoplenjob', 'glassdoor', 'catch', 'jasoseol', 'superookie', 'jobplanet') THEN jp."platform" END, jp."company", jp."role_title", jp."jd_text", jp."structured", jp."structured_version",
    NULL, jp."deadline", jp."deadline_time", jp."deadline_kind", jp."employment_type", jp."work_type", jp."location",
    jp."career_level", 'manual', 0, jp."user_id", now(), jp."created_at", jp."created_at", jp."updated_at"
FROM "_shared_backfill" b
JOIN "job_postings" jp ON jp."id" = b."posting_id";

UPDATE "job_postings" jp
SET "shared_posting_id" = b."shared_id"
FROM "_shared_backfill" b
WHERE jp."id" = b."posting_id";

DROP TABLE "_shared_backfill";

-- 담은 사용자 수를 다시 센다.
UPDATE "shared_postings" sp
SET "importer_count" = (SELECT count(*)::int FROM "job_postings" jp WHERE jp."shared_posting_id" = sp."id");
