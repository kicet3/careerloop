import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { migrationsFolder, sqliteFilePath } from "./migrate";

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
    expect(names).toEqual(expect.arrayContaining(["users", "sessions", "diagnoses", "diagnosis_stages", "chat_threads", "chat_messages", "company_resumes", "resume_versions", "job_postings", "posting_imports", "applications", "application_events"]));

    await db.insert(schema.users).values({ id: "u1", email: "a@b.co", passwordHash: "h" });
    const [u] = await db.select().from(schema.users);
    expect(u.createdAt).toBeInstanceOf(Date);
  });

  it("공고를 지우면 진단·이력서·지원·가져오기의 posting_id는 null, 지원을 지우면 이벤트도 지워진다", async () => {
    const { ensureDatabase } = await import("./migrate");
    await ensureDatabase();
    const { db, schema } = await import("./client");
    const { eq } = await import("drizzle-orm");
    await db.insert(schema.users).values({ id: "u2", email: "c@d.co", passwordHash: "h" });
    await db.insert(schema.jobPostings).values({ id: "p1", userId: "u2", company: "토스", roleTitle: "백엔드", urlKey: "toss.im/careers/1" });
    await db.insert(schema.diagnoses).values({
      id: "d1", userId: "u2", title: "t", targetRole: "백엔드", situation: "general", resumeText: "r", model: "m", postingId: "p1",
    });
    await db.insert(schema.companyResumes).values({
      id: "r1", userId: "u2", company: "토스", roleTitle: "백엔드", templateId: "performance", title: "t", postingId: "p1",
    });
    await db.insert(schema.applications).values({ id: "a1", userId: "u2", postingId: "p1", company: "토스", roleTitle: "백엔드", resumeId: "r1" });
    await db.insert(schema.applicationEvents).values({ applicationId: "a1", toStage: "applied" });
    await db.insert(schema.postingImports).values({ id: "i1", userId: "u2", url: "https://toss.im/careers/1", postingId: "p1" });

    // 같은 사용자의 같은 url_key는 하나뿐이다(URL 없는 공고는 여러 개 가능).
    await expect(
      db.insert(schema.jobPostings).values({ id: "p2", userId: "u2", company: "토스", roleTitle: "백엔드", urlKey: "toss.im/careers/1" }),
    ).rejects.toThrow();
    await db.insert(schema.jobPostings).values([
      { id: "p3", userId: "u2", company: "A", roleTitle: "B" },
      { id: "p4", userId: "u2", company: "A", roleTitle: "B" },
    ]);

    await db.delete(schema.jobPostings).where(eq(schema.jobPostings.id, "p1"));
    const [d] = await db.select().from(schema.diagnoses).where(eq(schema.diagnoses.id, "d1"));
    const [r] = await db.select().from(schema.companyResumes).where(eq(schema.companyResumes.id, "r1"));
    const [a] = await db.select().from(schema.applications).where(eq(schema.applications.id, "a1"));
    const [i] = await db.select().from(schema.postingImports).where(eq(schema.postingImports.id, "i1"));
    expect([d!.postingId, r!.postingId, a!.postingId, i!.postingId]).toEqual([null, null, null, null]);
    expect(a!.stage).toBe("applied");
    expect(a!.favorite).toBe(false);

    await db.delete(schema.companyResumes).where(eq(schema.companyResumes.id, "r1"));
    const [a2] = await db.select().from(schema.applications).where(eq(schema.applications.id, "a1"));
    expect(a2!.resumeId).toBeNull();

    await db.delete(schema.applications).where(eq(schema.applications.id, "a1"));
    expect(await db.select().from(schema.applicationEvents)).toEqual([]);
  });
});

describe("0005_google_login (users 테이블 재생성)", () => {
  it("기존 사용자·자식 행을 보존하고, 이후 FK cascade와 nullable password_hash·unique google_sub가 동작한다", async () => {
    const { createClient } = await import("@libsql/client");
    const { drizzle } = await import("drizzle-orm/libsql");
    const { migrate } = await import("drizzle-orm/libsql/migrator");

    // 0004까지만 담은 마이그레이션 폴더
    const partial = path.join(dir, "drizzle-0004");
    cpSync(migrationsFolder(), partial, { recursive: true });
    const journalPath = path.join(partial, "meta", "_journal.json");
    const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: { tag: string }[] };
    const idx = journal.entries.findIndex((e) => e.tag.startsWith("0005_"));
    expect(idx).toBeGreaterThan(0);
    journal.entries = journal.entries.slice(0, idx);
    writeFileSync(journalPath, JSON.stringify(journal));

    const client = createClient({ url: `file:${path.join(dir, "upgrade.db")}` });
    const db = drizzle(client);
    try {
      await migrate(db, { migrationsFolder: partial });
      await client.execute("PRAGMA foreign_keys = ON");
      await client.execute("INSERT INTO users (id, email, name, password_hash) VALUES ('old', 'old@x.co', '옛 사용자', 'hash')");
      await client.execute("INSERT INTO sessions (id, user_id, expires_at) VALUES ('s1', 'old', 9999999999999)");
      await client.execute(
        "INSERT INTO diagnoses (id, user_id, title, target_role, situation, resume_text, model) VALUES ('d1', 'old', 't', 'r', 'general', 'x', 'm')",
      );

      await migrate(db, { migrationsFolder: migrationsFolder() });
      await client.execute("PRAGMA foreign_keys = ON");

      // 재생성 중 DROP TABLE이 자식 행을 cascade 삭제하지 않았다.
      const u = await client.execute("SELECT id, email, name, password_hash, google_sub FROM users");
      expect(u.rows.map((r) => ({ ...r }))).toEqual([
        { id: "old", email: "old@x.co", name: "옛 사용자", password_hash: "hash", google_sub: null },
      ]);
      expect((await client.execute("SELECT count(*) AS n FROM sessions")).rows[0]!.n).toBe(1);
      expect((await client.execute("SELECT count(*) AS n FROM diagnoses")).rows[0]!.n).toBe(1);
      expect((await client.execute("PRAGMA foreign_key_check")).rows).toEqual([]);

      await client.execute("INSERT INTO users (id, email, google_sub) VALUES ('g1', 'g@x.co', 'sub-1')");
      await expect(client.execute("INSERT INTO users (id, email, google_sub) VALUES ('g2', 'g2@x.co', 'sub-1')")).rejects.toThrow();
      await expect(client.execute("INSERT INTO users (id, email) VALUES ('g3', 'old@x.co')")).rejects.toThrow();

      await client.execute("DELETE FROM users WHERE id = 'old'");
      expect((await client.execute("SELECT count(*) AS n FROM sessions")).rows[0]!.n).toBe(0);
      expect((await client.execute("SELECT count(*) AS n FROM diagnoses")).rows[0]!.n).toBe(0);
    } finally {
      client.close();
    }
  });
});
