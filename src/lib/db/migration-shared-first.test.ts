/** 20261109000000_shared_first_postings: url·url_key nullable, 공용 공고 없는 보관 공고 백필(같은 주소면 연결), 담은 수 다시 세기. */
import { PGlite } from "@electric-sql/pglite";
import { describe, expect, it } from "vitest";
import { migrationSql } from "@/test/db";

describe("공용 공고 먼저 마이그레이션", () => {
  it("공용 공고가 없는 보관 공고마다 공개 필드만 담은 공용 공고를 만들어 연결한다", async () => {
    const all = migrationSql();
    const idx = all.findIndex((sql) => sql.includes('"_shared_backfill"'));
    expect(idx).toBe(all.length - 1);
    const db = new PGlite();
    try {
      for (const sql of all.slice(0, idx)) await db.exec(sql);
      await db.exec(`
        INSERT INTO users (id, email) VALUES ('u', 'u@x.com'), ('v', 'v@x.com');
        INSERT INTO shared_postings (id, url_key, url, company, role_title, extracted_by, importer_count, created_by, fetched_at)
          VALUES ('sp-url', 'x.com/1', 'https://x.com/1', 'X', 'R', 'anthropic', 9, 'v', now());
        INSERT INTO shared_postings (id, url_key, url, company, role_title, extracted_by, importer_count, created_by, fetched_at, hidden_at)
          VALUES ('sp-hidden', 'corp.example/private', 'https://corp.example/private', 'H', 'R', 'anthropic', 0, 'v', now(), now());
        INSERT INTO job_postings (id, user_id, company, role_title, url, url_key, platform, status, jd_text, note, deadline, location, shared_posting_id) VALUES
          ('j-linked', 'v', 'X', 'R', 'https://x.com/1', 'x.com/1', NULL, 'saved', 'JD', NULL, NULL, NULL, 'sp-url'),
          ('j-same',   'u', 'X2', 'R2', 'https://x.com/1', 'x.com/1', NULL, 'saved', 'JD', NULL, NULL, NULL, NULL),
          ('j-manual', 'u', 'M', 'Dev', 'https://intra.example/p', 'intra.example/p', 'intra', 'applied', 'manual JD', 'secret note', '2026-12-01', 'Seoul', NULL),
          ('j-bare',   'u', 'N', 'Ops', NULL, NULL, NULL, 'saved', NULL, 'note2', NULL, NULL, NULL),
          ('j-hid',    'u', 'H', 'R', 'https://corp.example/private', 'corp.example/private', NULL, 'saved', 'private JD', NULL, NULL, NULL, NULL);
      `);
      for (const sql of all.slice(idx)) await db.exec(sql);

      const jobs = (await db.query<{ id: string; shared_posting_id: string | null }>(`SELECT id, shared_posting_id FROM job_postings ORDER BY id`)).rows;
      expect(jobs.every((j) => j.shared_posting_id)).toBe(true);
      const byId = Object.fromEntries(jobs.map((j) => [j.id, j.shared_posting_id!]));
      expect(byId["j-same"]).toBe("sp-url");
      // 관리자가 숨긴 주소: 숨긴 공용 공고에 연결되고 보이는 사본을 만들지 않는다.
      expect(byId["j-hid"]).toBe("sp-hidden");
      expect(byId["j-manual"]).not.toBe(byId["j-bare"]);

      const shared = (
        await db.query<Record<string, unknown>>(
          `SELECT id, url, url_key, company, role_title, jd_text, deadline, location, platform, extracted_by, created_by, importer_count, source_text, hidden_at IS NOT NULL AS hidden FROM shared_postings ORDER BY id`,
        )
      ).rows;
      expect(shared).toHaveLength(4);
      // 소급 공개하지 않는다: 백필한 공용 공고는 모두 숨긴 채로 만든다(예전 안내 아래 입력된 공고).
      expect(shared.filter((s) => s.extracted_by === "manual").every((s) => s.hidden === true)).toBe(true);
      expect(shared.find((s) => s.id === "sp-url")).toMatchObject({ hidden: false });
      const manual = shared.find((s) => s.id === byId["j-manual"])!;
      expect(manual).toMatchObject({
        url: null,
        url_key: null,
        company: "M",
        role_title: "Dev",
        jd_text: "manual JD",
        deadline: "2026-12-01",
        location: "Seoul",
        platform: null,
        extracted_by: "manual",
        created_by: "u",
        importer_count: 1,
        source_text: null,
        hidden: true,
      });
      expect(String(manual.id)).toHaveLength(21);
      expect(JSON.stringify(shared)).not.toContain("secret note");
      expect(shared.find((s) => s.id === "sp-url")).toMatchObject({ importer_count: 2 });
      expect(shared.find((s) => s.id === "sp-hidden")).toMatchObject({ importer_count: 1, hidden: true });

      // 탈퇴(사용자 삭제): 보관 공고는 지워지고 공용 공고는 created_by만 null로 남는다.
      await db.exec(`DELETE FROM users WHERE id = 'u'`);
      expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shared_postings WHERE created_by IS NULL`)).rows).toEqual([{ n: 2 }]);
      expect((await db.query<{ n: number }>(`SELECT count(*)::int AS n FROM shared_postings`)).rows).toEqual([{ n: 4 }]);
    } finally {
      await db.close();
    }
  });
});
