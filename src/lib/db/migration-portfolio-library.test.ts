/** 20261110000000_portfolio_library: 이력서 첨부 포트폴리오를 보관함(portfolios)으로 옮기고 portfolio_id로 잇는다, 예전 컬럼 삭제. */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { MAX_PORTFOLIOS_PER_USER } from "@/lib/domain/portfolios";
import { migrationSql } from "@/test/db";

describe("포트폴리오 보관함 마이그레이션", () => {
  it("포트폴리오를 붙인 이력서마다 보관함 항목을 만들어 연결하고 텍스트 키는 그대로 쓴다", async () => {
    const all = migrationSql();
    const idx = all.findIndex((sql) => sql.includes('"_portfolio_backfill"'));
    expect(idx).toBeGreaterThan(0);
    const db = new PGlite();
    try {
      for (const sql of all.slice(0, idx)) await db.exec(sql);
      await db.exec(`
        INSERT INTO users (id, email) VALUES ('u', 'u@x.com'), ('v', 'v@x.com');
        INSERT INTO company_resumes (id, user_id, kind, company, role_title, template_id, title, updated_at,
            portfolio_kind, portfolio_file_name, portfolio_url, portfolio_text_key, portfolio_chars, portfolio_updated_at) VALUES
          ('r-file', 'u', 'company', 'A', 'B', 'classic', 'A B', '2026-01-01', 'file', '정산 포트폴리오.pdf', NULL, 'users/u/resumes/r-file/portfolio-abc.txt', 1234, '2026-03-01T00:00:00Z'),
          ('r-url',  'u', 'company', 'C', 'D', 'classic', 'C D', '2026-01-02T00:00:00Z', 'url', NULL, 'https://user:pw@Me.Dev:8080/work?q=1', NULL, NULL, NULL),
          ('r-bad',  'u', 'company', 'E', 'F', 'classic', 'E F', '2026-01-03', 'url', NULL, 'not a url', NULL, NULL, '2026-03-02'),
          ('r-none', 'u', 'general', '', '', 'classic', '공용', '2026-01-04', NULL, NULL, NULL, NULL, NULL, NULL),
          ('r-weird','v', 'company', 'G', 'H', 'classic', 'G H', '2026-01-05', 'video', 'x.mp4', NULL, NULL, NULL, NULL),
          ('r-long', 'v', 'company', 'I', 'J', 'classic', 'I J', '2026-01-06', 'file', '${"가".repeat(150)}.pdf', NULL, 'users/v/resumes/r-long/portfolio-x.txt', 10, NULL);
      `);
      for (const sql of all.slice(idx)) await db.exec(sql);

      const resumes = (await db.query<{ id: string; portfolio_id: string | null }>(`SELECT id, portfolio_id FROM company_resumes ORDER BY id`)).rows;
      const byResume = Object.fromEntries(resumes.map((r) => [r.id, r.portfolio_id]));
      expect(byResume["r-none"]).toBeNull();
      expect(byResume["r-weird"]).toBeNull();
      for (const id of ["r-file", "r-url", "r-bad", "r-long"]) expect(byResume[id]).toMatch(/^[0-9a-f]{16}$/);

      const rows = (
        await db.query<Record<string, unknown>>(
          `SELECT id, user_id, title, description, kind, file_name, url, text_key, chars, updated_at FROM portfolios ORDER BY id`,
        )
      ).rows;
      expect(rows).toHaveLength(4);
      const pf = (rid: string) => rows.find((r) => r.id === byResume[rid])!;
      expect(pf("r-file")).toMatchObject({
        user_id: "u",
        title: "정산 포트폴리오.pdf",
        description: null,
        kind: "file",
        file_name: "정산 포트폴리오.pdf",
        url: null,
        text_key: "users/u/resumes/r-file/portfolio-abc.txt",
        chars: 1234,
      });
      expect((pf("r-file").updated_at as Date).toISOString()).toBe("2026-03-01T00:00:00.000Z");
      expect(pf("r-url")).toMatchObject({ title: "Me.Dev", kind: "url", url: "https://user:pw@Me.Dev:8080/work?q=1", file_name: null, text_key: null, chars: null });
      expect((pf("r-url").updated_at as Date).toISOString()).toBe("2026-01-02T00:00:00.000Z");
      expect(pf("r-bad")).toMatchObject({ title: "E F 포트폴리오", kind: "url" });
      expect(pf("r-long")).toMatchObject({ user_id: "v", kind: "file" });
      expect(Array.from(String(pf("r-long").title))).toHaveLength(120);

      // 예전 컬럼은 사라진다.
      const cols = (
        await db.query<{ column_name: string }>(`SELECT column_name FROM information_schema.columns WHERE table_name = 'company_resumes' AND column_name LIKE 'portfolio%'`)
      ).rows.map((r) => r.column_name);
      expect(cols).toEqual(["portfolio_id"]);
      // RLS
      expect((await db.query<{ r: boolean }>(`SELECT relrowsecurity AS r FROM pg_class WHERE relname = 'portfolios'`)).rows).toEqual([{ r: true }]);

      // 포트폴리오를 지우면 이력서에서만 떨어진다(SET NULL), 사용자를 지우면 포트폴리오도 지워진다(CASCADE).
      await db.exec(`DELETE FROM portfolios WHERE id = '${byResume["r-file"]}'`);
      expect((await db.query<{ p: string | null }>(`SELECT portfolio_id AS p FROM company_resumes WHERE id = 'r-file'`)).rows).toEqual([{ p: null }]);
      await db.exec(`DELETE FROM users WHERE id = 'v'`);
      expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM portfolios WHERE user_id = 'v'`)).rows).toEqual([{ n: 0 }]);
    } finally {
      await db.close();
    }
  });

  it("한 사용자의 이력서가 상한(MAX_PORTFOLIOS_PER_USER)보다 많아도 모두 옮긴다(목록은 자르지 않는다)", async () => {
    const all = migrationSql();
    const idx = all.findIndex((sql) => sql.includes('"_portfolio_backfill"'));
    const db = new PGlite();
    try {
      for (const sql of all.slice(0, idx)) await db.exec(sql);
      const n = MAX_PORTFOLIOS_PER_USER + 10;
      const values = Array.from(
        { length: n },
        (_, i) => `('r${i}', 'u', 'company', 'A', 'B', 'classic', 'A B ${i}', '2026-01-01', 'url', NULL, 'https://a${i}.dev', NULL, NULL, NULL)`,
      ).join(",\n");
      await db.exec(`
        INSERT INTO users (id, email) VALUES ('u', 'u@x.com');
        INSERT INTO company_resumes (id, user_id, kind, company, role_title, template_id, title, updated_at,
            portfolio_kind, portfolio_file_name, portfolio_url, portfolio_text_key, portfolio_chars, portfolio_updated_at) VALUES ${values};
      `);
      for (const sql of all.slice(idx)) await db.exec(sql);
      expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM portfolios WHERE user_id = 'u'`)).rows).toEqual([{ n }]);
      expect(
        (await db.query<{ n: number }>(`SELECT count(DISTINCT portfolio_id)::int AS n FROM company_resumes WHERE portfolio_id IS NOT NULL`)).rows,
      ).toEqual([{ n }]);
    } finally {
      await db.close();
    }
  });
});
