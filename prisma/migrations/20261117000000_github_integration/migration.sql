-- GitHub 연동(github_accounts·github_repo_snapshots): 사용자별 GitHub App 사용자 토큰(AES-256-GCM 암호문만 저장 — src/lib/crypto/secret-box.ts)과
-- 사용자가 고른 저장소에서 읽은 정보·AI용 요약(brief). 저장소 원본은 복제하지 않는다 — docs/GITHUB.md.
-- project_node_id는 Neo4j의 Project 노드 id라 외래 키가 없다(NULL = 아직 프로젝트에 잇지 않음). 한 프로젝트에는 저장소 하나만 잇는다(부분 유니크 인덱스).
-- 연결을 해제하면 github_accounts 행을 지우고 저장소 정보가 함께 지워진다(ON DELETE CASCADE). 탈퇴하면 users → github_accounts → snapshots 순으로 지워진다.


-- CreateTable
CREATE TABLE "github_accounts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "github_user_id" TEXT NOT NULL,
    "login" TEXT NOT NULL,
    "avatar_url" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "access_token_enc" TEXT,
    "access_token_expires_at" TIMESTAMPTZ(3),
    "refresh_token_enc" TEXT,
    "refresh_token_expires_at" TIMESTAMPTZ(3),
    "include_private" BOOLEAN NOT NULL DEFAULT false,
    "connected_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "last_synced_at" TIMESTAMPTZ(3),

    CONSTRAINT "github_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "github_repo_snapshots" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "repo_id" TEXT NOT NULL,
    "full_name" TEXT NOT NULL,
    "html_url" TEXT NOT NULL,
    "private" BOOLEAN NOT NULL DEFAULT false,
    "data" JSONB NOT NULL,
    "brief" TEXT NOT NULL,
    "builder_version" INTEGER NOT NULL,
    "etag" TEXT,
    "pushed_at" TIMESTAMPTZ(3),
    "fetched_at" TIMESTAMPTZ(3) NOT NULL,
    "project_node_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "github_repo_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "github_accounts_user_unique" ON "github_accounts"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_accounts_github_user_unique" ON "github_accounts"("github_user_id");

-- CreateIndex
CREATE INDEX "github_repo_snapshots_project_idx" ON "github_repo_snapshots"("user_id", "project_node_id");

-- CreateIndex
CREATE UNIQUE INDEX "github_repo_snapshots_repo_uq" ON "github_repo_snapshots"("user_id", "repo_id");

-- AddForeignKey
ALTER TABLE "github_accounts" ADD CONSTRAINT "github_accounts_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "github_repo_snapshots" ADD CONSTRAINT "github_repo_snapshots_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "github_accounts"("user_id") ON DELETE CASCADE ON UPDATE CASCADE;


-- 한 프로젝트(Project 노드)에는 저장소 하나만 잇는다.
CREATE UNIQUE INDEX "github_repo_snapshots_project_uq" ON "github_repo_snapshots"("user_id", "project_node_id") WHERE "project_node_id" IS NOT NULL;

-- Supabase Data API(anon·authenticated 역할)에서 감춘다 — 앱은 서버의 Prisma 연결로만 읽고 쓴다.
ALTER TABLE "github_accounts" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "github_repo_snapshots" ENABLE ROW LEVEL SECURITY;
