/**
 * 회사 필터: 회사 이름 정규화(companyKey 변형들), 보관함·공고 찾기의 회사 필터(쪽 나누기·전체 수와 함께, PGlite),
 * 회사 목록(공고 수·표기·검색·고른 회사·숨긴 공고 제외), 쓰기 경로의 company_key 저장과 지연 백필, 회사 목록 API.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  clampCompanyLimit,
  COMPANY_FILTER_MAX,
  companyKey,
  groupCompanyNames,
  parseCompanyParam,
} from "@/lib/domain/company";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

describe("companyKey(회사 이름 정규화)", () => {
  it("공백·법인 표기·대소문자·전각 차이를 같은 키로 묶는다", () => {
    const kakao = ["카카오", " 카카오  ", "(주)카카오", "(주) 카카오", "( 주 )카카오", "㈜카카오", "주식회사 카카오", "주식회사카카오", "카카오 주식회사", "카카오(주)", "카카오 ㈜"];
    expect(new Set(kakao.map(companyKey))).toEqual(new Set(["카카오"]));
    expect(companyKey("유한회사 무신사")).toBe("무신사");
    expect(companyKey("무신사 유한책임회사")).toBe("무신사");
    expect(companyKey("(유)무신사")).toBe("무신사");
    expect(companyKey("株式会社 メルカリ")).toBe("メルカリ");
    const toss = ["Toss", "toss", "TOSS Inc.", "Toss, Inc.", "Toss Inc", "Toss Corp.", "Toss Corporation", "Toss Co., Ltd.", "Toss Co.,Ltd", "Toss Ltd.", "Toss LLC", "ＴＯＳＳ"];
    expect(new Set(toss.map(companyKey))).toEqual(new Set(["toss"]));
    // 공백 차이도 같은 회사("카카오 뱅크" = "카카오뱅크").
    expect(companyKey("카카오 뱅크")).toBe(companyKey("카카오뱅크"));
    expect(companyKey("Samsung Electronics Co., Ltd.")).toBe("samsungelectronics");
  });

  it("이름 속의 글자는 지우지 않는다(낱말 경계일 때만 영문 법인 표기)", () => {
    expect(companyKey("Zinc")).toBe("zinc");
    expect(companyKey("Zinc Inc.")).toBe("zinc");
    expect(companyKey("Coinone")).toBe("coinone");
    expect(companyKey("Disco")).toBe("disco");
    expect(companyKey("유한양행")).toBe("유한양행");
    expect(companyKey("주식투자연구소")).toBe("주식투자연구소");
  });

  it("법인 표기뿐이면 원래 이름을, 빈 이름은 빈 키", () => {
    expect(companyKey("(주)")).toBe("(주)");
    expect(companyKey("Inc.")).toBe("inc.");
    expect(companyKey("")).toBe("");
    expect(companyKey("   ")).toBe("");
    expect(companyKey(null)).toBe("");
  });

  it("키에는 공백·쉼표가 없고, 키를 다시 넣으면 같은 키다", () => {
    const names = ["(주)카카오", "Toss Co., Ltd.", "LINE Plus", "abc주식, 회사def", "(주) inc", "co ltd", "Foo & Co.", "A, B, C", "  -네이버- ", "(주)", "Inc."];
    for (const n of names) {
      const k = companyKey(n);
      expect(k).not.toMatch(/[\s,]/);
      expect(companyKey(k)).toBe(k);
    }
  });

  it("주소 값: 여러 번·쉼표 목록·원래 이름을 키로, 중복 제거, 상한", () => {
    expect(parseCompanyParam(undefined)).toEqual([]);
    expect(parseCompanyParam("")).toEqual([]);
    expect(parseCompanyParam("토스")).toEqual(["토스"]);
    expect(parseCompanyParam(["토스", "(주)카카오"])).toEqual(["토스", "카카오"]);
    expect(parseCompanyParam("토스,카카오, ,토스")).toEqual(["토스", "카카오"]);
    // 쉼표가 든 원래 이름: 법인 표기뿐인 조각은 버린다. 쉼표 없는 법인 표기뿐인 이름은 그대로 키가 된다.
    expect(parseCompanyParam("Samsung Electronics Co., Ltd.")).toEqual(["samsungelectronics"]);
    expect(parseCompanyParam("Acme, Inc.")).toEqual(["acme"]);
    expect(parseCompanyParam("(주)")).toEqual(["(주)"]);
    expect(parseCompanyParam(Array.from({ length: 20 }, (_, i) => `회사${i}`))).toHaveLength(COMPANY_FILTER_MAX);
    expect(clampCompanyLimit(null)).toBe(20);
    expect(clampCompanyLimit("5")).toBe(5);
    expect(clampCompanyLimit("999")).toBe(50);
    expect(clampCompanyLimit("-1")).toBe(20);
  });

  it("묶은 목록: 공고 수를 더하고 가장 많이 쓰인 표기를 이름으로", () => {
    const g = groupCompanyNames([
      { company: "(주)카카오", count: 1 },
      { company: "카카오", count: 3 },
      { company: "주식회사 카카오", count: 2 },
      { company: "Toss Inc.", count: 1 },
      { company: "", count: 5 },
    ]);
    expect(g.get("카카오")).toEqual({ key: "카카오", label: "카카오", count: 6 });
    expect(g.get("toss")).toEqual({ key: "toss", label: "Toss Inc.", count: 1 });
    expect(g.size).toBe(2);
  });
});

let tdb: TestDb;
let service: typeof import("./service");
let shared: typeof import("./shared");

const input = (v: Record<string, unknown>) => PostingCreateInputSchema.parse({ company: "회사", roleTitle: "개발자", ...v });

describe("DB: 회사 필터·회사 목록", () => {
  beforeAll(async () => {
    tdb = await createTestDb();
    service = await import("./service");
    shared = await import("./shared");
  });
  afterAll(() => tdb.close());
  beforeEach(async () => {
    await tdb.reset();
    for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
  });

  async function seedShared(i: number, company: string) {
    return shared.upsertSharedPosting({
      url: `https://example.com/jobs/${i}`,
      posting: input({ company }),
      structure: null,
      sourceText: "",
      extractedBy: "anthropic",
      createdBy: "ua",
    });
  }

  describe("보관함", () => {
    it("회사 키로 거르고(표기 차이 무시) 쪽 나누기·전체 수가 맞는다, 다른 조건과 함께 건다", async () => {
      const names = ["(주)카카오", "카카오", "주식회사 카카오", "Toss Inc.", "토스"];
      for (let i = 0; i < 15; i++) await service.createPosting("ua", input({ company: names[i % names.length], roleTitle: `개발자${i}`, status: i === 0 ? "closed" : "saved" }));
      await service.createPosting("ub", input({ company: "카카오" }));
      const all = { query: "", status: "all" as const, onlyClosingSoon: false };
      const kakao = await service.listPostingsPage("ua", { filters: { ...all, companies: ["카카오"] }, sort: "created", pageSize: 5 });
      expect(kakao).toMatchObject({ total: 9, page: 1, pageCount: 2, allCount: 15 });
      const p2 = await service.listPostingsPage("ua", { filters: { ...all, companies: ["카카오"] }, sort: "created", pageSize: 5, page: 2 });
      expect(p2.items).toHaveLength(4);
      expect(new Set([...kakao.items, ...p2.items].map((p) => p.id)).size).toBe(9);
      expect([...kakao.items, ...p2.items].every((p) => companyKey(p.company) === "카카오")).toBe(true);
      // 여러 회사: 하나라도 맞으면.
      expect((await service.listPostingsPage("ua", { filters: { ...all, companies: ["카카오", "toss"] } })).total).toBe(12);
      // 기본 조건(진행 중)과 함께: 마감한 (주)카카오 1개는 빠진다.
      expect((await service.listPostingsPage("ua", { filters: { query: "", status: "active", onlyClosingSoon: false, companies: ["카카오"] } })).total).toBe(8);
      // 검색어와 함께.
      expect((await service.listPostingsPage("ua", { filters: { ...all, query: "개발자1", companies: ["카카오"] } })).total).toBe(4);
      // 없는 회사.
      expect((await service.listPostingsPage("ua", { filters: { ...all, companies: ["없는회사"] } })).total).toBe(0);
    });

    it("진행 중 조건에서만 비면 상태만 '모두'로 바꾼 수(allStatusCount)를 싣는다", async () => {
      await service.createPosting("ua", input({ company: "마감회사", status: "closed" }));
      await service.createPosting("ua", input({ company: "마감회사", status: "closed" }));
      await service.createPosting("ua", input({ company: "카카오" }));
      const active = { query: "", status: "active" as const, onlyClosingSoon: false };
      const empty = await service.listPostingsPage("ua", { filters: { ...active, companies: ["마감회사"] } });
      expect(empty).toMatchObject({ total: 0, allStatusCount: 2 });
      // 목록이 있거나 상태를 직접 고른 경우에는 싣지 않는다.
      expect((await service.listPostingsPage("ua", { filters: { ...active, companies: ["카카오"] } })).allStatusCount).toBeUndefined();
      expect((await service.listPostingsPage("ua", { filters: { ...active, status: "applied", companies: ["마감회사"] } })).allStatusCount).toBeUndefined();
      expect((await service.listPostingsPage("ua", { filters: { ...active, companies: ["없는회사"] } })).allStatusCount).toBe(0);
    });

    it("회사 목록: 내 공고만, 공고 수 많은 순, 표기는 가장 많이 쓴 것, 검색·개수·고른 회사", async () => {
      for (const c of ["(주)카카오", "카카오", "카카오", "토스", "Toss Inc.", "네이버"]) await service.createPosting("ua", input({ company: c }));
      await service.createPosting("ub", input({ company: "남의회사" }));
      const all = await service.listLibraryCompanyOptions("ua", { limit: 20 });
      expect(all).toEqual([
        { key: "카카오", label: "카카오", count: 3 },
        { key: "네이버", label: "네이버", count: 1 },
        { key: "토스", label: "토스", count: 1 },
        { key: "toss", label: "Toss Inc.", count: 1 },
      ]);
      // 검색: 법인 표기·공백을 무시한 키 부분 일치, 표기 부분 일치.
      expect((await service.listLibraryCompanyOptions("ua", { q: "(주) 카카", limit: 20 })).map((o) => o.key)).toEqual(["카카오"]);
      expect((await service.listLibraryCompanyOptions("ua", { q: "TOSS", limit: 20 })).map((o) => o.key)).toEqual(["toss"]);
      // 개수 밖이어도 고른 회사는 붙인다. 내 공고에 없는 키는 싣지 않는다.
      expect((await service.listLibraryCompanyOptions("ua", { limit: 1, include: ["토스", "남의회사"] })).map((o) => o.key)).toEqual(["카카오", "토스"]);
      expect(await service.listLibraryCompanyOptions("ub", { limit: 20 })).toEqual([{ key: "남의회사", label: "남의회사", count: 1 }]);
    });
  });

  describe("공고 찾기", () => {
    it("쓰기 경로마다 company_key를 저장한다(가져오기·직접 입력·직접 입력 공고 수정)", async () => {
      const row = await seedShared(1, "(주)카카오");
      expect(row.companyKey).toBe("카카오");
      const p = await service.createPosting("ua", input({ company: "Toss Inc." }));
      const sid = p.sharedPostingId!;
      expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).companyKey).toBe("toss");
      await service.updatePosting("ua", p.id, { company: "주식회사 비바리퍼블리카" });
      expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).companyKey).toBe("비바리퍼블리카");
      // 다시 가져오기(같은 url_key 덮어쓰기)도 키를 다시 쓴다.
      expect((await seedShared(1, "네이버 주식회사")).companyKey).toBe("네이버");
    });

    it("회사 키로 거르고 쪽 나누기·전체 수가 맞는다, 숨긴 공고는 빠진다, 다른 조건과 함께", async () => {
      const names = ["(주)카카오", "카카오", "카카오 주식회사", "토스"];
      const rows = [];
      for (let i = 0; i < 16; i++) rows.push(await seedShared(i, names[i % names.length]));
      await shared.setSharedPostingHidden(rows[0].id, true);
      const p1 = await shared.listSharedPostingsPage({ companies: ["카카오"], pageSize: 5 });
      expect(p1).toMatchObject({ total: 11, page: 1, pageCount: 3 });
      const p3 = await shared.listSharedPostingsPage({ companies: ["카카오"], pageSize: 5, page: 3 });
      expect(p3.items).toHaveLength(1);
      expect(p1.items.every((i) => companyKey(i.company) === "카카오")).toBe(true);
      expect((await shared.listSharedPostingsPage({ companies: ["카카오", "토스"] })).total).toBe(15);
      expect((await shared.listSharedPostingsPage({ companies: ["카카오"], q: "개발자", deadline: "all" })).total).toBe(11);
      expect((await shared.listSharedPostingsPage({ companies: ["카카오"], military: "expert" })).total).toBe(0);
      // 관리자 숨긴 공고 목록에서도 같은 회사 조건.
      expect((await shared.listSharedPostingsPage({ companies: ["카카오"], hidden: "only" })).total).toBe(1);
    });

    it("회사 목록: 숨긴 공고는 세지 않고, 숨긴 공고뿐인 회사·표기는 내보내지 않는다", async () => {
      await seedShared(1, "카카오");
      await seedShared(2, "(주)카카오");
      await seedShared(3, "(주)카카오");
      await seedShared(4, "토스");
      const secret = await seedShared(5, "비밀회사");
      // 숨긴 공고의 표기("KAKAO CORP")가 이름으로 뽑히면 안 된다.
      const hiddenKakao = [await seedShared(6, "KAKAO 주식회사"), await seedShared(7, "KAKAO 주식회사"), await seedShared(8, "KAKAO 주식회사")];
      for (const r of [secret, ...hiddenKakao]) await shared.setSharedPostingHidden(r.id, true);
      const all = await shared.listSharedCompanyOptions({ limit: 20 });
      expect(all).toEqual([
        { key: "카카오", label: "(주)카카오", count: 3 },
        { key: "토스", label: "토스", count: 1 },
      ]);
      // 고른 회사로 넣어도, 검색해도 숨긴 공고뿐인 회사는 없다.
      expect((await shared.listSharedCompanyOptions({ limit: 20, include: ["비밀회사"] })).map((o) => o.key)).toEqual(["카카오", "토스"]);
      expect(await shared.listSharedCompanyOptions({ q: "비밀", limit: 20 })).toEqual([]);
      // 검색(키·표기 부분 일치)·개수·고른 회사.
      expect((await shared.listSharedCompanyOptions({ q: "주식회사 카카", limit: 20 })).map((o) => o.key)).toEqual(["카카오"]);
      expect((await shared.listSharedCompanyOptions({ q: "토", limit: 20 })).map((o) => o.key)).toEqual(["토스"]);
      // 법인 표기만으로 찾아도(원래 이름에만 맞음) 공고 수는 숨기지 않은 공고 전체다.
      expect(await shared.listSharedCompanyOptions({ q: "(주)", limit: 20 })).toEqual([{ key: "카카오", label: "(주)카카오", count: 3 }]);
      expect((await shared.listSharedCompanyOptions({ limit: 1, include: ["토스"] })).map((o) => [o.key, o.count])).toEqual([
        ["카카오", 3],
        ["토스", 1],
      ]);
    });

    it("마이그레이션 전 행(company_key NULL)은 목록·회사 목록을 읽을 때 백필된다", async () => {
      await seedShared(1, "(주)카카오");
      await seedShared(2, "Toss Inc.");
      const blank = await seedShared(3, "이름 없음");
      await tdb.pglite.exec(`UPDATE shared_postings SET company_key = NULL`);
      await tdb.pglite.query(`UPDATE shared_postings SET company = '' WHERE id = $1`, [blank.id]);
      shared.resetSharedCompanyKeyBackfillForTests();
      expect((await shared.listSharedPostingsPage({ companies: ["카카오"] })).total).toBe(1);
      const rows = await tdb.prisma.sharedPosting.findMany({ select: { company: true, companyKey: true }, orderBy: { company: "asc" } });
      expect(rows.map((r) => r.companyKey).sort()).toEqual(["", "toss", "카카오"]);
      // 빈 키는 회사 목록에 나오지 않는다.
      expect((await shared.listSharedCompanyOptions({ limit: 20 })).map((o) => o.key)).toEqual(["카카오", "toss"]);
      expect(await shared.backfillSharedCompanyKeys()).toEqual({ updated: 0, remaining: false });
    });

    it("백필은 묶음 단위로 이어서 하고, 한 번에 maxRows까지만 한다", async () => {
      for (let i = 0; i < 5; i++) await seedShared(i, `회사 ${i} (주)`);
      await tdb.pglite.exec(`UPDATE shared_postings SET company_key = NULL`);
      expect(await shared.backfillSharedCompanyKeys({ batchSize: 2, maxRows: 4 })).toEqual({ updated: 4, remaining: true });
      expect(await shared.backfillSharedCompanyKeys({ batchSize: 2, maxRows: 4 })).toEqual({ updated: 1, remaining: false });
      expect((await tdb.prisma.sharedPosting.findMany({ select: { companyKey: true } })).map((r) => r.companyKey).sort()).toEqual(["회사0", "회사1", "회사2", "회사3", "회사4"]);
    });
  });
});
