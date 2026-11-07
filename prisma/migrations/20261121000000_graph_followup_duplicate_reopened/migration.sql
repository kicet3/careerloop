-- 후속 질문 정리(reconcileProjectFollowups) 보조 컬럼.
-- duplicate_of: 먼저 연 질문과 같은 것을 바꿔 물어 자동으로 건너뜀(skipped)이 된 질문이 가리키는 그 열린 질문 id. 이런 행은 "사용자가 건너뛴 주제"로
--   세지 않는다(세면 원래 열린 질문까지 연쇄로 건너뜀이 된다). 사용자가 상태를 바꾸면 비운다.
-- reopened_at: 사용자가 다시 연 시각. 다시 연 질문은 자동 정리(채운 주제·같은 것을 묻는 질문 답함)로 닫지 않는다.
-- 예전 행은 둘 다 null.

-- AlterTable
ALTER TABLE "graph_followups" ADD COLUMN "duplicate_of" TEXT,
ADD COLUMN "reopened_at" TIMESTAMPTZ(3);
