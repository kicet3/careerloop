import "server-only";
/**
 * DB(rate_events)에 기록하는 레이트 리밋. 메모리 리밋(rate-limit.ts)은 인스턴스마다 따로 세고 서버리스에서는 인스턴스가
 * 자주 바뀌어 긴 창(24시간)이 사실상 지켜지지 않으므로, 비용이 드는 기능(AI 초안·그래프 채팅·IP당 진단)은 여기서 센다.
 * 확인과 기록을 한 트랜잭션에서 하고, 같은 (bucket, key)는 트랜잭션 단위 advisory lock으로 줄 세운다 — Postgres의
 * READ COMMITTED에서는 "개수 세고 INSERT"를 한 문장으로 써도 동시 트랜잭션이 함께 통과할 수 있기 때문이다.
 * (pg_advisory_xact_lock은 트랜잭션이 끝나면 풀리므로 Supabase Transaction pooler에서도 안전하다.)
 */
import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";

export type DbRateLimit = { bucket: string; limit: number; windowMs: number };

/** AI 이력서 초안: 사용자당 24시간 30회. */
export const RESUME_DRAFT_LIMIT: DbRateLimit = { bucket: "resume-draft", limit: 30, windowMs: 24 * 60 * 60_000 };
/** 경험 그래프로 포트폴리오 만들기(다시 만들기·다시 시도 포함): 사용자당 24시간 20회. */
export const PORTFOLIO_DRAFT_LIMIT: DbRateLimit = { bucket: "portfolio-draft", limit: 20, windowMs: 24 * 60 * 60_000 };
/** 그래프 채팅 전송·재시도: 사용자당 10분 30회. */
export const GRAPH_CHAT_LIMIT: DbRateLimit = { bucket: "graph-chat", limit: 30, windowMs: 10 * 60_000 };
/** 그래프에 묻기 전송·재시도: 사용자당 10분 30회. */
export const GRAPH_QA_LIMIT: DbRateLimit = { bucket: "graph-qa", limit: 30, windowMs: 10 * 60_000 };
/** 이력서·포트폴리오로 그래프 채우기: 사용자당 24시간 10회(긴 문서 1건이 큰 LLM 호출 1회). */
export const GRAPH_IMPORT_LIMIT: DbRateLimit = { bucket: "graph-import", limit: 10, windowMs: 24 * 60 * 60_000 };
/** 진단 생성: IP당 24시간 20건(계정을 여러 개 만들어 하루 제한을 우회하는 것을 늦춘다). */
export const DIAGNOSIS_IP_LIMIT: DbRateLimit = { bucket: "diagnosis-ip", limit: 20, windowMs: 24 * 60 * 60_000 };

/** 면접 예상 질문 만들기(세션 생성·재생성): 사용자당 24시간 10회(이력서·포트폴리오·JD 전체가 들어가는 큰 LLM 호출 1회). */
export const INTERVIEW_GENERATE_LIMIT: DbRateLimit = { bucket: "interview-generate", limit: 10, windowMs: 24 * 60 * 60_000 };
/** 면접 답변 피드백(제출·재시도): 사용자당 10분 20회(연타 방지). */
export const INTERVIEW_FEEDBACK_LIMIT: DbRateLimit = { bucket: "interview-feedback", limit: 20, windowMs: 10 * 60_000 };
/** 면접 답변 피드백: 사용자당 24시간 120회(하루 비용 상한). 위 10분 제한과 함께 센다. */
export const INTERVIEW_FEEDBACK_DAILY_LIMIT: DbRateLimit = { bucket: "interview-feedback-day", limit: 120, windowMs: 24 * 60 * 60_000 };
/**
 * 포트폴리오 파일 올리기(텍스트 추출) — 보관함에 새로 올리기·내용 바꾸기·이력서 화면에서 바로 올리기를 함께 센다: 사용자당 24시간 30회.
 * 링크 첨부·이름 고치기·삭제는 세지 않는다. 버킷 이름은 예전 이력서 첨부 업로드와 같다(이어서 센다).
 */
