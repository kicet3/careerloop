"use client";
/**
 * 알림 실시간 수신(Supabase Realtime Broadcast, 비공개 채널) 클라이언트. 탭 하나에 연결 하나(모듈 전역).
 *
 * - GET /api/notifications/realtime-token이 404 등(설정 없음)이면 아무것도 하지 않는다 — 예전처럼 새로고침·패널 열기 때만 받는다.
 * - 받은 토큰으로 supabase-js 클라이언트를 만들고(accessToken 콜백) topic(notifications:<내 id>)을 private로 구독한다.
 *   "notification" 이벤트(내용은 알림 id뿐)가 오면 onNotification()으로 우리 API에서 다시 받는다(토스트는 저장소가 띄운다).
 * - 토큰은 만료 5분 전에 새로 받는다(타이머 + realtime-js가 하트비트마다 부르는 accessToken 콜백은 캐시를 돌려준다).
 * - 재연결은 realtime-js가 한다. 다시 구독되면(SUBSCRIBED) 놓친 알림을 한 번 받는다.
 * - 처음 구독이 거듭 실패하면(RLS 정책 없음·키 잘못 등) 조용히 닫고 새로고침 방식으로 남는다.
 * - 토큰 API가 401·403·404면(로그아웃·설정 없음) 멈추고, 그 밖의 실패는 백오프(1분→최대 15분)로 다시 받는다.
 * - 토큰 만료 등으로 서버가 채널을 닫으면(CLOSED) 새 토큰을 받아 다시 구독한다(횟수 제한).
 * - supabase-js는 설정이 있을 때만 동적으로 불러온다.
 */
import {
  NOTIFICATION_REALTIME_EVENT,
  NOTIFICATION_REALTIME_REFRESH_BEFORE_MS,
  type NotificationRealtimeToken,
} from "@/lib/domain/notifications-realtime";

/** 처음 SUBSCRIBED 전에 이만큼 실패하면 포기한다. */
export const MAX_INITIAL_FAILURES = 3;
/** 한 번 구독된 뒤 채널이 닫히면(토큰 만료 등) 이만큼까지 다시 구독한다(SUBSCRIBED 되면 다시 센다). */
export const MAX_RESUBSCRIBES = 5;
const MIN_REFRESH_DELAY_MS = 30_000;
/** 토큰 받기가 (일시적으로) 실패하면 이 간격부터 두 배씩, 최대 MAX까지 기다렸다 다시 받는다. 그 사이엔 API를 부르지 않는다. */
export const RETRY_TOKEN_DELAY_MS = 60_000;
export const MAX_RETRY_TOKEN_DELAY_MS = 15 * 60_000;

/** 401·403·404: 로그아웃·승인 취소·설정 없음 — 다시 시도해도 소용없으니 실시간 수신을 멈춘다. */
export class RealtimeTokenUnavailableError extends Error {
  constructor(readonly status: number) {
    super(`realtime token unavailable (${status})`);
    this.name = "RealtimeTokenUnavailableError";
  }
}

/** supabase-js에서 쓰는 부분만(테스트가 가짜로 바꾼다). */
export interface RealtimeChannelLike {
  on(type: "broadcast", filter: { event: string }, cb: (msg: unknown) => void): RealtimeChannelLike;
  subscribe(cb?: (status: string, err?: Error) => void): RealtimeChannelLike;
}
export interface RealtimeClientLike {
  channel(name: string, opts: { config: { private: boolean } }): RealtimeChannelLike;
  removeChannel(channel: RealtimeChannelLike): Promise<unknown>;
  realtime: { setAuth(token?: string | null): Promise<void>; disconnect(): unknown };
}
export type CreateRealtimeClient = (url: string, anonKey: string, opts: { accessToken: () => Promise<string> }) => RealtimeClientLike | Promise<RealtimeClientLike>;

export interface RealtimeDeps {
  onNotification: () => void;
  /** 토큰. 일시 실패는 null, 영구 실패(401·403·404)는 RealtimeTokenUnavailableError를 던진다. */
  fetchToken?: () => Promise<NotificationRealtimeToken | null>;
  createClient?: CreateRealtimeClient;
  now?: () => number;
}

