-- 에이전트형 그래프 RAG(docs/AGENTIC-GRAPH-RAG.md §3.1, §6): 사용자별 권한·데이터 버전(user_rag_state)과 문서 청크 저장소(experience_chunks).
-- 사용자 격리는 앱 SQL의 user_id 조건(src/lib/rag/chunks/store.ts)과 검증기의 출처 재조회(src/lib/rag/validator.ts)로 강제한다.
-- RLS는 기존 테이블과 같이 Data API 차단용으로만 켠다(정책 없음, 앱은 소유자 역할).

-- CreateTable
CREATE TABLE "user_rag_state" (
    "user_id" TEXT NOT NULL,
    -- 정지·거절·승인·동의 기록·비밀번호 변경 때 오른다(아래 트리거). 에이전트는 스텝마다 다시 읽어 바뀌면 멈춘다.
    "policy_version" INTEGER NOT NULL DEFAULT 1,
    -- 그래프 쓰기·청크 변경·출처 변경·삭제 때 오른다(앱 bumpDataVersion + 아래 트리거). 캐시 무효화·빠른 중단용.
    "data_version" BIGINT NOT NULL DEFAULT 1,
    -- 청크 출처(포트폴리오 글·GitHub 요약·가져온 문서)가 바뀔 때만 오른다. indexed_source_version보다 크면 색인이 최신이 아닐 수 있다.
    "source_version" BIGINT NOT NULL DEFAULT 1,
    "indexed_source_version" BIGINT NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_rag_state_pkey" PRIMARY KEY ("user_id")
);

ALTER TABLE "user_rag_state" ADD CONSTRAINT "user_rag_state_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "user_rag_state" ENABLE ROW LEVEL SECURITY;

-- CreateTable
CREATE TABLE "experience_chunks" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "source_type" TEXT NOT NULL,
    "source_id" TEXT NOT NULL,
    "source_version" TEXT NOT NULL,
    "ordinal" INTEGER NOT NULL,
    "span_start" INTEGER NOT NULL,
    "span_end" INTEGER NOT NULL,
    "node_ids" TEXT[] NOT NULL DEFAULT '{}',
    -- 색인 시점의 구간 텍스트(≤1200자). 검색 SQL은 이 열을 읽지 않고, LLM에는 권위 원문에서 다시 자른 구간만 간다.
    "content" TEXT NOT NULL,
    "content_hash" TEXT NOT NULL,
    "search_terms" TEXT NOT NULL,
    -- to_tsvector('simple', search_terms). 생성 열이 아니라 앱 INSERT(store.ts replaceSourceChunks)가 계산해 넣는다 — Prisma 스키마와 어긋나지 않게.
    "tsv" TSVECTOR NOT NULL,
    -- 벡터 검색: 공급자 선택 전까지 NULL(벡터 열·색인은 그때 추가한다).
    "embedding_model" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "experience_chunks_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "experience_chunks_source_type_check" CHECK ("source_type" IN ('repo-brief', 'document-import', 'portfolio-text')),
    CONSTRAINT "experience_chunks_span_check" CHECK ("span_start" >= 0 AND "span_end" > "span_start")
);

CREATE UNIQUE INDEX "experience_chunks_source_uq" ON "experience_chunks"("user_id", "source_type", "source_id", "ordinal");
-- 검색 CTE의 사용자 선필터가 이 색인을 탄다. 전역 GIN(tsv) 색인은 두지 않는다(질의 시간이 다른 사용자 데이터 분포에 의존하지 않게, §6.1).
CREATE INDEX "experience_chunks_user_source" ON "experience_chunks"("user_id", "source_type", "source_id");
-- 메시지 삭제 트리거(rag_chat_messages_trg)는 user_id 없이 출처로 지운다 — 전체 스캔하지 않게 출처 btree. 검색 CTE는 이 색인을 쓰지 않는다(§6.1).
CREATE INDEX "experience_chunks_source_ref" ON "experience_chunks"("source_type", "source_id");

ALTER TABLE "experience_chunks" ADD CONSTRAINT "experience_chunks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "experience_chunks" ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- 버전 올리기·삭제 연쇄(트리거). 앱 코드 경로와 무관하게(관리자 작업·다른 기능의 쓰기 포함) 같은 트랜잭션에서 일어난다.
-- 사용자 행이 이미 지워지는 중이면(탈퇴 CASCADE) 아무것도 하지 않는다.
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION rag_bump(uid TEXT, bump_policy BOOLEAN, bump_source BOOLEAN) RETURNS VOID AS $$
BEGIN
  IF uid IS NULL OR NOT EXISTS (SELECT 1 FROM "users" WHERE "id" = uid) THEN
    RETURN;
  END IF;
  INSERT INTO "user_rag_state" ("user_id", "policy_version", "data_version", "source_version", "updated_at")
  VALUES (uid, CASE WHEN bump_policy THEN 2 ELSE 1 END, 2, CASE WHEN bump_source THEN 2 ELSE 1 END, CURRENT_TIMESTAMP)
  ON CONFLICT ("user_id") DO UPDATE SET
    "policy_version" = "user_rag_state"."policy_version" + CASE WHEN bump_policy THEN 1 ELSE 0 END,
    "data_version" = "user_rag_state"."data_version" + 1,
    "source_version" = "user_rag_state"."source_version" + CASE WHEN bump_source THEN 1 ELSE 0 END,
    "updated_at" = CURRENT_TIMESTAMP;
