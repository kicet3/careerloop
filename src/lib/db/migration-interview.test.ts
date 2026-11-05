/** 20261108000000_interview_status_portfolio_capture: 기존 이력서 상태 채우기(지원 전 / 지원서를 낸 기록이 있으면 지원 완료). */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrationSql } from "@/test/db";

describe("면접·지원 상태·포트폴리오·캡처 마이그레이션", () => {
  it("지원처별 이력서는 draft, 지원서를 낸 기록이 연결된 이력서는 submitted, 공용은 null", async () => {
    const all = migrationSql();
    const idx = all.findIndex((sql) => sql.includes('CREATE TABLE "interview_sessions"'));
    expect(idx).toBeGreaterThan(0);
    const db = new PGlite();
    try {
      for (const sql of all.slice(0, idx)) await db.exec(sql);
      await db.exec(`INSERT INTO users (id, email) VALUES ('u', 'u@x.com')`);
      await db.exec(`
        INSERT INTO company_resumes (id, user_id, kind, company, role_title, template_id, title) VALUES
          ('c1', 'u', 'company', 'A', 'B', 'classic', 'A B'),
          ('c2', 'u', 'company', 'C', 'D', 'classic', 'C D'),
          ('c3', 'u', 'company', 'E', 'F', 'classic', 'E F'),
          ('g1', 'u', 'general', '', '', 'classic', '공용');
        INSERT INTO applications (id, user_id, company, role_title, stage, resume_id, updated_at) VALUES
          ('a-old', 'u', 'A', 'B', 'applied', 'c1', '2026-01-01'),
          ('a-new', 'u', 'A', 'B', 'interview', 'c1', '2026-02-01'),
          ('a-int', 'u', 'C', 'D', 'interested', 'c2', '2026-02-01'),
          ('a-gen', 'u', 'X', 'Y', 'applied', 'g1', '2026-02-01');
      `);
      for (const sql of all.slice(idx)) await db.exec(sql);
      const rows = (
        await db.query<{ id: string; apply_status: string | null; submitted_application_id: string | null }>(
          `SELECT id, apply_status, submitted_application_id FROM company_resumes ORDER BY id`,
        )
      ).rows;
      expect(rows).toEqual([
        { id: "c1", apply_status: "submitted", submitted_application_id: "a-new" },
        { id: "c2", apply_status: "draft", submitted_application_id: null },
        { id: "c3", apply_status: "draft", submitted_application_id: null },
        { id: "g1", apply_status: null, submitted_application_id: null },
      ]);
      // 지원 기록을 지우면 연결만 끊긴다(SET NULL).
      await db.exec(`DELETE FROM applications WHERE id = 'a-new'`);
      expect((await db.query<{ s: string | null }>(`SELECT submitted_application_id AS s FROM company_resumes WHERE id = 'c1'`)).rows).toEqual([{ s: null }]);
      // 캡처 컬럼 기본값
      const cols = (
        await db.query<{ column_name: string }>(
          `SELECT column_name FROM information_schema.columns WHERE table_name = 'shared_postings' AND column_name LIKE 'capture%' ORDER BY 1`,
        )
      ).rows.map((r) => r.column_name);
      expect(cols).toContain("capture_status");
      expect(cols).toContain("capture_attempts");
    } finally {
      await db.close();
    }
  });
});
