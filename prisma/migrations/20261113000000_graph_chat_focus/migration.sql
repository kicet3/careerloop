-- 프로젝트 단위 그래프 채팅: 경험 그래프의 Project 노드 하나에 집중한 대화(kind='graph')는 그 노드 id(Neo4j)를 둔다.
-- 그래프는 Neo4j에 있어 외래 키를 걸 수 없다 — 노드가 지워지면 화면·답변이 '찾을 수 없음'으로 처리한다(src/lib/chat/graph-chat.ts).
-- 일반 대화는 NULL.

-- AlterTable
ALTER TABLE "chat_threads" ADD COLUMN "focus_node_id" TEXT;
