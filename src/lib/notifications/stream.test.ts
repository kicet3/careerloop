/**
 * 새 알림 SSE 스트림(PGlite, 세션은 가짜): 커서 뒤 알림만·내 것만·읽지 않은 수·heartbeat·수명 끝에 닫기·정리 주기·인증·헤더.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ user: { id: "ua" } as { id: string } | null }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
}));
const sweepMock = vi.hoisted(() => ({ calls: 0 }));
vi.mock("./sweep", () => ({
  sweepStaleJobs: async () => {
    sweepMock.calls++;
  },
}));

let tdb: TestDb;
let svc: typeof import("./service");
let mod: typeof import("./stream");
let route: typeof import("@/app/api/notifications/stream/route");

beforeAll(async () => {
  tdb = await createTestDb();
  svc = await import("./service");
  mod = await import("./stream");
  route = await import("@/app/api/notifications/stream/route");
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  state.user = { id: "ua" };
  sweepMock.calls = 0;
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

interface SseEvent {
  event?: string;
  id?: string;
  data?: unknown;
  comment?: string;
  retry?: number;
}

function parseSse(text: string): SseEvent[] {
  return text
    .split("\n\n")
    .filter(Boolean)
    .map((block) => {
      const ev: SseEvent = {};
      for (const line of block.split("\n")) {
        if (line.startsWith(":")) ev.comment = line.slice(1).trim();
        else if (line.startsWith("event: ")) ev.event = line.slice(7);
        else if (line.startsWith("id: ")) ev.id = line.slice(4);
        else if (line.startsWith("data: ")) ev.data = JSON.parse(line.slice(6));
        else if (line.startsWith("retry: ")) ev.retry = Number(line.slice(7));
      }
      return ev;
    });
}

/** 스트림이 닫힐 때까지(또는 until이 참이 될 때까지) 읽는다. until로 멈추면 취소한다. */
async function readAll(stream: ReadableStream<Uint8Array>, until?: (events: SseEvent[]) => boolean): Promise<{ events: SseEvent[]; closed: boolean }> {
  const reader = stream.getReader();
  const dec = new TextDecoder();
  let text = "";
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return { events: parseSse(text), closed: true };
    text += dec.decode(value, { stream: true });
    // 완전한 이벤트 블록만 본다.
    const complete = text.slice(0, text.lastIndexOf("\n\n") + 2);
    if (until?.(parseSse(complete))) {
      await reader.cancel();
      return { events: parseSse(complete), closed: false };
    }
  }
}

const base = Date.UTC(2026, 10, 7, 0, 0, 0);
const at = (s: number) => new Date(base + s * 1000);
const fast = { pollMs: 5, heartbeatMs: 1_000_000, lifetimeMs: 60_000, sweepEveryMs: 1_000_000 };
const notifications = (events: SseEvent[]) => events.filter((e) => e.event === "notification");

