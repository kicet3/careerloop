import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

type Mod = typeof import("./db-rate-limit");
let m: Mod;
let tdb: TestDb;

beforeAll(async () => {
  tdb = await createTestDb();
  m = await import("./db-rate-limit");
});

afterAll(() => tdb.close());

describe("hitDbLimit", () => {
  const rule = { bucket: "test", limit: 3, windowMs: 60_000 };

  it("창 안에서 한도까지 허용하고, 넘으면 가장 오래된 기록 기준으로 기다릴 시간을 알려 준다", async () => {
    const t0 = 1_000_000;
    for (let i = 0; i < 3; i++) expect((await m.hitDbLimit(rule, "u1", t0 + i * 1000)).ok).toBe(true);
    const over = await m.hitDbLimit(rule, "u1", t0 + 10_000);
    expect(over).toEqual({ ok: false, retryAfterSec: 50 });
    // 다른 키·다른 bucket은 따로 센다
    expect((await m.hitDbLimit(rule, "u2", t0 + 10_000)).ok).toBe(true);
    expect((await m.hitDbLimit({ ...rule, bucket: "other" }, "u1", t0 + 10_000)).ok).toBe(true);
    // 창이 지나면 다시 허용
    expect((await m.hitDbLimit(rule, "u1", t0 + 60_500)).ok).toBe(true);
  });

  it("동시 요청도 한도를 넘지 못한다", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, () => m.hitDbLimit(rule, "burst", 5_000_000)));
    expect(results.filter((r) => r.ok)).toHaveLength(3);
    expect(await tdb.prisma.rateEvent.count({ where: { bucket: "test", key: "burst" } })).toBe(3);
  });

  it("IP는 해시로 저장한다", () => {
    expect(m.ipKey("1.2.3.4")).not.toContain("1.2.3.4");
    expect(m.ipKey("1.2.3.4")).toBe(m.ipKey("1.2.3.4"));
    expect(m.ipKey("1.2.3.4")).not.toBe(m.ipKey("1.2.3.5"));
  });
});
