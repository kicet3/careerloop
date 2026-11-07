#!/usr/bin/env node
/**
 * 경험 질문하기 문서 일괄 재색인(관리자). 앱의 관리자 라우트 POST /api/admin/rag/reindex를 cursor가 없어질 때까지 이어 부른다
 * (TypeScript 앱 코드를 그대로 쓰려고 스크립트가 직접 DB를 만지지 않는다).
 *
 *   APP_URL=https://… RAG_ADMIN_SESSION=<관리자 rp_session 쿠키 값> node scripts/rag-reindex.mjs [--user <userId>]
 *
 * 출력은 처리 개수와 cursor(사용자 id)뿐이다.
 */
const base = (process.env.APP_URL ?? "http://localhost:3000").replace(/\/$/, "");
const session = process.env.RAG_ADMIN_SESSION?.trim();
if (!session) {
  console.error("[rag-reindex] RAG_ADMIN_SESSION(관리자 세션 쿠키 값)이 필요합니다.");
  process.exit(1);
}
const userArg = process.argv.indexOf("--user");
const userId = userArg >= 0 ? process.argv[userArg + 1] : null;

let cursor = null;
let total = 0;
let stuck = 0;
for (;;) {
  const res = await fetch(`${base}/api/admin/rag/reindex`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: base, cookie: `rp_session=${session}` },
    body: JSON.stringify({ userId, cursor }),
  });
  if (!res.ok) {
    console.error(`[rag-reindex] 실패: HTTP ${res.status}`);
    process.exit(1);
  }
  const body = await res.json();
  total += body.processed ?? 0;
  console.log(`[rag-reindex] 처리 ${body.processed} (누적 ${total})${body.nextCursor ? ` · 이어서 ${body.nextCursor}` : ""}`);
  if (body.partialUserId) console.warn(`[rag-reindex] ${body.partialUserId}: 마감 안에 다 못 함 — 다음 호출에서 다시`);
  if (body.done === false && userId) {
    console.error("[rag-reindex] 이 사용자를 마감 안에 다 색인하지 못했습니다. 다시 실행해 주세요.");
    process.exit(1);
  }
  // 진전 없이 같은 자리에서 두 번 멈추면(한 사용자가 마감보다 오래 걸림) 끝없이 돌지 않는다.
  stuck = (body.processed ?? 0) === 0 && body.done === false ? stuck + 1 : 0;
  if (stuck >= 2) {
    console.error(`[rag-reindex] 진전이 없습니다(${body.partialUserId ?? "?"}). 이 사용자는 --user로 따로 확인해 주세요.`);
    process.exit(1);
  }
  if (body.done !== false && !body.nextCursor) break;
  cursor = body.nextCursor || null;
}
console.log("[rag-reindex] 완료");
