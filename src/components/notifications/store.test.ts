/**
 * 알림 저장소(클라이언트): 스트림 합치기(순수)와, 가짜 EventSource·document로 본 연결 수명(보일 때 열고 숨기면 닫기, 처음 목록 한 번, 재연결 커서).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NotificationItem, NotificationStreamItem } from "@/lib/domain/notifications";
import { mergeStreamNotifications, streamSince } from "./merge";

const n = (id: string, createdAt: number, readAt: number | null = null): NotificationItem => ({
  id,
  kind: "resume-draft-completed",
  title: id,
  body: "",
  link: null,
  readAt,
  createdAt,
});
const s = (id: string, createdAt: number, readAt: number | null = null): NotificationStreamItem => ({
  id,
  kind: "diagnosis-completed",
  title: id,
  body: "",
  link: "/app/x",
  createdAt,
  readAt,
});

describe("mergeStreamNotifications", () => {
  it("처음 보는 알림만 읽지 않음으로 붙이고(최근 순), 아는 id는 화면 상태(읽음)를 그대로 둔다", () => {
    const prev = [n("b", 20, 21), n("a", 10)];
    const { items, fresh } = mergeStreamNotifications(prev, [s("b", 20), s("c", 30), s("c", 30)]);
    expect(items.map((x) => x.id)).toEqual(["c", "b", "a"]);
    expect(items[1]!.readAt).toBe(21);
    expect(items[0]!.readAt).toBeNull();
    expect(fresh.map((x) => x.id)).toEqual(["c"]);
  });

  it("처음 보는 알림이라도 이미 읽은 것은 읽음 상태로 붙이고 토스트·배지 후보(fresh)에서 뺀다", () => {
    const { items, fresh, added } = mergeStreamNotifications([n("a", 10)], [s("r", 20, 25), s("u", 30)]);
    expect(items.map((x) => [x.id, x.readAt])).toEqual([
      ["u", null],
      ["r", 25],
      ["a", null],
    ]);
    expect(fresh.map((x) => x.id)).toEqual(["u"]);
    expect(added).toBe(2);
  });

  it("새 것이 없으면 그대로, limit까지만", () => {
    expect(mergeStreamNotifications([n("a", 1)], [s("a", 1)]).fresh).toEqual([]);
    const { items } = mergeStreamNotifications([n("a", 1), n("b", 2)], [s("c", 3)], 2);
    expect(items.map((x) => x.id)).toEqual(["c", "b"]);
  });

  it("streamSince: 마지막 이벤트 id와 가장 최근 알림 시각 중 큰 값", () => {
    expect(streamSince(null, [])).toBeNull();
    expect(streamSince(500, [n("a", 100)])).toBe(500);
    expect(streamSince(50, [n("a", 100), n("b", 300)])).toBe(300);
  });
});

class FakeEventSource {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSED = 2;
  static all: FakeEventSource[] = [];
  readyState = FakeEventSource.CONNECTING;
  private handlers = new Map<string, ((e: Event) => void)[]>();
  constructor(public url: string) {
    FakeEventSource.all.push(this);
  }
  addEventListener(type: string, fn: (e: Event) => void) {
    this.handlers.set(type, [...(this.handlers.get(type) ?? []), fn]);
  }
  close() {
    this.readyState = FakeEventSource.CLOSED;
  }
  emit(type: string, data?: unknown, lastEventId = "") {
    const e = { type, data: data === undefined ? undefined : JSON.stringify(data), lastEventId } as unknown as Event;
    for (const fn of this.handlers.get(type) ?? []) fn(e);
  }
}

function fakeDom() {
  const listeners = new Map<string, Set<() => void>>();
  const target = () => ({
    addEventListener: (t: string, fn: () => void) => listeners.set(t, (listeners.get(t) ?? new Set()).add(fn)),
    removeEventListener: (t: string, fn: () => void) => listeners.get(t)?.delete(fn),
  });
  const doc = { visibilityState: "visible" as "visible" | "hidden", ...target() };
  const win = target();
  return { doc, win, fire: (t: string) => listeners.get(t)?.forEach((fn) => fn()) };
}

describe("알림 저장소 스트림 연결", () => {
  let dom: ReturnType<typeof fakeDom>;
  let fetchMock: ReturnType<typeof vi.fn>;
  let store: typeof import("./store");
  let subscribe: (l: () => void) => () => void;

  beforeEach(async () => {
    vi.resetModules();
    FakeEventSource.all = [];
    dom = fakeDom();
    vi.stubGlobal("document", dom.doc);
    vi.stubGlobal("window", dom.win);
    vi.stubGlobal("EventSource", FakeEventSource);
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
    vi.unstubAllGlobals();
    vi.doUnmock("react");
  });

  const flush = () => new Promise((r) => setTimeout(r, 0));

  it("구독하면 목록을 한 번 받고 스트림을 연다 — 새 알림은 합치고 토스트, 읽지 않은 수는 스트림 값", async () => {
    const unsub = subscribe(() => {});
    await flush();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(FakeEventSource.all).toHaveLength(1);
    const es = FakeEventSource.all[0]!;
    expect(es.url).toBe("/api/notifications/stream?since=1000");
    es.emit("unread", { unreadCount: 1 }, "1000");
    es.emit("notification", s("b", 2000), "2000");
    es.emit("notification", s("b", 2000), "2000");
    let st = store.getNotificationState();
    expect(st.items.map((x) => x.id)).toEqual(["b", "a"]);
    expect(st.toasts.map((x) => x.id)).toEqual(["b"]);
    expect(st.unreadCount).toBe(2);
    es.emit("unread", { unreadCount: 5 }, "2000");
    st = store.getNotificationState();
    expect(st.unreadCount).toBe(5);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unsub();
    expect(es.readyState).toBe(FakeEventSource.CLOSED);
  });

  it("탭이 숨겨지면 닫고, 다시 보이면 마지막 커서로 다시 연다(목록은 다시 받지 않는다)", async () => {
    const unsub = subscribe(() => {});
    await flush();
    const first = FakeEventSource.all[0]!;
    first.emit("unread", { unreadCount: 1 }, "7000");
    dom.doc.visibilityState = "hidden";
    dom.fire("visibilitychange");
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    dom.fire("focus");
    await flush();
    expect(FakeEventSource.all).toHaveLength(1);
    dom.doc.visibilityState = "visible";
    dom.fire("visibilitychange");
    dom.fire("focus");
    await flush();
    expect(FakeEventSource.all).toHaveLength(2);
    expect(FakeEventSource.all[1]!.url).toBe("/api/notifications/stream?since=7000");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    unsub();
  });

  it("이미 읽은 알림이 스트림으로 오면 토스트·배지를 올리지 않고 목록에만 읽음으로 붙인다", async () => {
    const unsub = subscribe(() => {});
    await flush();
    const es = FakeEventSource.all[0]!;
    es.emit("notification", s("r", 2000, 2500), "2000");
    const st = store.getNotificationState();
    expect(st.items.map((x) => [x.id, x.readAt])).toEqual([
      ["r", 2500],
      ["a", null],
    ]);
    expect(st.toasts).toEqual([]);
    expect(st.unreadCount).toBe(1);
    unsub();
  });

  it("응답 단계에서 실패(CLOSED)하면 5초→15초→60초 간격으로 마지막 커서로 다시 열고, open이면 간격을 처음으로, 숨기면 예약을 지운다", async () => {
    vi.useFakeTimers();
    try {
      const unsub = subscribe(() => {});
      await vi.advanceTimersByTimeAsync(0);
      const failClosed = (es: FakeEventSource) => {
        es.readyState = FakeEventSource.CLOSED;
        es.emit("error");
      };
      const first = FakeEventSource.all[0]!;
      first.emit("unread", { unreadCount: 1 }, "4000");
      failClosed(first);
      await vi.advanceTimersByTimeAsync(4_999);
      expect(FakeEventSource.all).toHaveLength(1);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.all).toHaveLength(2);
      expect(FakeEventSource.all[1]!.url).toBe("/api/notifications/stream?since=4000");
      failClosed(FakeEventSource.all[1]!);
      await vi.advanceTimersByTimeAsync(14_999);
      expect(FakeEventSource.all).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.all).toHaveLength(3);
      failClosed(FakeEventSource.all[2]!);
      await vi.advanceTimersByTimeAsync(59_999);
      expect(FakeEventSource.all).toHaveLength(3);
      await vi.advanceTimersByTimeAsync(1);
      expect(FakeEventSource.all).toHaveLength(4);
      // 연결되면(open) 다음 실패는 다시 5초부터.
      const fourth = FakeEventSource.all[3]!;
      fourth.emit("open");
      failClosed(fourth);
      await vi.advanceTimersByTimeAsync(5_000);
      expect(FakeEventSource.all).toHaveLength(5);
      // 숨기면 예약한 재시도를 지운다(보이지 않는 동안 다시 열지 않는다).
      failClosed(FakeEventSource.all[4]!);
      dom.doc.visibilityState = "hidden";
      dom.fire("visibilitychange");
      await vi.advanceTimersByTimeAsync(600_000);
      expect(FakeEventSource.all).toHaveLength(5);
      dom.doc.visibilityState = "visible";
      dom.fire("visibilitychange");
      await vi.advanceTimersByTimeAsync(0);
      expect(FakeEventSource.all).toHaveLength(6);
      expect(fetchMock).toHaveBeenCalledTimes(1);
      unsub();
    } finally {
      vi.useRealTimers();
    }
  });

  it("읽음 요청을 보내는 동안의 읽지 않은 수는 무시한다", async () => {
    let release!: () => void;
    const unsub = subscribe(() => {});
    await flush();
    const es = FakeEventSource.all[0]!;
    fetchMock.mockImplementationOnce(() => new Promise<Response>((r) => (release = () => r(Response.json({ updated: 1 })))));
    const done = store.markNotificationsRead(["a"]);
    expect(store.getNotificationState().unreadCount).toBe(0);
    es.emit("unread", { unreadCount: 1 }, "1000");
    expect(store.getNotificationState().unreadCount).toBe(0);
    release();
    await done;
    es.emit("unread", { unreadCount: 0 }, "1000");
    expect(store.getNotificationState().unreadCount).toBe(0);
    unsub();
  });
});
