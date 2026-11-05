/** 20261107000000_sharing_admin_consents: 기존 회원은 approved, 새 회원 기본값은 pending, 기존 이력서는 company. */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrationSql } from "@/test/db";

describe("공유·승인·동의 마이그레이션", () => {
  it("기존 회원을 승인하고 새 가입은 대기로 둔다", async () => {
    const all = migrationSql();
    const idx = all.findIndex((sql) => sql.includes('CREATE TABLE "shared_postings"'));
    expect(idx).toBeGreaterThan(0);
    const db = new PGlite();
    try {
      for (const sql of all.slice(0, idx)) await db.exec(sql);
      await db.exec(`INSERT INTO users (id, email) VALUES ('old', 'old@x.com')`);
      await db.exec(
        `INSERT INTO company_resumes (id, user_id, company, role_title, template_id, title) VALUES ('r', 'old', 'A', 'B', 'classic', 'A B')`,
      );
      for (const sql of all.slice(idx)) await db.exec(sql);
      await db.exec(`INSERT INTO users (id, email) VALUES ('new', 'new@x.com')`);
      const users = (await db.query<{ id: string; status: string; role: string; approved_by: string | null }>(
        `SELECT id, status, role, approved_by FROM users ORDER BY id`,
      )).rows;
      expect(users).toEqual([
        { id: "new", status: "pending", role: "user", approved_by: null },
        { id: "old", status: "approved", role: "user", approved_by: "system:migration" },
      ]);
      expect((await db.query<{ kind: string }>(`SELECT kind FROM company_resumes`)).rows).toEqual([{ kind: "company" }]);
    } finally {
      await db.close();
    }
  });
});
