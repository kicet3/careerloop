import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-google-user-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let upsertGoogleUser: typeof import("./google-user").upsertGoogleUser;
let db: typeof import("@/lib/db/client").db;
let schema: typeof import("@/lib/db/client").schema;

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  ({ db, schema } = await import("@/lib/db/client"));
  ({ upsertGoogleUser } = await import("./google-user"));
});
afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function user(id: string) {
  const { eq } = await import("drizzle-orm");
  const [u] = await db.select().from(schema.users).where(eq(schema.users.id, id));
  return u;
}

describe("upsertGoogleUser", () => {
  it("처음이면 비밀번호 없는 사용자를 만들고, 다시 오면 같은 사용자", async () => {
    const r = await upsertGoogleUser({ sub: "g-1", email: "new@gmail.com", name: "새 사용자" });
    expect(r).toMatchObject({ ok: true, created: true });
    if (!r.ok) throw new Error();
    const u = await user(r.userId);
    expect(u).toMatchObject({ email: "new@gmail.com", name: "새 사용자", passwordHash: null, googleSub: "g-1" });

    // 이메일이 바뀌어도 sub로 찾는다.
    expect(await upsertGoogleUser({ sub: "g-1", email: "changed@gmail.com", name: null })).toEqual({
      ok: true,
      userId: r.userId,
      created: false,
      linked: false,
    });
  });

  it("같은 이메일(대소문자 무시)의 비밀번호 계정에 연결하고, 기존 비밀번호·세션은 없앤다", async () => {
    await db.insert(schema.users).values({ id: "pw1", email: "old@example.com", passwordHash: "h" });
    await db.insert(schema.sessions).values({ id: "s-pw1", userId: "pw1", expiresAt: new Date(Date.now() + 60_000) });
    const r = await upsertGoogleUser({ sub: "g-2", email: "Old@Example.com", name: "x", hd: "example.com" });
    expect(r).toEqual({ ok: true, userId: "pw1", created: false, linked: true });
    expect(await user("pw1")).toMatchObject({ googleSub: "g-2", passwordHash: null });
    const { eq } = await import("drizzle-orm");
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, "pw1"))).toEqual([]);
  });

  it("먼저 같은 gmail 주소로 비밀번호 가입해 둔 사람은 Google 로그인 뒤 접근을 잃는다(선점 가입 차단)", async () => {
    await db.insert(schema.users).values({ id: "pre", email: "victim@gmail.com", passwordHash: "attacker-hash" });
    await db.insert(schema.sessions).values({ id: "s-pre", userId: "pre", expiresAt: new Date(Date.now() + 60_000) });
    const r = await upsertGoogleUser({ sub: "g-victim", email: "victim@gmail.com", name: null });
    expect(r).toEqual({ ok: true, userId: "pre", created: false, linked: true });
    expect(await user("pre")).toMatchObject({ googleSub: "g-victim", passwordHash: null });
    const { eq } = await import("drizzle-orm");
    expect(await db.select().from(schema.sessions).where(eq(schema.sessions.userId, "pre"))).toEqual([]);
  });

  it("Google이 소유를 보증하지 않는 도메인(gmail 아님, hd 불일치)이면 연결하지 않는다", async () => {
    await db.insert(schema.users).values({ id: "pw2", email: "alice@company.com", passwordHash: "h2" });
    for (const hd of [undefined, "other.com"]) {
      expect(await upsertGoogleUser({ sub: "g-alice", email: "alice@company.com", name: null, hd })).toEqual({
        ok: false,
        reason: "unverified_email",
      });
    }
    expect(await user("pw2")).toMatchObject({ googleSub: null, passwordHash: "h2" });
  });

  it("이미 다른 Google 계정과 연결된 이메일이면 conflict", async () => {
    expect(await upsertGoogleUser({ sub: "g-3", email: "old@example.com", name: null, hd: "example.com" })).toEqual({
      ok: false,
      reason: "conflict",
    });
    expect((await user("pw1"))!.googleSub).toBe("g-2");
  });

  it("google_sub는 유일하다", async () => {
    await expect(db.insert(schema.users).values({ id: "dup", email: "dup@x.com", googleSub: "g-2" })).rejects.toThrow();
  });
});
