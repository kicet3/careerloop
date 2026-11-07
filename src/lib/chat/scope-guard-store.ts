import "server-only";
/**
 * 경험 대화 범위 가드레일의 기록·차단(scope-guard.ts의 서버 쪽). 범위 밖 판정 1회마다 rate_events(bucket CHAT_SCOPE_GUARD.bucket,
 * key=userId)에 한 줄을 남기고, 창 안에서 limit번이 쌓이면 경험 정리하기·경험 질문하기 전송을 잠시 막는다(429).
 * 사용자 글은 저장하지 않는다 — 판정 내용(분류·규칙·짧은 사유)은 안내 메시지의 data(ScopeNoticeData)에, 운영 로그에는 id만 남긴다.
 * 탈퇴하면 rate_events의 key=userId 줄과 함께 지워진다(auth/account.ts).
 */
import { FeatureError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import type { ScopeNoticeData } from "@/lib/domain/chat";

/** 범위 밖 요청 누적 차단: 사용자당 1시간에 5번이면 그 1시간 창이 지날 때까지 막는다. */
export const CHAT_SCOPE_GUARD = { bucket: "chat-offtopic", limit: 5, windowMs: 60 * 60_000 } as const;

export type ScopeGuardRule = { bucket: string; limit: number; windowMs: number };

/** 범위 밖 판정 1회 기록(창이 지난 같은 키 줄은 지운다). 로그에는 사용자·스레드 id와 분류만. */
export async function recordScopeEvent(
  userId: string,
  ctx: { threadId: string; notice: ScopeNoticeData },
  rule: ScopeGuardRule = CHAT_SCOPE_GUARD,
  now: number = Date.now(),
): Promise<void> {
  const where = { bucket: rule.bucket, key: userId };
  await prisma.$transaction([
    prisma.rateEvent.deleteMany({ where: { ...where, createdAt: { lte: new Date(now - rule.windowMs) } } }),
    prisma.rateEvent.create({ data: { ...where, createdAt: new Date(now) } }),
  ]);
  console.warn(
    `[chat-guard] user=${userId} thread=${ctx.threadId} category=${ctx.notice.category} source=${ctx.notice.source}${ctx.notice.rule ? ` rule=${ctx.notice.rule}` : ""}`,
  );
}

/** 지금 막혀 있으면 풀릴 때까지 남은 초, 아니면 0. */
export async function scopeBlockRemainingSec(userId: string, rule: ScopeGuardRule = CHAT_SCOPE_GUARD, now: number = Date.now()): Promise<number> {
  const recent = await prisma.rateEvent.findMany({
    where: { bucket: rule.bucket, key: userId, createdAt: { gt: new Date(now - rule.windowMs) } },
    orderBy: { createdAt: "desc" },
    take: rule.limit,
    select: { createdAt: true },
  });
  if (recent.length < rule.limit) return 0;
  // 최근 limit번째 기록이 창을 벗어나면 limit 미만이 된다.
  const pivot = recent.at(-1)!.createdAt.getTime();
  return Math.max(1, Math.ceil((pivot + rule.windowMs - now) / 1000));
}

/** 누적 차단을 공유하는 기능(안내 문구만 다르다). */
export type ScopeGuardFeature = "chat" | "polish";

/** 차단 안내 문구(기능별). */
export function scopeBlockedMessage(wait: string, feature: ScopeGuardFeature = "chat"): string {
  return feature === "polish"
    ? `이력서 문구와 관련 없는 요청이 반복되어 AI로 다듬기를 잠시 멈췄습니다. ${wait} 뒤 다시 이용해 주세요. AI로 다듬기는 이 이력서 항목의 문구를 고치는 데만 쓸 수 있습니다.`
    : `경험 정리와 관련 없는 요청이 반복되어 경험 대화를 잠시 멈췄습니다. ${wait} 뒤 다시 이용해 주세요. 경험 대화는 내 경력·경험을 정리하고 그래프에 대해 묻는 데만 쓸 수 있습니다.`;
}

/** 막혀 있으면 429(FeatureError). 경험 정리하기·경험 질문하기·AI로 다듬기 전송·재시도 앞에서 부른다(feature로 안내 문구를 고른다). */
export async function assertNotScopeBlocked(
  userId: string,
  rule: ScopeGuardRule = CHAT_SCOPE_GUARD,
  now: number = Date.now(),
  opts: { feature?: ScopeGuardFeature } = {},
): Promise<void> {
  const sec = await scopeBlockRemainingSec(userId, rule, now);
  if (sec <= 0) return;
  const wait = sec >= 3600 ? `${Math.ceil(sec / 3600)}시간` : `${Math.max(1, Math.ceil(sec / 60))}분`;
  throw new FeatureError(scopeBlockedMessage(wait, opts.feature), 429);
}
