/**
 * 알림 목록 합치기(순수 — 테스트 대상). 목록 API로 받은 알림은 같은 id를 새 값으로 바꾼다.
 */
import type { NotificationItem } from "@/lib/domain/notifications";

/** 최근 순 정렬(같은 시각이면 id 역순 — 서버 정렬과 같다). */
function byRecent(a: NotificationItem, b: NotificationItem): number {
  return b.createdAt - a.createdAt || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0);
}

/**
 * prev에 incoming을 합친다. fresh는 prev에 없던 알림(토스트로 띄울 후보) 중 읽지 않은 것.
 */
export function mergeNotifications(
  prev: readonly NotificationItem[],
  incoming: readonly NotificationItem[],
  limit = 30,
): { items: NotificationItem[]; fresh: NotificationItem[] } {
  const known = new Map(prev.map((n) => [n.id, n]));
  const fresh: NotificationItem[] = [];
  for (const n of incoming) {
    if (!known.has(n.id) && n.readAt === null) fresh.push(n);
    known.set(n.id, n);
  }
  return { items: [...known.values()].sort(byRecent).slice(0, limit), fresh: fresh.sort(byRecent) };
}

/** 다음 목록 요청의 since(가장 최근 알림 시각 - 1초 겹침, 같은 ms 알림을 놓치지 않게 — 겹친 것은 id로 거른다). 목록이 비었으면 null. */
export function nextSince(items: readonly NotificationItem[]): number | null {
  if (items.length === 0) return null;
  return Math.max(0, Math.max(...items.map((n) => n.createdAt)) - 1000);
}

/** 읽음 처리를 화면에 먼저 반영한다(ids가 null이면 모두). 읽지 않은 수도 그만큼 줄인다. */
export function applyRead(
  state: { items: NotificationItem[]; unreadCount: number },
  ids: readonly string[] | null,
  at: number,
): { items: NotificationItem[]; unreadCount: number } {
  if (ids === null) return { items: state.items.map((n) => (n.readAt === null ? { ...n, readAt: at } : n)), unreadCount: 0 };
  const set = new Set(ids);
  let changed = 0;
  const items = state.items.map((n) => {
    if (n.readAt !== null || !set.has(n.id)) return n;
    changed++;
    return { ...n, readAt: at };
  });
  return { items, unreadCount: Math.max(0, state.unreadCount - changed) };
}