describe("createNotificationStream", () => {
  it("커서 뒤의 내 알림만 오래된 순으로 보내고, id는 커서 — 남의 알림·커서 앞 알림은 보내지 않는다", async () => {
    await svc.createNotification("ua", { kind: "interview-ready", title: "old" }, at(1));
    await svc.createNotification("ua", { kind: "diagnosis-completed", title: "n1", body: "본문", link: "/app/d/1" }, at(10));
    await svc.createNotification("ua", { kind: "diagnosis-failed", title: "n2" }, at(11));
    await svc.createNotification("ub", { kind: "interview-ready", title: "남의 것" }, at(12));
    const { events } = await readAll(
      mod.createNotificationStream("ua", { ...fast, cursor: at(5).getTime(), now: () => base + 20_000 }),
      (evs) => evs.some((e) => e.event === "unread"),
    );
    expect(events[0]!.retry).toBe(mod.STREAM_DEFAULTS.retryMs);
    const sent = notifications(events);
    expect(sent.map((e) => (e.data as { title: string }).title)).toEqual(["n1", "n2"]);
    expect(sent.map((e) => e.id)).toEqual([String(at(10).getTime()), String(at(11).getTime())]);
    expect(sent[0]!.data).toEqual({
      id: expect.any(String),
      kind: "diagnosis-completed",
      title: "n1",
      body: "본문",
      link: "/app/d/1",
      createdAt: at(10).getTime(),
      readAt: null,
    });
    const unread = events.find((e) => e.event === "unread")!;
    expect(unread.data).toEqual({ unreadCount: 3 });
    expect(unread.id).toBe(String(at(11).getTime()));
  });

  it("커서 뒤에 생겼지만 이미 읽은 알림은 readAt을 실어 보낸다(클라이언트가 토스트·배지에서 뺀다)", async () => {
    const read = await svc.createNotification("ua", { kind: "diagnosis-completed", title: "read" }, at(10));
    await svc.createNotification("ua", { kind: "diagnosis-failed", title: "unread" }, at(11));
    await svc.markNotificationsRead("ua", { ids: [read.id] }, at(15));
    const { events } = await readAll(
      mod.createNotificationStream("ua", { ...fast, cursor: at(5).getTime(), now: () => base + 20_000 }),
      (evs) => evs.some((e) => e.event === "unread"),
    );
    const sent = notifications(events).map((e) => e.data as { title: string; readAt: number | null });
    expect(sent.map((d) => [d.title, d.readAt])).toEqual([
      ["read", at(15).getTime()],
      ["unread", null],
    ]);
    expect(events.find((e) => e.event === "unread")!.data).toEqual({ unreadCount: 1 });
  });

  it("연결 뒤에 생긴 알림을 다음 확인 때 보내고, 같은 알림은 한 번만 — 읽지 않은 수는 바뀔 때만", async () => {
    const ac = new AbortController();
    let created = false;
    const { events } = await readAll(
      mod.createNotificationStream("ua", { ...fast, cursor: at(5).getTime(), signal: ac.signal, now: () => base + 20_000 }),
      (evs) => {
        if (!created && evs.some((e) => e.event === "unread")) {
          created = true;
          void svc.createNotification("ua", { kind: "interview-ready", title: "later" }, at(6));
          void svc.createNotification("ub", { kind: "interview-ready", title: "남의 것" }, at(7));
        }
        return evs.filter((e) => e.event === "unread").length >= 2;
      },
    );
    ac.abort();
    expect(notifications(events).map((e) => (e.data as { title: string }).title)).toEqual(["later"]);
    expect(events.filter((e) => e.event === "unread").map((e) => e.data)).toEqual([{ unreadCount: 0 }, { unreadCount: 1 }]);
  });

  it("커서가 없으면 조금 앞(START_LOOKBACK_MS)부터, 겹친 구간(OVERLAP_MS)의 늦게 커밋된 알림도 보낸다", async () => {
    const now = base + 100_000;
    await svc.createNotification("ua", { kind: "interview-ready", title: "too-old" }, new Date(now - mod.START_LOOKBACK_MS - mod.OVERLAP_MS - 1000));
    await svc.createNotification("ua", { kind: "interview-ready", title: "recent" }, new Date(now - 5000));
    const a = await readAll(mod.createNotificationStream("ua", { ...fast, cursor: null, now: () => now }), (evs) => evs.some((e) => e.event === "unread"));
    expect(notifications(a.events).map((e) => (e.data as { title: string }).title)).toEqual(["recent"]);
    // 커서보다 1초 앞에 커밋된 알림(다른 인스턴스 시계)도 겹친 구간에 있어 보낸다.
    const b = await readAll(mod.createNotificationStream("ua", { ...fast, cursor: now - 4000, now: () => now }), (evs) => evs.some((e) => e.event === "unread"));
    expect(notifications(b.events).map((e) => (e.data as { title: string }).title)).toEqual(["recent"]);
  });

  it("아무것도 보내지 않은 채 heartbeatMs가 지나면 주석(ping)을 보낸다", async () => {
    let t = base;
    const { events } = await readAll(
      mod.createNotificationStream("ua", { ...fast, heartbeatMs: 50, cursor: null, now: () => (t += 10) }),
      (evs) => evs.some((e) => e.comment === "ping"),
    );
    expect(events.some((e) => e.comment === "ping")).toBe(true);
  });

  it("수명(lifetimeMs)이 지나면 스스로 닫는다 — 정리(sweep)는 시작할 때와 sweepEveryMs마다만", async () => {
    let t = base;
    const { closed, events } = await readAll(
      mod.createNotificationStream("ua", { ...fast, lifetimeMs: 1000, sweepEveryMs: 400, cursor: null, now: () => (t += 50) }),
    );
    expect(closed).toBe(true);
    expect(events.filter((e) => e.event === "unread")).toHaveLength(1);
    expect(sweepMock.calls).toBeGreaterThanOrEqual(2);
    expect(sweepMock.calls).toBeLessThanOrEqual(4);
  });

  it("요청이 끊기면(signal) 닫는다", async () => {
    const ac = new AbortController();
    const stream = mod.createNotificationStream("ua", { ...fast, cursor: null, signal: ac.signal });
    setTimeout(() => ac.abort(), 30);
    const { closed } = await readAll(stream);
    expect(closed).toBe(true);
  });

  it("DB 오류면 긴 retry를 알리고 닫는다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const { closed, events } = await readAll(
      mod.createNotificationStream("ua", { ...fast, cursor: null, sweep: async () => Promise.reject(new Error("db down")) }),
    );
    expect(closed).toBe(true);
    expect(events.at(-1)!.retry).toBe(mod.STREAM_DEFAULTS.errorRetryMs);
    spy.mockRestore();
  });
});

describe("GET /api/notifications/stream", () => {
  it("text/event-stream·no-store·X-Accel-Buffering, Last-Event-ID가 ?since=보다 먼저", async () => {
    // 커서는 지금보다 미래일 수 없어(서버 시각으로 자른다) 실제 시각 기준으로 만든다.
    const t0 = Date.now() - 60_000;
    await svc.createNotification("ua", { kind: "interview-ready", title: "a" }, new Date(t0 + 1000));
    await svc.createNotification("ua", { kind: "interview-ready", title: "b" }, new Date(t0 + 10_000));
    const ac = new AbortController();
    const res = await route.GET(
      new Request(`http://localhost/api/notifications/stream?since=${t0}`, {
        headers: { "Last-Event-ID": String(t0 + 5000) },
        signal: ac.signal,
      }),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("Content-Type")).toContain("text/event-stream");
    expect(res.headers.get("Cache-Control")).toContain("no-store");
    expect(res.headers.get("X-Accel-Buffering")).toBe("no");
    const { events } = await readAll(res.body!, (evs) => evs.some((e) => e.event === "unread"));
    ac.abort();
    expect(notifications(events).map((e) => (e.data as { title: string }).title)).toEqual(["b"]);
    expect(route.maxDuration).toBe(300);
  });

  it("로그인하지 않으면 401, 다른 사이트에서 열면 403", async () => {
    state.user = null;
    expect((await route.GET(new Request("http://localhost/api/notifications/stream"))).status).toBe(401);
    state.user = { id: "ua" };
    const cross = await route.GET(new Request("http://localhost/api/notifications/stream", { headers: { "Sec-Fetch-Site": "cross-site" } }));
    expect(cross.status).toBe(403);
  });
});
