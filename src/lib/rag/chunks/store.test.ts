/**
 * 청크 저장소(PGlite): 사양 테스트 7(B 문서가 더 유사해도 A에 미전달) + FTS 문법 주입 퍼징 + 빈 범위 미실행 + 모든 SQL의 user_id 조건.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { A_ID, B_ID, B_SECRET, expectNoB, memoryGraphs, seedUsers } from "../__fixtures__/two-users";
import { queryLexemes, sanitizeLexeme } from "./build";
import { chunkId, getChunksByIds, searchChunksQuery, searchChunksSql } from "./store";
import { syncSource } from "./sync";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
const graphs = memoryGraphs();
const graphNodeIds = async (u: string) => new Set((await graphs.load(u)).nodes.map((n) => n.id));
beforeAll(async () => {
  tdb = await createTestDb();
  await seedUsers(tdb.prisma);
  await syncSource(A_ID, "repo-brief", "snap_a", { graphNodeIds });
  await syncSource(B_ID, "repo-brief", "snap_b", { graphNodeIds });
});
afterAll(() => tdb.close());

describe("searchChunksSql", () => {
  it("B의 청크가 전역 1위여도 A의 결과는 A 청크뿐(사용자 선필터 CTE)", async () => {
    const lexemes = queryLexemes("결제 개편 역할");
    // 전역 순위(검증용 원시 SQL)에서는 B가 1위다.
    const global = await tdb.pglite.query<{ user_id: string }>(
      `SELECT user_id FROM experience_chunks, to_tsquery('simple', array_to_string($1::text[], ' | ')) q WHERE tsv @@ q ORDER BY ts_rank_cd(tsv, q) DESC LIMIT 1`,
      [lexemes],
    );
    expect(global.rows[0]?.user_id).toBe(B_ID);
    const rows = await searchChunksSql({ principalUserId: A_ID }, { lexemes, limit: 8 });
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.user_id === A_ID)).toBe(true);
    expectNoB(rows.map((r) => JSON.stringify(r)));
    // B의 노드 id로 범위를 줘도(같은 프로젝트명) A 행만.
    expect(await searchChunksSql({ principalUserId: A_ID }, { lexemes, nodeIds: ["nb_project"], limit: 8 })).toEqual([]);
    expect((await searchChunksSql({ principalUserId: A_ID }, { lexemes, nodeIds: ["na_project"], limit: 8 })).every((r) => r.user_id === A_ID)).toBe(true);
    // 반환 열에 content가 없다.
    expect(Object.keys(rows[0]!)).not.toContain("content");
  });

  it("lexeme이 전부 기호·빈 범위면 SQL을 실행하지 않고 빈 결과", async () => {
    const spy = vi.spyOn(tdb.prisma, "$transaction");
    expect(queryLexemes(`'&|!():*<-> "" `)).toEqual([]);
    expect(await searchChunksSql({ principalUserId: A_ID }, { lexemes: queryLexemes("'&|!():*"), limit: 5 })).toEqual([]);
    expect(await searchChunksSql({ principalUserId: A_ID }, { lexemes: ["결제"], nodeIds: [], limit: 5 })).toEqual([]);
    expect(await searchChunksSql({ principalUserId: "" }, { lexemes: ["결제"], limit: 5 })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });

  it("sanitizeLexeme 퍼징(무작위 유니코드 1만 개): to_tsquery 문법 오류 0건, 결과는 늘 A 범위", async () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2147483648), seed / 2147483648);
    const pool = "&|!():*<->'\"\\\u0000;- ORANDNOT결제개편역할ab12　＆｜é\u{1F600}%#+_";
    const lexemes: string[] = [];
    for (let i = 0; i < 10_000; i++) {
      let s = "";
      const len = 1 + Math.floor(rnd() * 12);
      for (let j = 0; j < len; j++) {
        s += rnd() < 0.3 ? String.fromCodePoint(Math.floor(rnd() * 0x2ffff)) : [...pool][Math.floor(rnd() * [...pool].length)];
      }
      lexemes.push(s);
    }
    const clean = lexemes.map(sanitizeLexeme).filter(Boolean);
    for (const l of clean) expect(l).toMatch(/^[\p{L}\p{N}]+$/u);
    // 한 번에 to_tsquery로 확인(파라미터 배열 → SQL 안에서 결합)
    for (let i = 0; i < clean.length; i += 500) {
      await tdb.pglite.query(`SELECT to_tsquery('simple', array_to_string($1::text[], ' | '))`, [clean.slice(i, i + 500)]);
    }
    // 검색 함수 경로(사용자 범위)로도 일부
    for (let i = 0; i < 640; i += 32) {
      const rows = await searchChunksSql({ principalUserId: A_ID }, { lexemes: lexemes.slice(i, i + 32), limit: 8 });
      expect(rows.every((r) => r.user_id === A_ID)).toBe(true);
    }
  });

  it("실행 계획: searchChunksSql이 실제로 실행하는 문장에서 사용자 선필터(MATERIALIZED CTE)가 FTS보다 먼저", async () => {
    const sql = searchChunksQuery(A_ID, { lexemes: queryLexemes("결제 개편"), nodeIds: ["na_project"], sourceTypes: ["repo-brief"], limit: 8 })!;
    expect(sql).not.toBeNull();
    // 실행 경로가 같은 문장을 쓰는지(스파이로 실제 $queryRaw 인자 확인).
    const seen: string[] = [];
    const orig = tdb.prisma.$transaction.bind(tdb.prisma);
    const spy = vi.spyOn(tdb.prisma, "$transaction").mockImplementation(((fn: (tx: unknown) => unknown) =>
      orig(async (tx) => {
        const q = tx.$queryRaw.bind(tx);
        return fn(
          new Proxy(tx, {
            get: (t, k) =>
              k === "$queryRaw"
                ? (arg: { text?: string }) => {
                    seen.push(String(arg?.text ?? ""));
                    return q(arg as never);
                  }
                : Reflect.get(t, k),
          }),
        );
      })) as never);
    await searchChunksSql({ principalUserId: A_ID }, { lexemes: queryLexemes("결제 개편"), nodeIds: ["na_project"], sourceTypes: ["repo-brief"], limit: 8 });
    spy.mockRestore();
    expect(seen).toEqual([sql.text]);
    const plan = await tdb.pglite.query<{ "QUERY PLAN": string }>(`EXPLAIN ${sql.text}`, sql.values as unknown[]);
    const text = plan.rows.map((r) => r["QUERY PLAN"]).join("\n");
    expect(text).toMatch(/CTE mine/);
    // FTS 조건(@@)은 CTE 결과(mine) 위에서만, user_id 조건은 CTE 안(테이블 스캔)에 있다 — 전역 FTS 후보를 먼저 뽑지 않는다.
    expect(text).toMatch(/CTE Scan on mine[\s\S]*@@/);
    const cte = text.slice(text.indexOf("CTE mine"), text.indexOf("CTE Scan on mine"));
    expect(cte).toContain("user_id");
    expect(cte).not.toContain("@@");
  });

  it("청크 id는 결정적: 같은 글을 다시 색인하면 id·인용 재검증 대상이 그대로", async () => {
    const before = (await tdb.pglite.query<{ id: string }>(`SELECT id FROM experience_chunks WHERE user_id = $1 ORDER BY ordinal`, [A_ID])).rows.map((r) => r.id);
    await syncSource(A_ID, "repo-brief", "snap_a", { graphNodeIds });
    const after = (await tdb.pglite.query<{ id: string }>(`SELECT id FROM experience_chunks WHERE user_id = $1 ORDER BY ordinal`, [A_ID])).rows.map((r) => r.id);
    expect(after).toEqual(before);
    expect((await getChunksByIds(A_ID, before)).length).toBe(before.length);
    expect(chunkId(A_ID, "repo-brief", "snap_a", 0, "h")).not.toBe(chunkId(B_ID, "repo-brief", "snap_a", 0, "h"));
    expect(chunkId(A_ID, "repo-brief", "snap_a", 0, "h")).toMatch(/^ch_[0-9a-f]{22}$/);
  });
});

describe("store.ts SQL 정적 검사", () => {
  it("experience_chunks를 다루는 모든 SQL 문장에 user_id 조건(INSERT는 users에서 principal을 골라 넣는다)", () => {
    const src = readFileSync(path.join(import.meta.dirname, "store.ts"), "utf8");
    const statements = [...src.matchAll(/(?:\$(?:queryRaw|executeRaw)(?:<[^>]*>)?|Prisma\.sql)`([\s\S]*?)`/g)].map((m) => m[1]!);
    expect(statements.length).toBeGreaterThanOrEqual(7);
    for (const sql of statements) {
      if (!/experience_chunks/.test(sql)) continue;
      if (/^\s*INSERT/i.test(sql)) expect(sql).toMatch(/FROM users u WHERE u\.id = \$\{userId\}/);
      else expect(sql, sql).toMatch(/user_id = \$\{(principal|principalUserId|userId)\}/);
    }
    expect(src).not.toContain(B_SECRET);
  });
});
