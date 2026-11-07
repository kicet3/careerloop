/**
 * 동기화·삭제 연쇄(PGlite + 로컬 저장소): 사양 테스트 9⑦(syncSource는 원문 인자를 받지 않고 B의 출처 id로는 아무것도 쓰지 않음),
 * 14④(포트폴리오 삭제 → 청크 삭제, 다음 검색에 없음), 버전 트리거(권한·데이터·출처).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { A_ID, B_ID, B_SECRET, memoryGraphs, seedUsers } from "../__fixtures__/two-users";
import { readRagState } from "../versions";
import { readAuthoritativeSource, sourceExistsElsewhere } from "./authoritative";
import { queryLexemes } from "./build";
import { countUserChunks, searchChunksSql } from "./store";
import { reindexUser, syncSource } from "./sync";

vi.mock("server-only", () => ({}));
process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rag-sync-")), "storage");
for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL"]) delete process.env[k];

let tdb: TestDb;
const graphs = memoryGraphs();
const deps = { graphNodeIds: async (u: string) => new Set((await graphs.load(u)).nodes.map((n) => n.id)) };
const A_TEXT = "포트폴리오: 결제 시스템 개편에서 백엔드 리드로 정산 배치를 재설계했다. Kotlin 사용.";
const B_TEXT = `포트폴리오: 결제 시스템 개편 PM. 매출 300% 증가 ${B_SECRET}`;

beforeAll(async () => {
  tdb = await createTestDb();
  await seedUsers(tdb.prisma);
  const { putObject } = await import("@/lib/storage");
  await putObject(`users/${A_ID}/portfolios/pf_a/text-1.txt`, A_TEXT);
  await putObject(`users/${B_ID}/portfolios/pf_b/text-1.txt`, B_TEXT);
  await tdb.prisma.portfolio.create({ data: { id: "pf_a", userId: A_ID, title: "A 포트폴리오", kind: "file", textKey: `users/${A_ID}/portfolios/pf_a/text-1.txt`, chars: A_TEXT.length } });
  await tdb.prisma.portfolio.create({ data: { id: "pf_b", userId: B_ID, title: "B 포트폴리오", kind: "file", textKey: `users/${B_ID}/portfolios/pf_b/text-1.txt`, chars: B_TEXT.length } });
  // 위조: A 소유 행인데 키가 B 접두사.
  await tdb.prisma.portfolio.create({ data: { id: "pf_forged", userId: A_ID, title: "위조", kind: "file", textKey: `users/${B_ID}/portfolios/pf_b/text-1.txt`, chars: 10 } });
});
afterAll(() => tdb.close());

describe("syncSource", () => {
  it("원문을 인자로 받지 않는다(시그니처 userId, sourceType, sourceId)", () => {
    expect(syncSource.length).toBe(3);
  });

  it("B의 포트폴리오 id·키 접두사가 B인 위조 행으로는 A 청크를 쓰지 않는다", async () => {
    const before = await countUserChunks(A_ID);
    expect(await syncSource(A_ID, "portfolio-text", "pf_b", deps)).toBe("deleted");
    expect(await syncSource(A_ID, "portfolio-text", "pf_forged", deps)).toBe("deleted");
    expect(await syncSource(A_ID, "repo-brief", "snap_b", deps)).toBe("deleted");
    expect(await countUserChunks(A_ID)).toBe(before);
    expect(await readAuthoritativeSource(A_ID, "portfolio-text", "pf_forged")).toBeNull();
    expect(await sourceExistsElsewhere("portfolio-text", "pf_forged", A_ID)).toBe(true);
    const rows = await tdb.pglite.query<{ content: string }>(`SELECT content FROM experience_chunks WHERE user_id = $1`, [A_ID]);
    expect(rows.rows.map((r) => r.content).join("\n")).not.toContain(B_SECRET);
  });

  it("포트폴리오 삭제 → 트리거가 청크를 지우고 데이터 버전을 올린다(삭제로 색인은 최신 — 출처 버전은 그대로). 다음 검색에 없다(사양 14④)", async () => {
    expect(await syncSource(A_ID, "portfolio-text", "pf_a", deps)).toBe("synced");
    const lex = queryLexemes("정산 배치 재설계");
    const found = await searchChunksSql({ principalUserId: A_ID }, { lexemes: lex, sourceTypes: ["portfolio-text"], limit: 5 });
    expect(found.map((r) => r.source_id)).toEqual(["pf_a"]);
    const v0 = await readRagState(A_ID);
    await tdb.prisma.portfolio.delete({ where: { id: "pf_a" } });
    const v1 = await readRagState(A_ID);
    expect(v1.dataVersion).toBeGreaterThan(v0.dataVersion);
    expect(v1.sourceVersion).toBe(v0.sourceVersion);
    expect(await searchChunksSql({ principalUserId: A_ID }, { lexemes: lex, sourceTypes: ["portfolio-text"], limit: 5 })).toEqual([]);
  });

  it("재색인: 본인 출처만 다시 만들고 색인 버전을 맞춘다", async () => {
    const r = await reindexUser(A_ID, deps);
    expect(r.done).toBe(true);
    expect(r.synced).toBeGreaterThanOrEqual(1);
    const s = await readRagState(A_ID);
    expect(s.indexedSourceVersion).toBe(s.sourceVersion);
    const rows = await tdb.pglite.query<{ content: string; source_id: string }>(`SELECT content, source_id FROM experience_chunks WHERE user_id = $1`, [A_ID]);
    expect(rows.rows.map((x) => x.source_id)).not.toContain("pf_b");
    expect(rows.rows.map((x) => x.content).join("\n")).not.toContain(B_SECRET);
  });
});

describe("권한 버전 트리거", () => {
  it("계정 상태 변경·비밀번호 변경·동의 기록 → policy_version 증가", async () => {
    const p0 = (await readRagState(B_ID)).policyVersion;
    await tdb.prisma.user.update({ where: { id: B_ID }, data: { status: "suspended" } });
    const p1 = (await readRagState(B_ID)).policyVersion;
    expect(p1).toBe(p0 + 1);
    await tdb.prisma.user.update({ where: { id: B_ID }, data: { passwordHash: "new" } });
    await tdb.prisma.userConsent.create({ data: { userId: B_ID, type: "marketing", version: "x", agreed: false, source: "account" } });
    expect((await readRagState(B_ID)).policyVersion).toBe(p1 + 2);
    await tdb.prisma.user.update({ where: { id: B_ID }, data: { name: "다른 이름" } });
    expect((await readRagState(B_ID)).policyVersion).toBe(p1 + 2);
  });
});
