"use client";
/**
 * 알림 상태(탭 하나에 하나). 상단 알림 버튼은 넓은 화면·좁은 화면에 하나씩 그려지지만 이 저장소를 함께 써서 폴링은 한 번만 한다.
 * - 구독자가 있는 동안 POLL_MS마다 GET /api/notifications?since=를 부른다(탭이 숨겨져 있으면 건너뛴다).
 *   탭이 다시 보이거나 창에 포커스가 오면 곧바로 한 번 부른다. 서버리스라 웹소켓 대신 폴링이다.
 * - 처음 불러온 뒤 새로 온 읽지 않은 알림은 토스트 후보(toasts)로 쌓는다.
 * - pokeNotifications(): 다른 화면이 작업이 끝난 걸 알았을 때 바로 새로 받게 한다.
 */
import { useSyncExternalStore } from "react";
import type { NotificationItem, NotificationListResponse } from "@/lib/domain/notifications";
import { applyRead, mergeNotifications, nextSince } from "./merge";

export const POLL_MS = 25_000;
/** 포커스·표시 전환으로 부르는 폴링의 최소 간격. */
const MIN_GAP_MS = 5_000;
const MAX_TOASTS = 3;

export interface NotificationState {
  items: NotificationItem[];
  unreadCount: number;
  loaded: boolean;
  /** 마지막 요청이 실패했는가. */
  error: boolean;
  toasts: NotificationItem[];
}

const EMPTY: NotificationState = { items: [], unreadCount: 0, loaded: false, error: false, toasts: [] };
let state: NotificationState = EMPTY;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
let inflight: Promise<void> | null = null;
let lastPollAt = 0;

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
  lastPollAt = Date.now();
  inflight = (async () => {
    const firstLoad = !state.loaded;
    const data = await fetchList(opts.full || firstLoad ? null : nextSince(state.items));
    if (!data) {
      set({ error: true });
      return;
    }
    const { items, fresh } = mergeNotifications(opts.full ? [] : state.items, data.items);
    // 전체 다시 받기는 토스트를 띄우지 않는다(이미 아는 알림이 'fresh'로 보인다). 처음 불러온 것도 띄우지 않는다.
    const known = new Set(state.items.map((n) => n.id));
    const toastable = firstLoad ? [] : (opts.full ? fresh.filter((n) => !known.has(n.id)) : fresh);
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

/** 다른 화면이 백그라운드 작업이 끝난 걸 알았을 때(예: 초안 진행 화면) 바로 새 알림을 받는다. */
export function pokeNotifications(): void {
  if (listeners.size > 0) void pollNotifications();
}

async function postRead(body: { ids: string[] } | { all: true }): Promise<void> {
  try {
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // 다음 폴링이 서버 값으로 맞춘다.
  }
}

/** 읽음 처리(화면 먼저 반영). */
export async function markNotificationsRead(ids: string[]): Promise<void> {
  const unread = ids.filter((id) => state.items.some((n) => n.id === id && n.readAt === null));
  if (unread.length === 0) return;
  set({ ...applyRead(state, unread, Date.now()), toasts: state.toasts.filter((t) => !unread.includes(t.id)) });
  await postRead({ ids: unread.slice(0, 100) });
}

/** 이 경로들로 가는 알림을 읽음으로(작업 화면이 결과를 이미 보여 줬을 때). 먼저 새 알림을 받는다. */
export async function markNotificationsReadByLink(links: string[]): Promise<void> {
  await pollNotifications();
  const ids = state.items.filter((n) => n.readAt === null && n.link !== null && links.includes(n.link)).map((n) => n.id);
  await markNotificationsRead(ids);
}

export async function markAllNotificationsRead(): Promise<void> {
  set({ ...applyRead(state, null, Date.now()), toasts: [] });
  await postRead({ all: true });
}

export function dismissToast(id: string): void {
  set({ toasts: state.toasts.filter((t) => t.id !== id) });
}

function onWake() {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - lastPollAt < MIN_GAP_MS) return;
  void pollNotifications();
}

function start() {
  void pollNotifications();
  timer = setInterval(() => {
    if (document.visibilityState === "visible") void pollNotifications();
  }, POLL_MS);
  document.addEventListener("visibilitychange", onWake);
  window.addEventListener("focus", onWake);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  document.removeEventListener("visibilitychange", onWake);
  window.removeEventListener("focus", onWake);
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (listeners.size === 1) start();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) stop();
  };
}

export function getNotificationState(): NotificationState {
  return state;
}

export function useNotifications(): NotificationState {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}
