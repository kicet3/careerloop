/**
 * 알림 저장소(클라이언트): 실시간 수신 없음 — 앱 틀이 처음 그려질 때 목록을 한 번 받고, 알림 패널을 열 때 다시 받는다.
 * 타이머·EventSource·표시/포커스 리스너를 만들지 않는다(가짜 전역으로 확인).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem } from "@/lib/domain/notifications";

const n = (id: string, createdAt: number, readAt: number | null = null): NotificationItem => ({
  id,
  kind: "resume-draft-completed",
  title: id,
  body: "",
  link: null,
  readAt,
  createdAt,
});

describe("알림 저장소(새로고침·패널 열기 때만 받기)", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let eventSourceMock: ReturnType<typeof vi.fn>;
  let addListener: ReturnType<typeof vi.fn>;
  let store: typeof import("./store");
  let subscribe: (l: () => void) => () => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.useFakeTimers();
    addListener = vi.fn();
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: addListener, removeEventListener: vi.fn() });
    vi.stubGlobal("window", { addEventListener: addListener, removeEventListener: vi.fn() });
    eventSourceMock = vi.fn();
    vi.stubGlobal("EventSource", eventSourceMock);
    fetchMock = vi.fn(async () => Response.json({ items: [n("a", 1000)], unreadCount: 1 }));
    vi.stubGlobal("fetch", fetchMock);
    // useSyncExternalStore 대신 subscribe를 직접 쓰려고 react를 가로챈다.
    vi.doMock("react", () => ({
      useSyncExternalStore: (sub: (l: () => void) => () => void) => {
        subscribe = sub;
      },
    }));
    store = await import("./store");
    store.useNotifications();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.doUnmock("react");
  });

  const urls = () => fetchMock.mock.calls.map((c) => String(c[0]));

  it("구독(앱 틀 마운트)하면 목록을 한 번 받는다 — 버튼 두 개여도 한 번, 시간이 지나도 다시 받지 않고 타이머·EventSource·리스너는 없다", async () => {
    subscribe(() => {});
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual(["/api/notifications"]);
    expect(store.getNotificationState()).toMatchObject({ loaded: true, unreadCount: 1 });
    expect(vi.getTimerCount()).toBe(0);
    // 시간이 지나도(예전 1분 주기·SSE 재연결) 다시 받지 않는다.
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(eventSourceMock).not.toHaveBeenCalled();
    expect(addListener).not.toHaveBeenCalled();
    expect(urls().some((u) => u.includes("/stream"))).toBe(false);
  });

  it("앱 밖에 갔다가 돌아와 앱 틀이 다시 그려지면(구독자 0 → 1) 최근 목록 전체를 다시 받는다 — 구독자가 남아 있으면 받지 않는다", async () => {
    const un1 = subscribe(() => {});
    const un2 = subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    un1();
    const un3 = subscribe(() => {}); // 버튼 하나가 남아 있는 동안의 다시 구독: 받지 않는다
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // 앱 틀이 사라진다(/terms 등으로 이동) → 그 사이 작업이 끝나 새 알림이 생긴다 → 돌아온다.
    un2();
    un3();
    fetchMock.mockImplementationOnce(async () => Response.json({ items: [n("b", 2000), n("a", 1000)], unreadCount: 2 }));
    subscribe(() => {});
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()).toEqual(["/api/notifications", "/api/notifications"]);
    const st = store.getNotificationState();
    expect(st.unreadCount).toBe(2);
    expect(st.items.map((x) => x.id)).toEqual(["b", "a"]);
    expect(st.toasts.map((x) => x.id)).toEqual(["b"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("처음 받은 알림은 토스트로 띄우지 않는다", async () => {
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(store.getNotificationState().toasts).toEqual([]);
  });

  it("패널을 열면 최근 목록 전체를 다시 받고 읽지 않은 id를 돌려준다 — 처음 보는 읽지 않은 알림만 토스트 후보", async () => {
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockImplementationOnce(async () => Response.json({ items: [n("b", 2000), n("a", 1000), n("r", 500, 600)], unreadCount: 2 }));
    const ids = await store.refreshNotificationsForPanel();
    expect(urls()).toEqual(["/api/notifications", "/api/notifications"]);
    expect(ids).toEqual(["b", "a"]);
    const st = store.getNotificationState();
    expect(st.items.map((x) => x.id)).toEqual(["b", "a", "r"]);
    expect(st.unreadCount).toBe(2);
    expect(st.toasts.map((x) => x.id)).toEqual(["b"]);
  });

  it("첫 요청이 실패하면 오류로 두고 저절로 다시 받지 않는다 — 패널을 열거나 앱 틀이 다시 그려지면 다시 받는다", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("no", { status: 500 }));
    const un = subscribe(() => {});
    await vi.advanceTimersByTimeAsync(60 * 60_000);
    expect(store.getNotificationState()).toMatchObject({ loaded: false, error: true, locallyChanged: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(await store.refreshNotificationsForPanel()).toEqual(["a"]);
    expect(store.getNotificationState()).toMatchObject({ loaded: true, error: false });
    un();
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("첫 요청이 실패한 뒤 '모두 읽음'을 누르면 화면에서 바꾼 것으로 표시한다(배지가 서버에서 센 첫 값에 머물지 않게)", async () => {
    fetchMock.mockImplementationOnce(async () => new Response("no", { status: 500 }));
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockImplementationOnce(async () => new Response(null, { status: 204 }));
    await store.markAllNotificationsRead();
    expect(store.getNotificationState()).toMatchObject({ loaded: false, locallyChanged: true, unreadCount: 0 });
    expect(urls()[1]).toBe("/api/notifications/read");
  });

  it("pokeNotifications: 구독 중이면 since로 한 번 이어 받는다(새 것은 토스트), 구독자가 없으면 아무것도 하지 않는다", async () => {
    store.pokeNotifications();
    expect(fetchMock).not.toHaveBeenCalled();
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    fetchMock.mockImplementationOnce(async () => Response.json({ items: [n("c", 3000)], unreadCount: 2 }));
    store.pokeNotifications();
    await vi.advanceTimersByTimeAsync(0);
    expect(urls()[1]).toBe("/api/notifications?since=0");
    expect(store.getNotificationState().toasts.map((x) => x.id)).toEqual(["c"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("읽음 처리는 화면 먼저 반영하고 POST /read 하나만 보낸다", async () => {
    subscribe(() => {});
    await vi.advanceTimersByTimeAsync(0);
    await store.markNotificationsRead(["a"]);
    expect(store.getNotificationState().unreadCount).toBe(0);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(urls()[1]).toBe("/api/notifications/read");
    expect(JSON.parse(String((fetchMock.mock.calls[1]![1] as RequestInit).body))).toEqual({ ids: ["a"] });
  });
});
