"use client";
/**
 * 알림 상태(탭 하나에 하나). 상단 알림 버튼은 넓은 화면·좁은 화면에 하나씩 그려지지만 이 저장소를 함께 써서 연결은 하나만 한다.
 * - 알림은 DB가 기준이다. 처음에 GET /api/notifications로 최근 목록을 한 번 받고(state 맞추기), 그 뒤 새 알림은
 *   SSE(GET /api/notifications/stream)로 받는다. 탭이 보이는 동안만 연결하고, 숨겨지면 닫고, 다시 보이거나 포커스가 오면 연다.
 *   서버가 함수 시간 상한 전에 닫으면 EventSource가 Last-Event-ID로 다시 연결한다. 응답이 아예 실패하면(401 등) 간격을 늘려 다시 연다.
 * - EventSource가 없는 브라우저만 느린 폴링(FALLBACK_POLL_MS)으로 대신한다.
 * - 처음 불러온 뒤 새로 온 읽지 않은 알림은 토스트 후보(toasts)로 쌓는다.
 * - pokeNotifications(): 다른 화면이 작업이 끝난 걸 알았을 때 바로 새로 받게 한다.
 */
import { useSyncExternalStore } from "react";
import {
  NOTIFICATION_STREAM_EVENTS,
  parseStreamCursor,
  type NotificationItem,
  type NotificationListResponse,
  type NotificationStreamItem,
  type NotificationStreamUnread,
} from "@/lib/domain/notifications";
import { applyRead, mergeNotifications, mergeStreamNotifications, nextSince, streamSince } from "./merge";

/** EventSource가 없을 때의 폴링 간격. */
export const FALLBACK_POLL_MS = 60_000;
/** 포커스·표시 전환으로 부르는 폴링의 최소 간격(폴링 대체 모드). */
const MIN_GAP_MS = 5_000;
/** 스트림이 아예 실패했을 때(EventSource CLOSED) 다시 여는 대기. */
const REOPEN_DELAYS_MS = [5_000, 15_000, 60_000, 300_000];
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
let source: EventSource | null = null;
let opening = false;
/** 마지막으로 받은 스트림 이벤트 id(커서, ms). 다시 열 때 ?since=로 쓴다. */
let lastEventId: number | null = null;
let reopenTimer: ReturnType<typeof setTimeout> | null = null;
let reopenAttempts = 0;
/** 보내는 중인 읽음 요청 수(그동안 스트림의 읽지 않은 수는 화면 값을 되돌릴 수 있어 무시한다). */
let pendingReads = 0;

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

/**
 * 스트림으로 받은 새 알림을 합친다. 처음 보는 알림 중 읽지 않은 것만 토스트로 띄우고 읽지 않은 수를 그만큼 올린다
 * (곧 "unread" 이벤트가 맞춘다). 이미 읽은 알림은 목록에만 읽음 상태로 붙인다.
 */
export function receiveStreamNotifications(incoming: NotificationStreamItem[]): void {
  const { items, fresh, added } = mergeStreamNotifications(state.items, incoming);
  if (added === 0) return;
  if (fresh.length === 0) return set({ items });
  set({
    items,
    unreadCount: state.unreadCount + fresh.length,
    toasts: [...fresh, ...state.toasts.filter((t) => !fresh.some((n) => n.id === t.id))].slice(0, MAX_TOASTS),
  });
}

/** 스트림의 읽지 않은 수(DB 값). 읽음 요청을 보내는 중이면 화면 값을 되돌리지 않게 무시한다. */
export function receiveStreamUnread(unreadCount: number): void {
  if (pendingReads > 0 || !Number.isFinite(unreadCount) || unreadCount < 0) return;
  if (unreadCount !== state.unreadCount) set({ unreadCount });
}

/** 다른 화면이 백그라운드 작업이 끝난 걸 알았을 때(예: 초안 진행 화면) 바로 새 알림을 받는다. */
export function pokeNotifications(): void {
  if (listeners.size > 0) void pollNotifications();
}

