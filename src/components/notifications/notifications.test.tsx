import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { safeNotificationLink, timeAgo, type NotificationItem } from "@/lib/domain/notifications";
import { applyRead, mergeNotifications, nextSince } from "./merge";
import { badgeText, bellUnreadCount, NotificationBell } from "./NotificationBell";
import { NotificationsProvider } from "./NotificationsProvider";

vi.mock("next/navigation", () => ({ usePathname: () => "/app" }));

const n = (id: string, createdAt: number, readAt: number | null = null): NotificationItem => ({
  id,
  kind: "resume-draft-completed",
  title: id,
  body: "",
  link: null,
  readAt,
  createdAt,
});

describe("mergeNotifications", () => {
  it("새 알림을 최근 순으로 앞에 붙이고, 이미 아는 알림은 새 값으로 바꾼다 — fresh는 처음 보는 읽지 않은 알림", () => {
    const prev = [n("b", 20), n("a", 10)];
    const { items, fresh } = mergeNotifications(prev, [n("c", 30), n("b", 20, 25), n("d", 5, 6)]);
    expect(items.map((x) => x.id)).toEqual(["c", "b", "a", "d"]);
    expect(items[1]!.readAt).toBe(25);
    expect(fresh.map((x) => x.id)).toEqual(["c"]);
  });

  it("limit개까지만 남긴다", () => {
    const { items } = mergeNotifications([], Array.from({ length: 5 }, (_, i) => n(`x${i}`, i)), 3);
    expect(items.map((x) => x.id)).toEqual(["x4", "x3", "x2"]);
  });

  it("nextSince: 가장 최근 시각 - 1초(빈 목록은 null)", () => {
    expect(nextSince([])).toBeNull();
    expect(nextSince([n("a", 5000), n("b", 9000)])).toBe(8000);
  });

  it("applyRead: 고른 것만(이미 읽은 것은 세지 않는다), null이면 모두", () => {
    const state = { items: [n("a", 1), n("b", 2, 3), n("c", 3)], unreadCount: 5 };
    const one = applyRead(state, ["a", "b"], 100);
    expect(one.items.map((x) => x.readAt)).toEqual([100, 3, null]);
    expect(one.unreadCount).toBe(4);
    const all = applyRead(state, null, 100);
    expect(all.items.every((x) => x.readAt !== null)).toBe(true);
    expect(all.unreadCount).toBe(0);
  });
});

describe("알림 도메인", () => {
  it("safeNotificationLink: 앱 안 경로만", () => {
    expect(safeNotificationLink("/app/resumes/x")).toBe("/app/resumes/x");
    expect(safeNotificationLink("/app")).toBe("/app");
    expect(safeNotificationLink("/apple")).toBeNull();
    expect(safeNotificationLink("//evil.example/app")).toBeNull();
    expect(safeNotificationLink("https://evil.example/app")).toBeNull();
    expect(safeNotificationLink("/app/x y")).toBeNull();
    expect(safeNotificationLink("/app\\..")).toBeNull();
    expect(safeNotificationLink(null)).toBeNull();
  });

  it("timeAgo", () => {
    const now = Date.UTC(2026, 10, 7, 12);
    expect(timeAgo(now - 10_000, now)).toBe("방금 전");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5분 전");
    expect(timeAgo(now - 3 * 3600_000, now)).toBe("3시간 전");
    expect(timeAgo(now - 2 * 86400_000, now)).toBe("2일 전");
    expect(timeAgo(now - 30 * 86400_000, now)).toContain("2026");
  });
});

describe("NotificationBell", () => {
  it("배지 숫자는 99+까지", () => {
    expect(badgeText(3)).toBe("3");
    expect(badgeText(120)).toBe("99+");
  });

  it("서버 렌더는 배지 없는 알림 버튼(패널 닫힘)", () => {
    const html = renderToStaticMarkup(<NotificationBell />);
    expect(html).toContain('aria-label="알림"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain('role="dialog"');
  });

  it("첫 목록을 받기 전(서버 렌더)에는 레이아웃이 센 읽지 않은 수로 배지를 그린다 — 새로고침하면 맞는 값", () => {
    const html = renderToStaticMarkup(
      <NotificationsProvider initialUnread={3}>
        <NotificationBell />
      </NotificationsProvider>,
    );
    expect(html).toContain('aria-label="알림 (읽지 않은 알림 3개)"');
    expect(html).toMatch(/>3<\/span>/);
    for (const initialUnread of [0, null]) {
      const none = renderToStaticMarkup(
        <NotificationsProvider initialUnread={initialUnread}>
          <NotificationBell />
        </NotificationsProvider>,
      );
      expect(none).toContain('aria-label="알림"');
      expect(none).not.toContain("rounded-full bg-rose-500");
    }
    const many = renderToStaticMarkup(
      <NotificationsProvider initialUnread={150}>
        <NotificationBell />
      </NotificationsProvider>,
    );
    expect(many).toContain(">99+</span>");
  });

  it("배지 수: 목록을 받았거나 화면에서 읽음 처리를 했으면 저장소 값, 아니면 서버에서 센 값", () => {
    expect(bellUnreadCount({ loaded: false, locallyChanged: false, unreadCount: 0 }, 5)).toBe(5);
    expect(bellUnreadCount({ loaded: false, locallyChanged: false, unreadCount: 0 }, null)).toBe(0);
    expect(bellUnreadCount({ loaded: true, locallyChanged: false, unreadCount: 2 }, 5)).toBe(2);
    // 첫 요청이 실패한 뒤 '모두 읽음' — 서버 값 5에 머물지 않는다.
    expect(bellUnreadCount({ loaded: false, locallyChanged: true, unreadCount: 0 }, 5)).toBe(0);
  });
});
