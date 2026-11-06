/**
 * 알림 목록 합치기(순수 — 테스트 대상). 목록 API로 받은 알림은 같은 id를 새 값으로 바꾸고, SSE로 받은 새 알림은 처음 보는 것만 붙인다.
 */
import type { NotificationItem, NotificationStreamItem } from "@/lib/domain/notifications";

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

/**
 * SSE "notification" 이벤트로 받은 알림을 합친다. 이미 아는 id는 그대로 둔다(다시 연결할 때 겹쳐 다시 오는 알림이
 * 화면에서 먼저 읽음 처리한 상태를 되돌리지 않게). 처음 보는 알림은 서버의 readAt 그대로 붙이고(다른 탭·기기에서 이미 읽었을 수 있다),
 * fresh는 그중 읽지 않은 것(토스트·배지 후보 — mergeNotifications와 같은 규칙). added는 목록에 새로 붙은 개수.
 */
export function mergeStreamNotifications(
  prev: readonly NotificationItem[],
  incoming: readonly NotificationStreamItem[],
  limit = 30,
): { items: NotificationItem[]; fresh: NotificationItem[]; added: number } {
  const known = new Set(prev.map((n) => n.id));
  const added: NotificationItem[] = [];
  for (const n of incoming) {
    if (known.has(n.id)) continue;
    known.add(n.id);
    added.push({ ...n, readAt: typeof n.readAt === "number" ? n.readAt : null });
  }
  if (added.length === 0) return { items: [...prev], fresh: [], added: 0 };
  const fresh = added.filter((n) => n.readAt === null).sort(byRecent);
  return { items: [...prev, ...added].sort(byRecent).slice(0, limit), fresh, added: added.length };
}

/** 스트림 재연결 커서: 마지막으로 받은 이벤트 id와 아는 알림 중 가장 최근 시각 중 큰 값. 둘 다 없으면 null. */
export function streamSince(lastEventId: number | null, items: readonly NotificationItem[]): number | null {
  const latest = items.length > 0 ? Math.max(...items.map((n) => n.createdAt)) : 0;
  const since = Math.max(lastEventId ?? 0, latest);
  return since > 0 ? since : null;
}

/** 다음 폴링의 since(가장 최근 알림 시각 - 1초 겹침, 같은 ms 알림을 놓치지 않게 — 겹친 것은 id로 거른다). 목록이 비었으면 null. */
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