async function postRead(body: { ids: string[] } | { all: true }): Promise<void> {
  pendingReads++;
  try {
    await fetch("/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  } catch {
    // 다음 목록 요청·스트림의 읽지 않은 수가 서버 값으로 맞춘다.
  } finally {
    pendingReads--;
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

function canStream(): boolean {
  return typeof EventSource !== "undefined";
}

function visible(): boolean {
  return document.visibilityState === "visible";
}

function closeStream() {
  source?.close();
  source = null;
  if (reopenTimer) clearTimeout(reopenTimer);
  reopenTimer = null;
}

function scheduleReopen() {
  if (reopenTimer || listeners.size === 0) return;
  const delay = REOPEN_DELAYS_MS[Math.min(reopenAttempts, REOPEN_DELAYS_MS.length - 1)]!;
  reopenAttempts++;
  reopenTimer = setTimeout(() => {
    reopenTimer = null;
    void openStream();
  }, delay);
}

function parseData<T>(e: Event): T | null {
  try {
    return JSON.parse((e as MessageEvent<string>).data) as T;
  } catch {
    return null;
  }
}

function trackCursor(e: Event) {
  const id = parseStreamCursor((e as MessageEvent).lastEventId);
  if (id !== null) lastEventId = Math.max(lastEventId ?? 0, id);
}

/** 탭이 보이고 구독자가 있으면 스트림을 연다. 처음이면 목록을 먼저 한 번 받는다. */
async function openStream(): Promise<void> {
  if (source || opening || reopenTimer || listeners.size === 0 || !visible()) return;
  opening = true;
  try {
    if (!state.loaded) await pollNotifications();
  } finally {
    opening = false;
  }
  if (source || listeners.size === 0 || !visible()) return;
  if (!state.loaded) {
    scheduleReopen();
    return;
  }
  const since = streamSince(lastEventId, state.items);
  const es = new EventSource(`/api/notifications/stream${since !== null ? `?since=${since}` : ""}`);
  source = es;
  es.addEventListener("open", () => {
    reopenAttempts = 0;
  });
  es.addEventListener(NOTIFICATION_STREAM_EVENTS.notification, (e) => {
    if (source !== es) return;
    trackCursor(e);
    const item = parseData<NotificationStreamItem>(e);
    if (item && typeof item.id === "string") receiveStreamNotifications([item]);
  });
  es.addEventListener(NOTIFICATION_STREAM_EVENTS.unread, (e) => {
    if (source !== es) return;
    trackCursor(e);
    const data = parseData<NotificationStreamUnread>(e);
    if (data) receiveStreamUnread(data.unreadCount);
  });
  es.addEventListener("error", () => {
    // CONNECTING이면 브라우저가 Last-Event-ID로 다시 연결한다. CLOSED(401·잘못된 응답)면 간격을 늘려 직접 다시 연다.
    if (source !== es || es.readyState !== EventSource.CLOSED) return;
    source = null;
    es.close();
    scheduleReopen();
  });
}

function onVisibility() {
  if (!canStream()) return onWakePoll();
  if (visible()) void openStream();
  else closeStream();
}

function onFocus() {
  if (!canStream()) return onWakePoll();
  void openStream();
}

function onWakePoll() {
  if (!visible()) return;
  if (Date.now() - lastPollAt < MIN_GAP_MS) return;
  void pollNotifications();
}

function start() {
  if (canStream()) {
    if (visible()) void openStream();
    else void pollNotifications();
  } else {
    void pollNotifications();
    timer = setInterval(() => {
      if (visible()) void pollNotifications();
    }, FALLBACK_POLL_MS);
  }
  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
}

function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  closeStream();
  reopenAttempts = 0;
  document.removeEventListener("visibilitychange", onVisibility);
  window.removeEventListener("focus", onFocus);
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
