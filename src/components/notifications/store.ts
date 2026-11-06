"use client";
/**
 * 알림 상태(탭 하나에 하나). 상단 알림 버튼은 넓은 화면·좁은 화면에 하나씩 그려지지만 이 저장소를 함께 써서 요청은 한 번만 한다.
 * - 알림은 DB가 기준이다. 주기 폴링·SSE·탭 표시/포커스 때 다시 받기는 없다.
 *   새 알림은 사용자가 새로고침(앱 틀을 다시 불러오기)하거나 알림 패널을 열 때 보인다. Supabase Realtime이 설정돼 있으면
 *   새 알림 신호(알림 id뿐)가 올 때 pollNotificationsLive()로 바로 받는다(./realtime.ts — NotificationsProvider가 연결한다).
 * - 받는 때: (1) 앱 틀이 그려질 때 한 번(새로고침, 또는 앱 밖에 갔다가 돌아와 틀이 다시 그려질 때 — GET /api/notifications, 서버가 끊긴 작업도 함께 정리한다),
 *   (2) 알림 패널을 열 때(전체 다시 받기), (3) pokeNotifications()/markNotificationsReadByLink()를 부를 때(다른 화면이
 *   작업이 끝난 걸 직접 확인했을 때 한 번).
 * - 읽지 않은 수는 앱 레이아웃이 서버에서 세어 NotificationsProvider로 넘긴다(첫 목록을 받기 전 배지 — ./NotificationsProvider.tsx).
 * - 처음 불러온 뒤 새로 받은 읽지 않은 알림은 토스트 후보(toasts)로 쌓는다(처음 불러온 것·패널 전체 다시 받기로 이미 아는 것은 띄우지 않는다).
 */
import { useSyncExternalStore } from "react";
import type { NotificationItem, NotificationListResponse } from "@/lib/domain/notifications";
import { applyRead, mergeNotifications, nextSince } from "./merge";

const MAX_TOASTS = 3;

export interface NotificationState {
  items: NotificationItem[];
  unreadCount: number;
  loaded: boolean;
  /** 마지막 요청이 실패했는가. */
  error: boolean;
  /** 목록을 받기 전에 화면에서 읽지 않은 수를 바꿨는가(예: 첫 요청 실패 뒤 '모두 읽음'). 그러면 배지는 서버에서 센 첫 값 대신 저장소 값을 쓴다. */
  locallyChanged: boolean;
  toasts: NotificationItem[];
}

const EMPTY: NotificationState = { items: [], unreadCount: 0, loaded: false, error: false, locallyChanged: false, toasts: [] };
let state: NotificationState = EMPTY;
const listeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

function set(next: Partial<NotificationState>) {
  state = { ...state, ...next };
  listeners.forEach((l) => l());
}

async function fetchList(since: number | null): Promise<NotificationListResponse | null> {
  try {
    const res = await fetch(`/api/notifications${since !== null ? `?since=${since}` : ""}`, { cache: "no-store" });
    if (!res.ok) return null;
    return (await res.json()) as NotificationListResponse;
  } catch {
    return null;
  }
}

/** 새 알림 받기. full이면 since 없이 최근 목록 전체를 다시 받는다. 겹친 호출은 하나로 합친다. */
export function pollNotifications(opts: { full?: boolean } = {}): Promise<void> {
  if (inflight) return inflight;
  inflight = (async () => {
    const firstLoad = !state.loaded;
    const data = await fetchList(opts.full || firstLoad ? null : nextSince(state.items));
    if (!data) {
      set({ error: true });
      return;
    }
    const { items, fresh } = mergeNotifications(opts.full ? [] : state.items, data.items);
    // 전체 다시 받기는 이미 아는 알림을 토스트로 띄우지 않는다(이미 아는 알림이 'fresh'로 보인다). 처음 불러온 것도 띄우지 않는다.
    const known = new Set(state.items.map((n) => n.id));
    const toastable = firstLoad ? [] : opts.full ? fresh.filter((n) => !known.has(n.id)) : fresh;
    set({
      items,
      unreadCount: data.unreadCount,
      loaded: true,
      error: false,
      toasts: [...toastable, ...state.toasts.filter((t) => !toastable.some((n) => n.id === t.id))].slice(0, MAX_TOASTS),
    });
  })().finally(() => {
    inflight = null;
  });
  return inflight;
}

