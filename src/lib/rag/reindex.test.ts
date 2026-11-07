/** 관리자 일괄 재색인: 마감으로 중간에 멈춘 사용자를 건너뛰지 않는다(nextCursor는 그 앞 사용자). */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const users = [{ id: "u1" }, { id: "u2" }, { id: "u3" }];
const done = new Map<string, boolean>();
vi.mock("@/lib/db/client", () => ({
  prisma: {
    user: {
      findMany: async ({ where }: { where: { id?: { gt: string } } }) => users.filter((u) => !where.id || u.id > where.id.gt).slice(0, 20),
    },
  },
}));
vi.mock("@/lib/auth/db-rate-limit", () => ({ hitDbLimit: async () => ({ ok: true }) }));
vi.mock("./chunks/sync", () => ({
  reindexUser: async (id: string) => ({ synced: 1, deleted: 0, done: done.get(id) ?? true }),
}));

beforeEach(() => done.clear());

describe("reindexAll", () => {
  it("모두 끝나면 done, nextCursor 없음", async () => {
    const { reindexAll } = await import("./reindex");
    expect(await reindexAll({ deadlineAt: Date.now() + 60_000 })).toEqual({ processed: 3, nextCursor: null, done: true });
  });

  it("u2가 마감으로 중간에 멈추면 nextCursor=u1(다음 호출이 u2부터), partialUserId=u2", async () => {
    const { reindexAll } = await import("./reindex");
    done.set("u2", false);
    expect(await reindexAll({ deadlineAt: Date.now() + 60_000 })).toEqual({ processed: 1, nextCursor: "u1", partialUserId: "u2", done: false });
    done.clear();
    expect(await reindexAll({ cursor: "u1", deadlineAt: Date.now() + 60_000 })).toMatchObject({ processed: 2, done: true });
  });

  it("단일 사용자·본인 재색인도 미완료를 성공으로 알리지 않는다", async () => {
    const { reindexAll, reindexOwn } = await import("./reindex");
    done.set("u1", false);
    expect(await reindexAll({ userId: "u1", deadlineAt: Date.now() + 60_000 })).toMatchObject({ processed: 0, done: false, partialUserId: "u1" });
    expect(await reindexOwn("u1")).toMatchObject({ ok: true, done: false });
  });
});
