/**
 * 알림 저장소·API(PGlite, 세션은 가짜): 만들기·목록·읽지 않은 수·since·읽음(내 것만·모두)·정리(사용자당 100개)·링크 검증·인증.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_NOTIFICATIONS_PER_USER } from "@/lib/domain/notifications";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ user: { id: "ua" } as { id: string } | null, sameOrigin: true }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.sameOrigin ? null : Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 })),
}));

let tdb: TestDb;
let svc: typeof import("./service");
let listRoute: typeof import("@/app/api/notifications/route");
let readRoute: typeof import("@/app/api/notifications/read/route");

beforeAll(async () => {
  tdb = await createTestDb();
  svc = await import("./service");
  listRoute = await import("@/app/api/notifications/route");
  readRoute = await import("@/app/api/notifications/read/route");
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  state.user = { id: "ua" };
  state.sameOrigin = true;
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

const at = (s: number) => new Date(Date.UTC(2026, 10, 7, 0, 0, s));
const list = async (q = "") => {
  const res = await listRoute.GET(new Request(`http://localhost/api/notifications${q}`));
  return { status: res.status, cache: res.headers.get("Cache-Control"), body: (await res.json()) as import("@/lib/domain/notifications").NotificationListResponse };
};
const read = (body: unknown) =>
  readRoute.POST(new Request("http://localhost/api/notifications/read", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }));

describe("알림 저장소", () => {
  it("만들고 최근 순으로 읽는다 — 제목·본문은 한 줄로 자르고, 앱 밖 링크는 버린다", async () => {
    await svc.createNotification("ua", { kind: "diagnosis-completed", title: "  진단\n끝남 ", body: "가".repeat(400), link: "/app/d/1" }, at(1));
    await svc.createNotification("ua", { kind: "posting-import-failed", title: "실패", link: "https://evil.example/x" }, at(2));
    await svc.createNotification("ua", { kind: "posting-import-failed", title: "스킴 상대", link: "//evil.example" }, at(3));
    const { items, unreadCount } = await svc.listNotifications("ua");
    expect(unreadCount).toBe(3);
    expect(items.map((n) => n.title)).toEqual(["스킴 상대", "실패", "진단 끝남"]);
    expect(items[2]!.body.length).toBe(300);
    expect(items[2]!.link).toBe("/app/d/1");
    expect(items[0]!.link).toBeNull();
    expect(items[1]!.link).toBeNull();
  });

  it("notify()는 실패해도 던지지 않는다", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(svc.notify("nobody", { kind: "interview-ready", title: "x" })).resolves.toBeUndefined();
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it(`사용자당 최근 ${MAX_NOTIFICATIONS_PER_USER}개만 남긴다(다른 사용자 것은 그대로)`, async () => {
    await tdb.prisma.notification.createMany({
      data: Array.from({ length: MAX_NOTIFICATIONS_PER_USER }, (_, i) => ({ id: `n${String(i).padStart(3, "0")}`, userId: "ua", kind: "interview-ready", title: `${i}`, createdAt: at(i) })),
    });
    await svc.createNotification("ub", { kind: "interview-ready", title: "b" }, at(500));
    await svc.createNotification("ua", { kind: "interview-ready", title: "new" }, at(1000));
    expect(await tdb.prisma.notification.count({ where: { userId: "ua" } })).toBe(MAX_NOTIFICATIONS_PER_USER);
    expect(await tdb.prisma.notification.findUnique({ where: { id: "n000" } })).toBeNull();
    expect(await tdb.prisma.notification.findUnique({ where: { id: "n001" } })).not.toBeNull();
    expect(await tdb.prisma.notification.count({ where: { userId: "ub" } })).toBe(1);
  });

  it("읽음 처리는 내 알림만, 'all'은 모두", async () => {
    const a1 = await svc.createNotification("ua", { kind: "interview-ready", title: "a1" }, at(1));
    await svc.createNotification("ua", { kind: "interview-ready", title: "a2" }, at(2));
    const b1 = await svc.createNotification("ub", { kind: "interview-ready", title: "b1" }, at(3));
    expect(await svc.markNotificationsRead("ua", { ids: [a1.id, b1.id] })).toBe(1);
    expect((await svc.listNotifications("ua")).unreadCount).toBe(1);
    expect((await svc.listNotifications("ub")).unreadCount).toBe(1);
    expect(await svc.markNotificationsRead("ua", "all")).toBe(1);
    expect((await svc.listNotifications("ua")).unreadCount).toBe(0);
    expect(await svc.markNotificationsRead("ua", { ids: [] })).toBe(0);
  });
});

describe("알림 API", () => {
  it("GET: 내 알림 + 읽지 않은 수(no-store), since면 그 뒤 것만 — 읽지 않은 수는 전체", async () => {
    await svc.createNotification("ua", { kind: "interview-ready", title: "old" }, at(1));
    await svc.createNotification("ua", { kind: "interview-ready", title: "new" }, at(5));
    await svc.createNotification("ub", { kind: "interview-ready", title: "남의 것" }, at(6));
    const all = await list();
    expect(all.status).toBe(200);
    expect(all.cache).toBe("no-store");
    expect(all.body.items.map((n) => n.title)).toEqual(["new", "old"]);
    expect(all.body.unreadCount).toBe(2);
    const since = await list(`?since=${at(3).getTime()}`);
    expect(since.body.items.map((n) => n.title)).toEqual(["new"]);
    expect(since.body.unreadCount).toBe(2);
    // 잘못된 since는 무시한다.
    expect((await list("?since=abc")).body.items).toHaveLength(2);
  });

  it("POST /read: ids·all, 남의 알림은 바뀌지 않는다, 잘못된 본문은 400, 다른 출처는 403", async () => {
    const mine = await svc.createNotification("ua", { kind: "interview-ready", title: "a" }, at(1));
    const theirs = await svc.createNotification("ub", { kind: "interview-ready", title: "b" }, at(2));
    const r1 = await read({ ids: [mine.id, theirs.id] });
    expect(r1.status).toBe(200);
    expect(await r1.json()).toEqual({ updated: 1 });
    expect((await tdb.prisma.notification.findUniqueOrThrow({ where: { id: theirs.id } })).readAt).toBeNull();
    expect((await read({ ids: [] })).status).toBe(400);
    expect((await read({ all: false })).status).toBe(400);
    await svc.createNotification("ua", { kind: "interview-ready", title: "c" }, at(3));
    expect(await (await read({ all: true })).json()).toEqual({ updated: 1 });
    state.sameOrigin = false;
    expect((await read({ all: true })).status).toBe(403);
  });

  it("로그인하지 않으면 401", async () => {
    state.user = null;
    expect((await list()).status).toBe(401);
    expect((await read({ all: true })).status).toBe(401);
  });

  it("Supabase Realtime이 설정돼 있으면 저장 뒤 내 topic에 id만 보내고, 보내기가 실패해도 알림은 남는다", async () => {
    const env = {
      NEXT_PUBLIC_SUPABASE_URL: "https://abc.supabase.co",
      NEXT_PUBLIC_SUPABASE_ANON_KEY: "anon",
      SUPABASE_SERVICE_ROLE_KEY: "sb_secret_x",
      SUPABASE_JWT_SECRET: "secret",
    };
    for (const [k, v] of Object.entries(env)) vi.stubEnv(k, v);
    const sent: unknown[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      // 보낼 때 이미 저장돼 있어야 한다(클라이언트가 바로 다시 받는다).
      sent.push({ body: JSON.parse(String(init.body)), stored: await tdb.prisma.notification.count({ where: { userId: "ua" } }) });
      return new Response(null, { status: 202 });
    });
    vi.stubGlobal("fetch", fetchMock);
    try {
      const n = await svc.createNotification("ua", { kind: "interview-ready", title: "비밀 제목", body: "비밀 본문" }, at(1));
      expect(sent).toEqual([
        { body: { messages: [{ topic: "notifications:ua", event: "notification", payload: { id: n.id }, private: true }] }, stored: 1 },
      ]);
      const err = vi.spyOn(console, "error").mockImplementation(() => {});
      fetchMock.mockImplementationOnce(async () => {
        throw new TypeError("fetch failed");
      });
      const m = await svc.createNotification("ua", { kind: "interview-ready", title: "b" }, at(2));
      expect(await tdb.prisma.notification.findUnique({ where: { id: m.id } })).not.toBeNull();
      err.mockRestore();
    } finally {
      vi.unstubAllEnvs();
      vi.unstubAllGlobals();
    }
  });
});
