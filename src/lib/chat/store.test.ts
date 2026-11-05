import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-chat-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let store: typeof import("./store");
let close: () => void;

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  const { db, schema } = await import("@/lib/db/client");
  close = () => db.$client.close();
  for (const id of ["a", "b"]) await db.insert(schema.users).values({ id, email: `${id}@x.com`, passwordHash: "x" });
  store = await import("./store");
});
afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

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

  it("심사위원 스레드는 진단·심사위원이 필요하다", async () => {
    await expect(store.createThread({ userId: "a", kind: "reviewer", title: "x" })).rejects.toThrow();
  });
});