export const PORTFOLIO_UPLOAD_LIMIT: DbRateLimit = { bucket: "resume-portfolio", limit: 30, windowMs: 24 * 60 * 60_000 };
/** 프로필 사진 올리기·바꾸기(사용자당 24시간). 사진마다 서버에서 다시 인코딩하므로 넉넉하지만 끝은 둔다. */
export const PROFILE_PHOTO_LIMIT: DbRateLimit = { bucket: "profile-photo", limit: 20, windowMs: 24 * 60 * 60_000 };
/** 공고 원문 캡처 '다시 시도': 사용자당 24시간 10회(헤드리스 브라우저 1회가 무겁다). */
export const POSTING_CAPTURE_RETRY_LIMIT: DbRateLimit = { bucket: "posting-capture-retry", limit: 10, windowMs: 24 * 60 * 60_000 };
/** 공고 원문 캡처: 공용 공고(key=sharedPostingId)당 1시간 3회(여러 사용자가 같은 공고를 연달아 다시 찍지 않게). 자동 캡처도 센다. */
export const POSTING_CAPTURE_TARGET_LIMIT: DbRateLimit = { bucket: "posting-capture-target", limit: 3, windowMs: 60 * 60_000 };

/** MCP(외부 AI 앱의 경험 그래프 읽기) 요청: 사용자당 10분 300회(LLM 비용은 없지만 Neo4j 읽기·DB 조회를 막는다). */
export const MCP_REQUEST_LIMIT: DbRateLimit = { bucket: "mcp", limit: 300, windowMs: 10 * 60_000 };

/** GitHub 연결 시작: 사용자당 1시간 10회. */
export const GITHUB_CONNECT_LIMIT: DbRateLimit = { bucket: "github-connect", limit: 10, windowMs: 60 * 60_000 };
/** GitHub 저장소 정보 새로 읽기(실제로 GitHub을 부를 때만 센다 — 저장해 둔 정보 재사용은 세지 않는다): 사용자당 1시간 30회. */
export const GITHUB_SYNC_LIMIT: DbRateLimit = { bucket: "github-sync", limit: 30, windowMs: 60 * 60_000 };
/** GitHub 저장소로 프로젝트 정리 시작(LLM 호출 1회)·그 재시도: 사용자당 24시간 20회. */
export const GITHUB_IMPORT_LIMIT: DbRateLimit = { bucket: "github-import", limit: 20, windowMs: 24 * 60 * 60_000 };

/** IP는 원문 대신 해시로 저장한다. */
export function ipKey(ip: string): string {
  return createHash("sha256").update(`ip:${ip}`).digest("base64url").slice(0, 32);
}

/** 시도 1회를 기록하고 허용 여부를 돌려준다. 한도를 넘으면 기록하지 않는다. */
export async function hitDbLimit(
  rule: DbRateLimit,
  key: string,
  now: number = Date.now(),
): Promise<{ ok: boolean; retryAfterSec: number }> {
  const since = new Date(now - rule.windowMs);
  const where = { bucket: rule.bucket, key };
  const oldest = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`rate:${rule.bucket}:${key}`}, 0))`;
    // 창이 지난 기록은 지운다(같은 키만 — 인덱스로 좁힌다).
    await tx.rateEvent.deleteMany({ where: { ...where, createdAt: { lte: since } } });
    const agg = await tx.rateEvent.aggregate({
      where: { ...where, createdAt: { gt: since } },
      _count: { _all: true },
      _min: { createdAt: true },
    });
    if (agg._count._all < rule.limit) {
      await tx.rateEvent.create({ data: { ...where, createdAt: new Date(now) } });
      return null;
    }
    return agg._min.createdAt ?? new Date(now);
  });
  if (!oldest) return { ok: true, retryAfterSec: 0 };
  return { ok: false, retryAfterSec: Math.max(1, Math.ceil((oldest.getTime() + rule.windowMs - now) / 1000)) };
}

/**
 * 한 번만 쓰는 표(같은 bucket·key는 windowMs 안에 한 번만 true). 레이트 리밋과 같은 rate_events 표·advisory lock을 쓴다.
 * 키마다 새 행이 생기므로 같은 bucket의 창이 지난 행을 함께 지운다(bucket 접두 인덱스).
 * 예: R2 직접 업로드의 uploadId 하나를 두 번 마무리하지 못하게(서명 주소는 유효 시간 동안 다시 쓸 수 있다).
 */
export async function consumeOnceDb(bucket: string, key: string, windowMs: number, now: number = Date.now()): Promise<boolean> {
  const since = new Date(now - windowMs);
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`once:${bucket}:${key}`}, 0))`;
    await tx.rateEvent.deleteMany({ where: { bucket, createdAt: { lte: since } } });
    const used = await tx.rateEvent.count({ where: { bucket, key, createdAt: { gt: since } } });
    if (used > 0) return false;
    await tx.rateEvent.create({ data: { bucket, key, createdAt: new Date(now) } });
    return true;
  });
}
