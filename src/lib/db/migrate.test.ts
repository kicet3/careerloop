import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { sqliteFilePath } from "./migrate";

const dir = mkdtempSync(path.join(os.tmpdir(), "rp-migrate-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("sqliteFilePath", () => {
  it("file: URL만 경로로 바꾼다", () => {
    expect(sqliteFilePath("file:./data/app.db")).toBe(path.resolve("data/app.db"));
    expect(sqliteFilePath("file:///tmp/x.db")).toBe("/tmp/x.db");
    expect(sqliteFilePath("libsql://db.turso.io")).toBeNull();
    expect(sqliteFilePath("file::memory:")).toBeNull();
  });
});

describe("ensureDatabase", () => {
  it("없는 디렉터리를 만들고 마이그레이션을 적용하며, 반복 호출해도 안전하다", async () => {
    process.env.DATABASE_URL = `file:${path.join(dir, "nested", "app.db")}`;
    const { ensureDatabase } = await import("./migrate");
    const p1 = ensureDatabase();
    expect(ensureDatabase()).toBe(p1); // memoized
    await p1;
    await ensureDatabase();

    const { db, schema } = await import("./client");
    const tables = await db.$client.execute("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name");
    const names = tables.rows.map((r) => r.name);
    expect(names).toEqual(expect.arrayContaining(["users", "sessions", "diagnoses", "diagnosis_stages"]));

    await db.insert(schema.users).values({ id: "u1", email: "a@b.co", passwordHash: "h" });
    const [u] = await db.select().from(schema.users);
    expect(u.createdAt).toBeInstanceOf(Date);
  });
});
