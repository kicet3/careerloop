/**
 * 쪽 나누기(PGlite): 보관함 listPostingsPage·공고 찾기 listSharedPostingsPage — 한 쪽 12개, 고정된 순서(id로 동점 정리),
 * 전체 수, 쪽 수를 넘는 page는 마지막 쪽, 조건(검색·상태·병역특례). 병역특례 태그 저장(쓰기 경로)·지연 백필.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { clampPage, pageCountOf, pageItems, parsePageParam } from "@/lib/pagination";
import { createTestDb, type TestDb } from "@/test/db";
import { MILITARY_SERVICE_DETECTOR_VERSION as V } from "./military-service";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let service: typeof import("./service");
let shared: typeof import("./shared");
let structure: typeof import("./structure");

const input = (v: Record<string, unknown>) => PostingCreateInputSchema.parse({ company: "회사", roleTitle: "개발자", ...v });

beforeAll(async () => {
  tdb = await createTestDb();
  service = await import("./service");
  shared = await import("./shared");
  structure = await import("./structure");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

describe("쪽 계산(순수)", () => {
  it("page 파라미터·쪽 수·맞추기·번호 줄", () => {
    expect(parsePageParam(undefined)).toBe(1);
    expect(parsePageParam("2")).toBe(2);
    expect(parsePageParam(["3", "4"])).toBe(3);
    expect(parsePageParam("0")).toBe(1);
    expect(parsePageParam("-2")).toBe(1);
    expect(parsePageParam("1.5")).toBe(1);
    expect(parsePageParam("abc")).toBe(1);
    expect(parsePageParam("999999")).toBe(10_000);
    expect(pageCountOf(0)).toBe(1);
    expect(pageCountOf(12)).toBe(1);
    expect(pageCountOf(13)).toBe(2);
    expect(clampPage(5, 13)).toBe(2);
    expect(clampPage(0, 13)).toBe(1);
    expect(pageItems(1, 5)).toEqual([1, 2, 3, 4, 5]);
    expect(pageItems(5, 10)).toEqual([1, "gap", 4, 5, 6, "gap", 10]);
    expect(pageItems(1, 10)).toEqual([1, 2, 3, 4, "gap", 10]);
    expect(pageItems(10, 10)).toEqual([1, "gap", 7, 8, 9, 10]);
    expect(pageItems(4, 10)).toEqual([1, 2, 3, 4, 5, "gap", 10]);
  });
});

describe("보관함 listPostingsPage", () => {
  async function seed(n: number) {
    for (let i = 0; i < n; i++) {
      await service.createPosting("ua", input({ company: `회사${String(i).padStart(2, "0")}`, status: i % 5 === 0 ? "closed" : "saved" }));
    }
    // 수정 시각을 모두 같게 해 정렬 동점을 만든다(id로 순서가 고정되는지).
    await tdb.prisma.jobPosting.updateMany({ data: { updatedAt: new Date("2026-10-01T00:00:00Z") } });
  }

  it("한 쪽 12개, 쪽 사이에 겹치거나 빠지는 공고가 없고, 전체 수·진행 중 수를 싣는다", async () => {
    await seed(30);
    await service.createPosting("ub", input({ company: "남의 공고" }));
    const all = { query: "", status: "all" as const, onlyClosingSoon: false };
    const p1 = await service.listPostingsPage("ua", { filters: all, sort: "updated", page: 1 });
    const p2 = await service.listPostingsPage("ua", { filters: all, sort: "updated", page: 2 });
    const p3 = await service.listPostingsPage("ua", { filters: all, sort: "updated", page: 3 });
    expect([p1.items.length, p2.items.length, p3.items.length]).toEqual([12, 12, 6]);
    expect(p1).toMatchObject({ total: 30, page: 1, pageCount: 3, pageSize: 12, allCount: 30, activeCount: 24 });
    const ids = [...p1.items, ...p2.items, ...p3.items].map((p) => p.id);
    expect(new Set(ids).size).toBe(30);
    // 동점은 id 역순.
    expect(ids).toEqual([...ids].sort().reverse());
    // 같은 요청은 같은 순서.
    expect((await service.listPostingsPage("ua", { filters: all, sort: "updated", page: 1 })).items.map((p) => p.id)).toEqual(p1.items.map((p) => p.id));
  });

  it("쪽 수를 넘는 page는 마지막 쪽, 조건(기본: 진행 중·검색)은 쪽 나누기 전에 건다", async () => {
    await seed(30);
    const over = await service.listPostingsPage("ua", { page: 99 });
    expect(over).toMatchObject({ total: 24, page: 2, pageCount: 2 });
    expect(over.items).toHaveLength(12);
    expect(over.items.every((p) => p.status !== "closed")).toBe(true);
    const search = await service.listPostingsPage("ua", { filters: { query: "회사0", status: "all", onlyClosingSoon: false } });
    expect(search).toMatchObject({ total: 10, pageCount: 1 });
    const empty = await service.listPostingsPage("ub", { page: 3 });
    expect(empty).toMatchObject({ items: [], total: 0, page: 1, pageCount: 1, allCount: 0 });
  });

  it("카드에 병역특례 태그·JD 여부를 싣는다(전체 목록 listPostings는 그대로)", async () => {
    await service.createPosting("ua", input({ company: "병특", jdText: "기타\n- 산업기능요원(보충역) 편입 가능" }));
    await service.createPosting("ua", input({ company: "일반", jdText: "자격 요건\n- 군필 또는 면제자" }));
    const page = await service.listPostingsPage("ua", { sort: "company" });
    expect(page.items.map((p) => [p.company, p.militaryService, p.hasJd])).toEqual([
      ["병특", ["industrial", "industrial_supplementary"], true],
      ["일반", [], true],
    ]);
    expect((await service.listPostings("ua")).length).toBe(2);
  });
});

describe("공고 찾기 listSharedPostingsPage", () => {
  async function seedShared(i: number, jdText = "주요 업무\n- API 개발") {
    const p = input({ company: `공용${String(i).padStart(2, "0")}`, jdText });
    return shared.upsertSharedPosting({
      url: `https://example.com/jobs/${i}`,
      posting: p,
      structure: structure.structureFromText(p.jdText),
      sourceText: "",
      extractedBy: "anthropic",
      createdBy: "ua",
    });
  }

  it("한 쪽 12개, 고정된 순서, 쪽 수를 넘으면 마지막 쪽", async () => {
    for (let i = 0; i < 26; i++) await seedShared(i);
    await tdb.prisma.sharedPosting.updateMany({ data: { fetchedAt: new Date("2026-10-01T00:00:00Z") } });
    const pages = await Promise.all([1, 2, 3].map((page) => shared.listSharedPostingsPage({ page })));
    expect(pages.map((p) => p.items.length)).toEqual([12, 12, 2]);
    expect(pages[0]).toMatchObject({ total: 26, page: 1, pageCount: 3, pageSize: 12 });
    const ids = pages.flatMap((p) => p.items.map((i) => i.id));
    expect(new Set(ids).size).toBe(26);
    expect(ids).toEqual([...ids].sort().reverse());
    expect(await shared.listSharedPostingsPage({ page: 50 })).toMatchObject({ page: 3, total: 26 });
  });

  it("병역특례 필터는 저장된 태그로 거르고 쪽 나누기와 함께 동작한다", async () => {
    for (let i = 0; i < 14; i++) await seedShared(i, i % 2 === 0 ? "기타\n- 전문연구요원 편입 가능" : "기타\n- 병역특례 불가");
    await seedShared(100, "기타\n- 산업기능요원(현역) 가능");
    const any = await shared.listSharedPostingsPage({ military: "any" });
    expect(any).toMatchObject({ total: 8, pageCount: 1 });
    const expert = await shared.listSharedPostingsPage({ military: "expert", page: 1, pageSize: 5 });
    expect(expert).toMatchObject({ total: 7, pageCount: 2 });
    expect(expert.items.every((i) => i.militaryService.includes("expert"))).toBe(true);
    const industrial = await shared.listSharedPostingsPage({ military: "industrial" });
    expect(industrial.items.map((i) => [i.company, i.militaryService])).toEqual([["공용100", ["industrial", "industrial_active"]]]);
    expect((await shared.listSharedPostingsPage({ military: "all" })).total).toBe(15);
    // 기존 0쪽 기반 목록(API)도 같은 필터를 쓴다.
    expect((await shared.listSharedPostings({ military: "expert" })).total).toBe(7);
  });

  it("공개 필드만 판정한다(가져온 원문 sourceText의 병역특례 문구는 보지 않는다)", async () => {
    const p = input({ company: "원문만", jdText: "주요 업무\n- API 개발" });
    const row = await shared.upsertSharedPosting({
      url: "https://example.com/jobs/src",
      posting: p,
      structure: structure.structureFromText(p.jdText),
      sourceText: "전문연구요원 편입 가능",
      extractedBy: "anthropic",
      createdBy: "ua",
    });
    expect(row.militaryService).toEqual([]);
    expect(row.militaryServiceVersion).toBe(V);
  });

  it("직접 입력 공고: 만들 때와 고칠 때 공용 공고 태그를 다시 계산한다", async () => {
    const p = await service.createPosting("ua", input({ jdText: "기타\n- 전문연구요원 가능" }));
    const sid = p.sharedPostingId!;
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).militaryService).toEqual(["expert"]);
    await service.updatePosting("ua", p.id, { jdText: "기타\n- 병역특례 해당 없음" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).militaryService).toEqual([]);
    // 메모만 고치면 공용 공고를 건드리지 않는다.
    await service.updatePosting("ua", p.id, { note: "전문연구요원 가능(개인 메모)" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).militaryService).toEqual([]);
  });

  it("마이그레이션 전 행(버전 없음)은 목록을 읽을 때 백필된다", async () => {
    const a = await seedShared(1, "기타\n- 산업기능요원 보충역 가능");
    const b = await seedShared(2, "기타\n- 병역특례 불가");
    // 마이그레이션 직후 상태: 기본값 '{}'·버전 NULL.
    await tdb.pglite.exec(`UPDATE shared_postings SET military_service = DEFAULT, military_service_version = NULL`);
    // 백필 전에도 카드·상세는 즉석 계산으로 태그를 보인다.
    expect((await shared.getSharedPosting(a.id))?.militaryService).toEqual(["industrial", "industrial_supplementary"]);
    shared.resetSharedMilitaryBackfillForTests();
    const list = await shared.listSharedPostingsPage({ military: "industrial" });
    expect(list.items.map((i) => i.id)).toEqual([a.id]);
    const rows = await tdb.prisma.sharedPosting.findMany({ orderBy: { id: "asc" }, select: { id: true, militaryService: true, militaryServiceVersion: true } });
    expect(rows.find((r) => r.id === a.id)).toMatchObject({ militaryService: ["industrial", "industrial_supplementary"], militaryServiceVersion: V });
    expect(rows.find((r) => r.id === b.id)).toMatchObject({ militaryService: [], militaryServiceVersion: V });
    // 남은 행이 없으면 다시 돌려도 바꾸지 않는다.
    expect(await shared.backfillSharedMilitaryService()).toEqual({ updated: 0, remaining: false });
  });

  it("백필은 묶음 단위로 이어서 하고, 한 번에 maxRows까지만 한다", async () => {
    for (let i = 0; i < 5; i++) await seedShared(i, "기타\n- 전문연 가능");
    await tdb.pglite.exec(`UPDATE shared_postings SET military_service = DEFAULT, military_service_version = NULL`);
    expect(await shared.backfillSharedMilitaryService({ batchSize: 2, maxRows: 4 })).toEqual({ updated: 4, remaining: true });
    expect(await shared.backfillSharedMilitaryService({ batchSize: 2, maxRows: 4 })).toEqual({ updated: 1, remaining: false });
    expect(await tdb.prisma.sharedPosting.count({ where: { militaryService: { has: "expert" } } })).toBe(5);
  });

  it("예전 규칙 버전으로 저장된 행은 다시 계산하고, 목록 요청 한 번은 한 묶음만 처리한다", async () => {
    const a = await seedShared(1, "기타\n- 병역특례 비해당");
    // 예전 규칙이 잘못 붙인 태그(버전 낮음).
    await tdb.pglite.exec(`UPDATE shared_postings SET military_service = ARRAY['general'], military_service_version = ${V - 1}`);
    expect((await shared.getSharedPosting(a.id))?.militaryService).toEqual([]);
    expect(await shared.backfillSharedMilitaryService()).toEqual({ updated: 1, remaining: false });
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: a.id } })).toMatchObject({ militaryService: [], militaryServiceVersion: V });

    for (let i = 2; i < 7; i++) await seedShared(i, "기타\n- 전문연 가능");
    await tdb.pglite.exec(`UPDATE shared_postings SET military_service = DEFAULT, military_service_version = NULL`);
    // 기본 한 묶음(200) 안이면 한 번에 끝난다 — 묶음 크기를 넘는 경우는 위 테스트(maxRows)로 본다.
    shared.resetSharedMilitaryBackfillForTests();
    await shared.listSharedPostingsPage({});
    expect(await tdb.prisma.sharedPosting.count({ where: { militaryServiceVersion: null } })).toBe(0);
  });
});
