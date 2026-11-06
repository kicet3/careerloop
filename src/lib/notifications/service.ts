import "server-only";
/**
 * 앱 안 알림 저장소(notifications). 오래 걸리는 백그라운드 작업(AI 이력서 초안·진단·공고 가져오기·면접 질문)이 끝나면
 * notify()로 만들고, 상단 알림 버튼(NotificationBell)이 GET /api/notifications를 폴링한다.
 *
 * - 모든 조회·변경은 userId로 소유를 건다(남의 알림은 보이지도, 읽음 처리되지도 않는다).
 * - 새 알림을 넣을 때 사용자당 최근 MAX_NOTIFICATIONS_PER_USER개만 남기고 지운다.
 * - notify()는 던지지 않는다 — 알림 실패가 작업 결과 저장을 되돌리면 안 된다(로그만 남긴다).
 */
import { nanoid } from "nanoid";
import { prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import {
  MAX_NOTIFICATION_BODY_CHARS,
  MAX_NOTIFICATION_TITLE_CHARS,
  MAX_NOTIFICATIONS_PER_USER,
  NOTIFICATION_KINDS,
  NOTIFICATION_LIST_LIMIT,
  safeNotificationLink,
  type NotificationItem,
  type NotificationKind,
  type NotificationListResponse,
} from "@/lib/domain/notifications";

export interface NewNotification {
  kind: NotificationKind;
  title: string;
  body?: string;
  /** 앱 안 경로(/app/...). 그 밖의 값은 버린다. */
  link?: string | null;
}

const oneLine = (s: string, max: number) => {
  const t = stripNul(s).replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

type Row = { id: string; kind: string; title: string; body: string; link: string | null; readAt: Date | null; createdAt: Date };

function toItem(r: Row): NotificationItem {
  return {
    id: r.id,
    kind: (NOTIFICATION_KINDS as readonly string[]).includes(r.kind) ? (r.kind as NotificationKind) : "resume-draft-completed",
    title: r.title,
    body: r.body,
    link: safeNotificationLink(r.link),
    readAt: r.readAt?.getTime() ?? null,
    createdAt: r.createdAt.getTime(),
  };
}

/** 알림을 만들고 오래된 것을 정리한다. 실패하면 던진다(작업 경로에서는 notify()를 쓴다). */
export async function createNotification(userId: string, n: NewNotification, now: Date = new Date()): Promise<NotificationItem> {
  const row = await prisma.notification.create({
    data: {
      id: nanoid(),
      userId,
      kind: n.kind,
      title: oneLine(n.title, MAX_NOTIFICATION_TITLE_CHARS) || "알림",
      body: oneLine(n.body ?? "", MAX_NOTIFICATION_BODY_CHARS),
      link: safeNotificationLink(n.link),
      createdAt: now,
    },
  });
  await pruneNotifications(userId);
  return toItem(row);
}

/** 백그라운드 작업용: 알림을 만들되 실패해도 던지지 않는다. */
export async function notify(userId: string, n: NewNotification): Promise<void> {
  try {
    await createNotification(userId, n);
  } catch (err) {
    console.error("[notify] 알림 저장 실패", n.kind, (err as Error).message?.slice(0, 200));
  }
}

/** 사용자당 최근 keep개만 남긴다. 지운 개수. */
export async function pruneNotifications(userId: string, keep: number = MAX_NOTIFICATIONS_PER_USER): Promise<number> {
  const old = await prisma.notification.findMany({
    select: { id: true },
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    skip: keep,
    take: 1000,
  });
  if (old.length === 0) return 0;
  const { count } = await prisma.notification.deleteMany({ where: { userId, id: { in: old.map((o) => o.id) } } });
  return count;
}

/**
 * 최근 알림 + 읽지 않은 수. since(ms)를 주면 그 시각 뒤에 만든 알림만(폴링용 — 읽지 않은 수는 항상 전체).
 */
export async function listNotifications(
  userId: string,
  opts: { since?: number | null; limit?: number } = {},
): Promise<NotificationListResponse> {
  const limit = Math.min(Math.max(1, opts.limit ?? NOTIFICATION_LIST_LIMIT), NOTIFICATION_LIST_LIMIT);
  const since = typeof opts.since === "number" && Number.isFinite(opts.since) && opts.since > 0 ? new Date(opts.since) : null;
  const [rows, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where: { userId, ...(since ? { createdAt: { gt: since } } : {}) },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: limit,
    }),
    prisma.notification.count({ where: { userId, readAt: null } }),
  ]);
  return { items: rows.map(toItem), unreadCount };
}

/** 읽음 처리. ids를 주면 그 알림만(남의 것은 건너뛴다), "all"이면 모두. 바꾼 개수. */
export async function markNotificationsRead(userId: string, target: { ids: string[] } | "all", now: Date = new Date()): Promise<number> {
  if (target !== "all" && target.ids.length === 0) return 0;
  const { count } = await prisma.notification.updateMany({
    where: { userId, readAt: null, ...(target === "all" ? {} : { id: { in: target.ids } }) },
    data: { readAt: now },
  });
  return count;
}