export async function fetchRealtimeToken(): Promise<NotificationRealtimeToken | null> {
  let res: Response;
  try {
    res = await fetch("/api/notifications/realtime-token", { cache: "no-store" });
  } catch {
    return null;
  }
  if (res.status === 401 || res.status === 403 || res.status === 404) throw new RealtimeTokenUnavailableError(res.status);
  if (!res.ok) return null;
  try {
    const t = (await res.json()) as Partial<NotificationRealtimeToken>;
    if (typeof t.url !== "string" || typeof t.anonKey !== "string" || typeof t.token !== "string" || typeof t.topic !== "string" || typeof t.expiresAt !== "number") {
      return null;
    }
    return t as NotificationRealtimeToken;
  } catch {
    return null;
  }
}

const defaultCreateClient: CreateRealtimeClient = async (url, anonKey, opts) => {
  const { createClient } = await import("@supabase/supabase-js");
  return createClient(url, anonKey, { accessToken: opts.accessToken }) as unknown as RealtimeClientLike;
};

/**
 * 실시간 수신을 시작한다. 돌려준 함수로 멈춘다(구독 해제·연결 끊기·타이머 정리). 실패해도 던지지 않는다.
 */
export function startNotificationRealtime(deps: RealtimeDeps): () => void {
  const fetchToken = deps.fetchToken ?? fetchRealtimeToken;
  const createClient = deps.createClient ?? defaultCreateClient;
  const now = deps.now ?? Date.now;
  let stopped = false;
  let current: NotificationRealtimeToken | null = null;
  let refreshing: Promise<NotificationRealtimeToken | null> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let resubTimer: ReturnType<typeof setTimeout> | null = null;
  let client: RealtimeClientLike | null = null;
  let channel: RealtimeChannelLike | null = null;
  // 토큰 받기 실패 뒤 백오프: 이 시각 전에는 API를 부르지 않는다(하트비트 콜백·타이머 모두).
  let nextAttemptAt = 0;
  let retryDelay = RETRY_TOKEN_DELAY_MS;

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimer();
    if (resubTimer) clearTimeout(resubTimer);
    resubTimer = null;
    const c = client;
    const ch = channel;
    client = null;
    channel = null;
    if (c) {
      void (ch ? c.removeChannel(ch) : Promise.resolve())
        .catch(() => {})
        .finally(() => {
          try {
            c.realtime.disconnect();
          } catch {
            // 이미 끊겼다
          }
        });
    }
  };

  const refreshToken = (): Promise<NotificationRealtimeToken | null> => {
    if (stopped || now() < nextAttemptAt) return Promise.resolve(null);
    if (!refreshing) {
      refreshing = fetchToken()
        .catch((e: unknown) => {
          // 로그아웃·승인 취소·설정 없음: 계속 불러도 소용없다(세션 DB 조회·레이트 리밋만 쓴다).
          if (e instanceof RealtimeTokenUnavailableError) stop();
          return null;
        })
        .then((t) => {
          if (stopped) return null;
          if (t) {
            current = t;
            nextAttemptAt = 0;
            retryDelay = RETRY_TOKEN_DELAY_MS;
          } else {
            nextAttemptAt = now() + retryDelay;
            retryDelay = Math.min(retryDelay * 2, MAX_RETRY_TOKEN_DELAY_MS);
          }
          return t;
        })
        .finally(() => {
          refreshing = null;
        });
    }
    return refreshing;
  };

  const scheduleRefresh = () => {
    clearTimer();
    if (stopped || !current) return;
    const delay = Math.max(MIN_REFRESH_DELAY_MS, current.expiresAt - NOTIFICATION_REALTIME_REFRESH_BEFORE_MS - now());
    timer = setTimeout(() => {
      timer = null;
      void refreshToken().then((t) => {
        if (stopped) return;
        if (!t) {
          // 백오프 뒤 다시(영구 실패면 이미 멈췄다).
          timer = setTimeout(() => scheduleRefresh(), Math.max(1_000, nextAttemptAt - now()));
          return;
        }
        // 새 토큰을 연결에 바로 반영한다(accessToken 콜백이 새 캐시 값을 돌려준다).
        void client?.realtime.setAuth().catch(() => {});
        scheduleRefresh();
      });
    }, delay);
  };

  // realtime-js가 연결·하트비트(25초)마다 부른다 — 캐시를 돌려주고, 만료가 가까우면(백오프 중이 아니면) 새로 받는다.
  const accessToken = async (): Promise<string> => {
    if (current && current.expiresAt - now() > NOTIFICATION_REALTIME_REFRESH_BEFORE_MS) return current.token;
    const t = await refreshToken();
    return (t ?? current)?.token ?? "";
  };

  let everSubscribed = false;
  let failures = 0;
  let resubscribes = 0;

  const subscribe = (c: RealtimeClientLike, topic: string) => {
    const ch: RealtimeChannelLike = c
      .channel(topic, { config: { private: true } })
      .on("broadcast", { event: NOTIFICATION_REALTIME_EVENT }, () => {
        if (!stopped && channel === ch) deps.onNotification();
      })
      .subscribe((status) => {
        if (stopped || channel !== ch) return;
        if (status === "SUBSCRIBED") {
          failures = 0;
          resubscribes = 0;
          // 구독 전·끊긴 사이에 만든 알림을 놓치지 않게 한 번 받는다(이어 받기라 가볍다).
          deps.onNotification();
          everSubscribed = true;
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT") {
          failures += 1;
          if (!everSubscribed && failures >= MAX_INITIAL_FAILURES) stop();
        } else if (status === "CLOSED") {
          // 서버가 채널을 닫았다(토큰 만료 등) — realtime-js는 다시 구독하지 않으므로 직접 한다.
          if (!everSubscribed || resubscribes >= MAX_RESUBSCRIBES) {
            stop();
            return;
          }
          resubscribes += 1;
          channel = null;
          void c.removeChannel(ch).catch(() => {});
          resubscribeWhenTokenReady(c, topic);
        }
      });
    channel = ch;
  };

  const resubscribeWhenTokenReady = (c: RealtimeClientLike, topic: string) => {
    if (stopped) return;
    const valid = current && current.expiresAt - now() > NOTIFICATION_REALTIME_REFRESH_BEFORE_MS;
    void (valid ? Promise.resolve(current) : refreshToken()).then((t) => {
      if (stopped || client !== c) return;
      if (!t) {
        resubTimer = setTimeout(() => {
          resubTimer = null;
          resubscribeWhenTokenReady(c, topic);
        }, Math.max(1_000, nextAttemptAt - now()));
        return;
      }
      void c.realtime.setAuth().catch(() => {});
      scheduleRefresh();
      subscribe(c, topic);
    });
  };

  void (async () => {
    try {
      const first = await refreshToken();
      if (stopped || !first) return;
      const c = await createClient(first.url, first.anonKey, { accessToken });
      if (stopped) {
        try {
          c.realtime.disconnect();
        } catch {}
        return;
      }
      client = c;
      await c.realtime.setAuth(first.token).catch(() => {});
      if (stopped) return;
      subscribe(c, first.topic);
      scheduleRefresh();
    } catch {
      stop();
    }
  })();

  return stop;
}

let active: { stop: () => void; refs: number } | null = null;

/** 탭 하나에 연결 하나: 여러 번 불러도 연결은 하나이고, 마지막 해제 때 닫는다. */
export function acquireNotificationRealtime(deps: RealtimeDeps): () => void {
  if (!active) active = { stop: startNotificationRealtime(deps), refs: 0 };
  active.refs += 1;
  let released = false;
  return () => {
    if (released || !active) return;
    released = true;
    active.refs -= 1;
    if (active.refs <= 0) {
      active.stop();
      active = null;
    }
  };
}
