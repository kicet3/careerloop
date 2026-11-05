import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let store: typeof import("./store");
let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["a", "b"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  store = await import("./store");
});
afterAll(() => tdb.close());

describe("chat store", () => {
  it("스레드·메시지 CRUD와 소유권", async () => {
    const t = await store.createThread({ userId: "a", kind: "graph", title: "경력 정리" });
    expect(await store.getThread("b", t.id)).toBeNull();
    expect(await store.addMessage("b", { threadId: t.id, role: "user", content: "x" })).toBeNull();

    await store.addMessage("a", { threadId: t.id, role: "user", content: "첫 번째" });
    const m = await store.addMessage("a", {
      threadId: t.id,
      role: "assistant",
      content: "변경안",
      status: "proposed",
      data: { kind: "graph-proposal", ops: [], summary: "", followUpQuestions: [] },
    });
    await store.addMessage("a", { threadId: t.id, role: "user", content: "세 번째" });
    expect((await store.listMessages("a", t.id))!.map((x) => x.content)).toEqual(["첫 번째", "변경안", "세 번째"]);
    expect((await store.listMessages("a", t.id, { limit: 2 }))!.map((x) => x.content)).toEqual(["변경안", "세 번째"]);
    expect(await store.listMessages("b", t.id)).toBeNull();

    // 조건부 상태 전환(중복 적용 방지)
    expect(await store.updateMessage("b", m!.id, { status: "applied" })).toBeNull();
    expect((await store.updateMessage("a", m!.id, { status: "applied" }, { expectStatus: "proposed" }))!.status).toBe("applied");
    expect(await store.updateMessage("a", m!.id, { status: "applied" }, { expectStatus: "proposed" })).toBeNull();

    expect((await store.listThreads("a", { kind: "graph" })).map((x) => x.id)).toEqual([t.id]);
    expect(await store.listThreads("b")).toEqual([]);
    expect(await store.deleteThread("b", t.id)).toBe(false);
    expect(await store.deleteThread("a", t.id)).toBe(true);
    expect(await store.getMessage("a", m!.id)).toBeNull();
  });

  it("expectLastId: 마지막 메시지가 기대와 같을 때만 넣고, 동시 요청은 하나만 성공한다", async () => {
    const t = await store.createThread({ userId: "a", kind: "graph", title: "동시성" });
    const first = await store.addMessage("a", { threadId: t.id, role: "user", content: "1" }, { expectLastId: null });
    await expect(store.addMessage("a", { threadId: t.id, role: "user", content: "x" }, { expectLastId: null })).rejects.toBeInstanceOf(
      store.ConcurrentMessageError,
    );
    const results = await Promise.allSettled(
      ["a1", "a2", "a3"].map((content) => store.addMessage("a", { threadId: t.id, role: "assistant", content }, { expectLastId: first!.id })),
    );
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toBeInstanceOf(store.ConcurrentMessageError);
    const msgs = (await store.listMessages("a", t.id))!;
    expect(msgs).toHaveLength(2);
    expect(msgs[1]!.createdAt).toBeGreaterThan(msgs[0]!.createdAt);
    expect((await store.getThread("a", t.id))!.updatedAt).toBe(msgs[1]!.createdAt);
    // NUL은 저장 전에 지운다(Postgres text·jsonb는 NUL을 받지 않는다).
    const nul = await store.addMessage("a", { threadId: t.id, role: "user", content: "a\u0000b" });
    expect(nul!.content).toBe("ab");
  });

  it("심사위원 스레드는 진단·심사위원이 필요하다", async () => {
    await expect(store.createThread({ userId: "a", kind: "reviewer", title: "x" })).rejects.toThrow();
  });
});
