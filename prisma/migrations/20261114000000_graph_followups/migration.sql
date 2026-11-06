-- 경험 그래프 후속 질문(graph_followups): 그래프 채팅 변경안의 후속 질문과, 변경안에서 뺀 항목 중 사용자가 채울 수 있는 것(근거·기간·수치)을
-- 질문으로 바꾼 목록. 프로젝트 단위 대화가 하나씩 물어 채운다(src/lib/chat/followups.ts).
-- project_node_id는 Neo4j의 Project 노드 id라 외래 키가 없다(NULL = 프로젝트 미지정). 대화·메시지를 지우면 thread_id·source_message_id만 NULL이 되고,
-- 탈퇴하면 그 사용자의 후속 질문도 지워진다(ON DELETE CASCADE).

-- CreateTable
CREATE TABLE "graph_followups" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "project_node_id" TEXT,
    "project_ref" TEXT,
    "thread_id" TEXT,
    "source_message_id" TEXT,
    "kind" TEXT NOT NULL,
    "text" TEXT NOT NULL,
    "detail" TEXT,
    "target_item" TEXT,
    "dedupe_key" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),

    CONSTRAINT "graph_followups_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "graph_followups_user_idx" ON "graph_followups"("user_id", "status", "project_node_id");

-- CreateIndex
CREATE INDEX "graph_followups_message_idx" ON "graph_followups"("source_message_id");

-- CreateIndex
CREATE INDEX "graph_followups_thread_idx" ON "graph_followups"("thread_id");

-- AddForeignKey
ALTER TABLE "graph_followups" ADD CONSTRAINT "graph_followups_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_followups" ADD CONSTRAINT "graph_followups_thread_id_fkey" FOREIGN KEY ("thread_id") REFERENCES "chat_threads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "graph_followups" ADD CONSTRAINT "graph_followups_source_message_id_fkey" FOREIGN KEY ("source_message_id") REFERENCES "chat_messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;


-- Supabase Data API(anon·authenticated 역할)에서 감춘다 — 앱은 서버의 Prisma 연결로만 읽고 쓴다.
ALTER TABLE "graph_followups" ENABLE ROW LEVEL SECURITY;
