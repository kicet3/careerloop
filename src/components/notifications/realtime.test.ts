/**
 * 알림 실시간 수신(클라이언트, 가짜 supabase 클라이언트): 설정 있으면 private 채널 구독·이벤트 때 다시 받기·토큰 갱신 예약,
 * 설정 없으면 아무것도 하지 않음, 처음 구독이 거듭 실패하면 닫기, 탭 하나에 연결 하나.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationRealtimeToken } from "@/lib/domain/notifications-realtime";
import {
  acquireNotificationRealtime,
  fetchRealtimeToken,
  MAX_INITIAL_FAILURES,
  MAX_RESUBSCRIBES,
  RealtimeTokenUnavailableError,
  RETRY_TOKEN_DELAY_MS,
  startNotificationRealtime,
  type RealtimeClientLike,
} from "./realtime";

const T0 = Date.UTC(2026, 10, 7, 0, 0, 0);
const tok = (n: number, expiresAt = T0 + 3600_000): NotificationRealtimeToken => ({
  url: "https://abc.supabase.co",
  anonKey: "anon",
  token: `jwt-${n}`,
  topic: "notifications:ua",
  expiresAt,
});

function fakeClient() {
  let broadcast: (() => void) | null = null;
  let statusCb: ((s: string) => void) | null = null;
  const channelOpts: unknown[] = [];
  const makeChannel = () => {
    const channel = {
      on: vi.fn((_t: string, filter: { event: string }, cb: () => void) => {
        if (filter.event === "notification") broadcast = cb;
        return channel;
      }),
      subscribe: vi.fn((cb: (s: string) => void) => {
        statusCb = cb;
        return channel;
      }),
    };
    return channel;
  };
  const client = {
    channel: vi.fn((name: string, opts: unknown) => {
      channelOpts.push([name, opts]);
      return makeChannel();
    }),
    removeChannel: vi.fn(async () => "ok"),
    realtime: { setAuth: vi.fn(async () => {}), disconnect: vi.fn() },
  };
  return {
    client: client as unknown as RealtimeClientLike & typeof client,
    channelOpts,
    emit: () => broadcast?.(),
    status: (s: string) => statusCb?.(s),
  };
}

describe("알림 실시간 수신(클라이언트)", () => {
  let now = T0;
  beforeEach(() => {
    vi.useFakeTimers();
    now = T0;
  });
  afterEach(() => vi.useRealTimers());

  it("설정이 없으면(토큰 404) 클라이언트를 만들지 않는다", async () => {
    const createClient = vi.fn();
    const onNotification = vi.fn();
    const stop = startNotificationRealtime({ onNotification, fetchToken: async () => null, createClient });
    await vi.advanceTimersByTimeAsync(0);
    expect(createClient).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
    stop();
  });

  it("설정이 있으면 private 채널을 구독하고, 이벤트·(다시)구독 때 다시 받고, 멈추면 정리한다", async () => {
    const f = fakeClient();
    const createClient = vi.fn(() => f.client);
    const onNotification = vi.fn();
    const stop = startNotificationRealtime({ onNotification, fetchToken: async () => tok(1), createClient, now: () => now });
    await vi.advanceTimersByTimeAsync(0);
    expect(createClient).toHaveBeenCalledWith("https://abc.supabase.co", "anon", expect.objectContaining({ accessToken: expect.any(Function) }));
    expect(f.client.realtime.setAuth).toHaveBeenCalledWith("jwt-1");
    expect(f.channelOpts).toEqual([["notifications:ua", { config: { private: true } }]]);
    f.status("SUBSCRIBED");
    expect(onNotification).toHaveBeenCalledTimes(1); // 구독 전에 만든 알림 따라잡기
    f.emit();
    f.emit();
    expect(onNotification).toHaveBeenCalledTimes(3);
    stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.removeChannel).toHaveBeenCalledTimes(1);
    expect(f.client.realtime.disconnect).toHaveBeenCalledTimes(1);
    f.emit();
    expect(onNotification).toHaveBeenCalledTimes(3);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("accessToken 콜백은 캐시를 돌려주고, 만료 5분 전에 새 토큰을 받아 연결에 반영한다", async () => {
    const f = fakeClient();
    let accessToken: (() => Promise<string>) | null = null;
    const createClient = vi.fn((_u: string, _k: string, opts: { accessToken: () => Promise<string> }) => {
      accessToken = opts.accessToken;
      return f.client;
    });
    let n = 0;
    const fetchToken = vi.fn(async () => {
      n += 1;
      return tok(n, now + 3600_000);
    });
    startNotificationRealtime({ onNotification: vi.fn(), fetchToken, createClient, now: () => now });
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    expect(await accessToken!()).toBe("jwt-1");
    expect(await accessToken!()).toBe("jwt-1");
    expect(fetchToken).toHaveBeenCalledTimes(1); // 하트비트마다 API를 부르지 않는다
    // 55분 뒤(만료 5분 전) 타이머가 새 토큰을 받는다.
    now += 55 * 60_000 - 1;
    await vi.advanceTimersByTimeAsync(55 * 60_000 - 1);
    expect(fetchToken).toHaveBeenCalledTimes(1);
    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(f.client.realtime.setAuth).toHaveBeenLastCalledWith();
    expect(await accessToken!()).toBe("jwt-2");
    expect(vi.getTimerCount()).toBe(1); // 다음 갱신 예약
  });

  it("accessToken 콜백도 만료가 가까우면 새로 받는다(타이머가 늦은 백그라운드 탭)", async () => {
    const f = fakeClient();
    let accessToken: (() => Promise<string>) | null = null;
    let n = 0;
    const fetchToken = vi.fn(async () => tok(++n, now + 3600_000));
    startNotificationRealtime({
      onNotification: vi.fn(),
      fetchToken,
      createClient: (_u, _k, opts) => {
        accessToken = opts.accessToken;
        return f.client;
      },
      now: () => now,
    });
    await vi.advanceTimersByTimeAsync(0);
    now += 56 * 60_000; // 타이머는 아직 안 돌았다고 치고 시간만 흐름
    expect(await accessToken!()).toBe("jwt-2");
  });

  it("처음 구독이 거듭 실패하면(정책 없음 등) 조용히 닫는다 — 한 번 구독된 뒤의 오류는 realtime-js 재연결에 맡긴다", async () => {
    const f = fakeClient();
    const onNotification = vi.fn();
    startNotificationRealtime({ onNotification, fetchToken: async () => tok(1), createClient: () => f.client, now: () => now });
    await vi.advanceTimersByTimeAsync(0);
    for (let i = 0; i < MAX_INITIAL_FAILURES; i++) f.status("CHANNEL_ERROR");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.realtime.disconnect).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
    expect(onNotification).not.toHaveBeenCalled();

    const g = fakeClient();
    const stop = startNotificationRealtime({ onNotification, fetchToken: async () => tok(1), createClient: () => g.client, now: () => now });
    await vi.advanceTimersByTimeAsync(0);
    g.status("SUBSCRIBED");
    for (let i = 0; i < MAX_INITIAL_FAILURES + 2; i++) g.status("CHANNEL_ERROR");
    expect(g.client.realtime.disconnect).not.toHaveBeenCalled();
    g.status("SUBSCRIBED"); // 다시 연결되면 놓친 알림을 받는다
    expect(onNotification).toHaveBeenCalledTimes(2);
    stop();
  });

  it("토큰을 받는 중에 멈추면 클라이언트를 만들지 않는다", async () => {
    let resolve: (t: NotificationRealtimeToken) => void = () => {};
    const createClient = vi.fn();
    const stop = startNotificationRealtime({ onNotification: vi.fn(), fetchToken: () => new Promise((r) => (resolve = r)), createClient });
    stop();
    resolve(tok(1));
    await vi.advanceTimersByTimeAsync(0);
    expect(createClient).not.toHaveBeenCalled();
  });

  it("탭 하나에 연결 하나: 여러 번 잡아도 한 번 만들고, 마지막 해제 때 닫는다", async () => {
    const f = fakeClient();
    const createClient = vi.fn(() => f.client);
    const deps = { onNotification: vi.fn(), fetchToken: async () => tok(1), createClient, now: () => now };
    const r1 = acquireNotificationRealtime(deps);
    const r2 = acquireNotificationRealtime(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(createClient).toHaveBeenCalledTimes(1);
    r1();
    r1();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.realtime.disconnect).not.toHaveBeenCalled();
    r2();
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.realtime.disconnect).toHaveBeenCalledTimes(1);
    // 다시 잡으면 새로 연결한다(앱 밖에 갔다가 돌아와 앱 틀이 다시 그려질 때).
    const r3 = acquireNotificationRealtime(deps);
    await vi.advanceTimersByTimeAsync(0);
    expect(createClient).toHaveBeenCalledTimes(2);
    r3();
  });

  it("토큰 API가 401(로그아웃 등)이면 멈춘다 — 하트비트마다 다시 부르지 않는다", async () => {
    const f = fakeClient();
    let accessToken: (() => Promise<string>) | null = null;
    let n = 0;
    const fetchToken = vi.fn(async () => {
      n += 1;
      if (n === 1) return tok(1, now + 3600_000);
      throw new RealtimeTokenUnavailableError(401);
    });
    startNotificationRealtime({
      onNotification: vi.fn(),
      fetchToken,
      createClient: (_u, _k, opts) => {
        accessToken = opts.accessToken;
        return f.client;
      },
      now: () => now,
    });
    await vi.advanceTimersByTimeAsync(0);
    f.status("SUBSCRIBED");
    now += 56 * 60_000;
    await accessToken!();
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(f.client.realtime.disconnect).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 10; i++) {
      now += 25_000;
      await accessToken!();
      await vi.advanceTimersByTimeAsync(25_000);
    }
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("일시 실패(null)는 백오프 — 그 사이 하트비트 콜백은 API를 부르지 않고, 간격은 두 배로 늘어난다", async () => {
    const f = fakeClient();
    let accessToken: (() => Promise<string>) | null = null;
    let n = 0;
    const fetchToken = vi.fn(async () => (++n === 1 ? tok(1, now + 3600_000) : null));
    startNotificationRealtime({
      onNotification: vi.fn(),
      fetchToken,
      createClient: (_u, _k, opts) => {
        accessToken = opts.accessToken;
        return f.client;
      },
      now: () => now,
    });
    await vi.advanceTimersByTimeAsync(0);
    now += 56 * 60_000;
    expect(await accessToken!()).toBe("jwt-1"); // 실패하면 캐시(아직 4분 유효)
    expect(fetchToken).toHaveBeenCalledTimes(2);
    now += RETRY_TOKEN_DELAY_MS - 1;
    await accessToken!();
    expect(fetchToken).toHaveBeenCalledTimes(2);
    now += 1;
    await accessToken!();
    expect(fetchToken).toHaveBeenCalledTimes(3);
    now += RETRY_TOKEN_DELAY_MS; // 다음 간격은 2분
    await accessToken!();
    expect(fetchToken).toHaveBeenCalledTimes(3);
    now += RETRY_TOKEN_DELAY_MS;
    await accessToken!();
    expect(fetchToken).toHaveBeenCalledTimes(4);
  });

  it("구독된 뒤 서버가 채널을 닫으면(토큰 만료) 새 토큰을 받아 다시 구독한다 — 횟수 제한", async () => {
    const f = fakeClient();
    const onNotification = vi.fn();
    let n = 0;
    const fetchToken = vi.fn(async () => tok(++n, now + 3600_000));
    startNotificationRealtime({ onNotification, fetchToken, createClient: () => f.client, now: () => now });
    await vi.advanceTimersByTimeAsync(0);
    f.status("SUBSCRIBED");
    now += 61 * 60_000; // 토큰 만료
    f.status("CLOSED");
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchToken).toHaveBeenCalledTimes(2);
    expect(f.client.removeChannel).toHaveBeenCalledTimes(1);
    expect(f.channelOpts).toHaveLength(2);
    expect(f.channelOpts[1]).toEqual(["notifications:ua", { config: { private: true } }]);
    f.status("SUBSCRIBED");
    expect(onNotification).toHaveBeenCalledTimes(2); // 닫힌 사이 알림 따라잡기
    // 다시 SUBSCRIBED 되지 않고 계속 닫히면 MAX_RESUBSCRIBES 뒤 멈춘다.
    for (let i = 0; i < MAX_RESUBSCRIBES; i++) {
      f.status("CLOSED");
      await vi.advanceTimersByTimeAsync(0);
    }
    expect(f.channelOpts).toHaveLength(2 + MAX_RESUBSCRIBES);
    expect(f.client.realtime.disconnect).not.toHaveBeenCalled();
    f.status("CLOSED");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.realtime.disconnect).toHaveBeenCalledTimes(1);
  });

  it("처음 구독 전에 채널이 닫히면 멈춘다", async () => {
    const f = fakeClient();
    startNotificationRealtime({ onNotification: vi.fn(), fetchToken: async () => tok(1), createClient: () => f.client, now: () => now });
    await vi.advanceTimersByTimeAsync(0);
    f.status("CLOSED");
    await vi.advanceTimersByTimeAsync(0);
    expect(f.client.realtime.disconnect).toHaveBeenCalledTimes(1);
    expect(f.channelOpts).toHaveLength(1);
  });
});

describe("fetchRealtimeToken", () => {
  afterEach(() => vi.unstubAllGlobals());
  const respond = (status: number, body: unknown = {}) => vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify(body), { status })));

  it("401·403·404는 영구 실패로 던지고, 429·5xx·형식 오류·네트워크 오류는 null", async () => {
    for (const s of [401, 403, 404]) {
      respond(s);
      await expect(fetchRealtimeToken()).rejects.toBeInstanceOf(RealtimeTokenUnavailableError);
    }
    for (const s of [429, 500, 503]) {
      respond(s);
      await expect(fetchRealtimeToken()).resolves.toBeNull();
    }
    respond(200, { url: "x" });
    await expect(fetchRealtimeToken()).resolves.toBeNull();
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("offline"))));
    await expect(fetchRealtimeToken()).resolves.toBeNull();
    respond(200, tok(1));
    await expect(fetchRealtimeToken()).resolves.toEqual(tok(1));
  });
});