let queued: Promise<void> | null = null;

/**
 * 실시간 신호(새 알림 id)를 받았을 때: 새 알림을 받는다. 이미 요청 중이면 그 요청이 신호 전에 시작됐을 수 있어 끝난 뒤 한 번 더 받는다
 * (신호가 여러 번 와도 뒤따르는 요청은 하나).
 */
export function pollNotificationsLive(): Promise<void> {
  if (!inflight) return pollNotifications();
  if (!queued) {
    queued = inflight.then(() => {
      queued = null;
      return pollNotifications();
    });
  }
  return queued;
}

/**
 * 알림 패널을 열 때: 최근 목록 전체를 다시 받고(서버가 끊긴 작업도 정리한다) 그때 읽지 않은 알림 id를 돌려준다
 * (패널이 강조 표시하고 읽음으로 바꾼다). 실패하면 아는 목록 기준.
 */
export async function refreshNotificationsForPanel(): Promise<string[]> {
  await pollNotifications({ full: true });
  return state.items.filter((n) => n.readAt === null).map((n) => n.id);
}

/** 다른 화면이 백그라운드 작업이 끝난 걸 알았을 때(예: 초안 목록) 한 번 새 알림을 받는다(주기 폴링은 아니다). */
export function pokeNotifications(): void {
  if (listeners.size > 0) void pollNotifications();
}

async function postRead(body: { ids: string[] } | { all: true }): Promise<void> {
  try {
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // 다음 목록 요청(패널 열기·새로고침)이 서버 값으로 맞춘다.
  }
}

/** 읽음 처리(화면 먼저 반영). */
export async function markNotificationsRead(ids: string[]): Promise<void> {
  const unread = ids.filter((id) => state.items.some((n) => n.id === id && n.readAt === null));
  if (unread.length === 0) return;
  set({ ...applyRead(state, unread, Date.now()), locallyChanged: true, toasts: state.toasts.filter((t) => !unread.includes(t.id)) });
  await postRead({ ids: unread.slice(0, 100) });
}

/** 이 경로들로 가는 알림을 읽음으로(작업 화면이 결과를 이미 보여 줬을 때). 먼저 새 알림을 받는다. */
export async function markNotificationsReadByLink(links: string[]): Promise<void> {
  await pollNotifications();
  const ids = state.items.filter((n) => n.readAt === null && n.link !== null && links.includes(n.link)).map((n) => n.id);
  await markNotificationsRead(ids);
}

export async function markAllNotificationsRead(): Promise<void> {
  set({ ...applyRead(state, null, Date.now()), locallyChanged: true, toasts: [] });
  await postRead({ all: true });
}

export function dismissToast(id: string): void {
  set({ toasts: state.toasts.filter((t) => t.id !== id) });
}

function subscribe(listener: () => void) {
  const first = listeners.size === 0;
  listeners.add(listener);
  // 앱 틀이 그려질 때(구독자 0 → 1) 받는다. 앱 안 화면 이동은 틀을 다시 그리지 않아 다시 받지 않는다. 앱 밖(/terms 등)에 갔다가
  // 링크·뒤로 가기로 돌아오면 틀이 다시 그려지므로 최근 목록 전체를 다시 받는다(서버가 끊긴 작업도 정리 — 새로고침과 같은 효과).
  // 버튼 두 개가 함께 구독해도 첫 구독 때 한 번이고, 겹친 요청은 하나로 합친다.
  if (first && !inflight) void pollNotifications({ full: state.loaded });
  return () => {
    listeners.delete(listener);
  };
}

export function getNotificationState(): NotificationState {
  return state;
}

export function useNotifications(): NotificationState {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}
