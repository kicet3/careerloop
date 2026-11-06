-- 포트폴리오 보관함(portfolios): 이력서마다 붙이던 포트폴리오(company_resumes.portfolio_*)를 사용자별 보관함 항목으로 옮기고,
-- 이력서는 그중 하나를 portfolio_id로 가리킨다(포트폴리오를 지우면 SET NULL — 이력서에서 떨어질 뿐 이력서는 남는다).
-- 저장소 객체는 SQL로 옮길 수 없으므로 옮긴 항목은 예전 키(users/<u>/resumes/<이력서 id>/portfolio-<꼬리>.txt)를 text_key로
-- 그대로 쓴다. 앱은 이력서를 지울 때 포트폴리오가 쓰는 키를 남기고(deleteResume), 포트폴리오를 지울 때 그 키를 지운다.

-- CreateTable
CREATE TABLE "portfolios" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT,
    "kind" TEXT NOT NULL,
    "file_name" TEXT,
    "url" TEXT,
    "text_key" TEXT,
    "chars" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "portfolios_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "portfolios_user_idx" ON "portfolios"("user_id", "updated_at");

-- AddForeignKey
ALTER TABLE "portfolios" ADD CONSTRAINT "portfolios_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AlterTable
ALTER TABLE "company_resumes" ADD COLUMN "portfolio_id" TEXT;

-- CreateIndex
CREATE INDEX "company_resumes_portfolio_idx" ON "company_resumes"("portfolio_id");

-- AddForeignKey
ALTER TABLE "company_resumes" ADD CONSTRAINT "company_resumes_portfolio_id_fkey" FOREIGN KEY ("portfolio_id") REFERENCES "portfolios"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Backfill: 포트폴리오를 붙인 이력서마다 보관함 항목 하나를 만든다. id는 앱의 이력서 id와 같은 16자(영문·숫자 — 저장소 키 조각).
-- 이름은 파일 이름 → 주소의 호스트 → "<이력서 제목> 포트폴리오" 순서. 모르는 종류 값은 예전 화면에서도 '없음'이라 옮기지 않는다.
CREATE TEMP TABLE "_portfolio_backfill" AS
SELECT r."id" AS "resume_id", substr(md5(random()::text || r."id" || clock_timestamp()::text), 1, 16) AS "portfolio_id"
FROM "company_resumes" r
WHERE r."portfolio_kind" IN ('file', 'url');

INSERT INTO "portfolios" ("id", "user_id", "title", "description", "kind", "file_name", "url", "text_key", "chars", "created_at", "updated_at")
SELECT b."portfolio_id", r."user_id",
    left(COALESCE(
        NULLIF(btrim(CASE WHEN r."portfolio_kind" = 'file' THEN r."portfolio_file_name" END), ''),
        NULLIF(substring(CASE WHEN r."portfolio_kind" = 'url' THEN r."portfolio_url" END FROM '^[A-Za-z][A-Za-z0-9+.-]*://(?:[^@/?#]*@)?([^/:?#]+)'), ''),
        btrim(r."title" || ' 포트폴리오')
    ), 120),
    NULL,
    r."portfolio_kind",
    CASE WHEN r."portfolio_kind" = 'file' THEN r."portfolio_file_name" END,
    CASE WHEN r."portfolio_kind" = 'url' THEN r."portfolio_url" END,
    CASE WHEN r."portfolio_kind" = 'file' THEN r."portfolio_text_key" END,
    CASE WHEN r."portfolio_kind" = 'file' THEN r."portfolio_chars" END,
    COALESCE(r."portfolio_updated_at", r."updated_at"),
    COALESCE(r."portfolio_updated_at", r."updated_at")
FROM "_portfolio_backfill" b
JOIN "company_resumes" r ON r."id" = b."resume_id";

UPDATE "company_resumes" r
SET "portfolio_id" = b."portfolio_id"
FROM "_portfolio_backfill" b
WHERE r."id" = b."resume_id";

DROP TABLE "_portfolio_backfill";

-- 예전 컬럼은 모두 portfolios로 옮겼으므로 지운다.
ALTER TABLE "company_resumes" DROP COLUMN "portfolio_chars",
DROP COLUMN "portfolio_file_name",
DROP COLUMN "portfolio_kind",
DROP COLUMN "portfolio_text_key",
DROP COLUMN "portfolio_updated_at",
DROP COLUMN "portfolio_url";

-- 새 테이블도 Supabase Data API에서 감춘다(정책 없음 = 전부 거부, 앱은 소유자 역할이라 우회).
ALTER TABLE "portfolios" ENABLE ROW LEVEL SECURITY;