END;
$$ LANGUAGE plpgsql;

-- 계정 상태(정지·거절·승인)·비밀번호 변경 → 권한 버전.
CREATE OR REPLACE FUNCTION rag_users_policy_trg() RETURNS TRIGGER AS $$
BEGIN
  IF NEW."status" IS DISTINCT FROM OLD."status" OR NEW."password_hash" IS DISTINCT FROM OLD."password_hash" THEN
    PERFORM rag_bump(NEW."id", TRUE, FALSE);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "rag_users_policy" AFTER UPDATE ON "users" FOR EACH ROW EXECUTE FUNCTION rag_users_policy_trg();

-- 동의·철회 기록(append-only) → 권한 버전.
CREATE OR REPLACE FUNCTION rag_consents_policy_trg() RETURNS TRIGGER AS $$
BEGIN
  PERFORM rag_bump(NEW."user_id", TRUE, FALSE);
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "rag_consents_policy" AFTER INSERT ON "user_consents" FOR EACH ROW EXECUTE FUNCTION rag_consents_policy_trg();

-- 포트폴리오 삭제 → 청크 삭제 + 데이터 버전(삭제로 색인은 이미 최신이라 출처 버전은 올리지 않는다).
-- 글 교체·새 글 → 청크 삭제 + 데이터·출처 버전(다시 만들기는 재색인).
CREATE OR REPLACE FUNCTION rag_portfolios_trg() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "experience_chunks" WHERE "user_id" = OLD."user_id" AND "source_type" = 'portfolio-text' AND "source_id" = OLD."id";
    PERFORM rag_bump(OLD."user_id", FALSE, FALSE);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."text_key" IS DISTINCT FROM OLD."text_key" OR NEW."graph_source" IS DISTINCT FROM OLD."graph_source" THEN
      DELETE FROM "experience_chunks" WHERE "user_id" = OLD."user_id" AND "source_type" = 'portfolio-text' AND "source_id" = OLD."id";
      PERFORM rag_bump(NEW."user_id", FALSE, TRUE);
    END IF;
  ELSE
    IF NEW."text_key" IS NOT NULL THEN
      PERFORM rag_bump(NEW."user_id", FALSE, TRUE);
    END IF;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "rag_portfolios" AFTER INSERT OR UPDATE OR DELETE ON "portfolios" FOR EACH ROW EXECUTE FUNCTION rag_portfolios_trg();

-- GitHub 저장소 요약 삭제 → 청크 삭제 + 데이터 버전. 요약 변경·프로젝트 연결 변경 → 청크 삭제 + 데이터·출처 버전(다시 만들기는 앱 syncSource).
CREATE OR REPLACE FUNCTION rag_repo_snapshots_trg() RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    DELETE FROM "experience_chunks" WHERE "user_id" = OLD."user_id" AND "source_type" = 'repo-brief' AND "source_id" = OLD."id";
    PERFORM rag_bump(OLD."user_id", FALSE, FALSE);
  ELSIF TG_OP = 'UPDATE' THEN
    IF NEW."brief" IS DISTINCT FROM OLD."brief" OR NEW."project_node_id" IS DISTINCT FROM OLD."project_node_id" THEN
      DELETE FROM "experience_chunks" WHERE "user_id" = OLD."user_id" AND "source_type" = 'repo-brief' AND "source_id" = OLD."id";
      PERFORM rag_bump(NEW."user_id", FALSE, TRUE);
    END IF;
  ELSE
    PERFORM rag_bump(NEW."user_id", FALSE, TRUE);
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "rag_repo_snapshots" AFTER INSERT OR UPDATE OR DELETE ON "github_repo_snapshots" FOR EACH ROW EXECUTE FUNCTION rag_repo_snapshots_trg();

-- 채팅 메시지 삭제(스레드 삭제 CASCADE 포함) → 그 메시지(가져온 문서)의 청크 삭제 + 데이터 버전(출처 버전은 올리지 않는다).
CREATE OR REPLACE FUNCTION rag_chat_messages_trg() RETURNS TRIGGER AS $$
DECLARE
  owner TEXT;
BEGIN
  FOR owner IN
    WITH d AS (DELETE FROM "experience_chunks" WHERE "source_type" = 'document-import' AND "source_id" = OLD."id" RETURNING "user_id")
    SELECT DISTINCT "user_id" FROM d
  LOOP
    PERFORM rag_bump(owner, FALSE, FALSE);
  END LOOP;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "rag_chat_messages" AFTER DELETE ON "chat_messages" FOR EACH ROW EXECUTE FUNCTION rag_chat_messages_trg();
