/** 공용 공고(PGlite): url_key 조회·덮어쓰기, 보관함 담기(중복은 연결만), 다시 가져오기 동기화, 목록의 myPostingId, 숨김. */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let shared: typeof import("./shared");
let service: typeof import("./service");
let structure: typeof import("./structure");

const posting = (over: Record<string, unknown> = {}) =>
  PostingCreateInputSchema.parse({
    company: "토스",
    roleTitle: "백엔드 개발자",
    url: "https://toss.im/career/job/1",
    jdText: "주요 업무\n- API 개발\n자격 요건\n- Kotlin 3년",
    deadline: "2026-12-31",
    location: "서울 강남",
    note: "개인 메모(공유되면 안 됨)",
    ...over,
  });

async function seedShared(url = "https://www.toss.im/career/job/1?utm_source=x", over: Record<string, unknown> = {}) {
  const p = posting(over);
  return shared.upsertSharedPosting({
    url,
    posting: p,
    structure: structure.structureFromText(p.jdText),
    sourceText: "원문 페이지 본문",
    extractedBy: "anthropic",
    createdBy: "ua",
  });
}

beforeAll(async () => {
  tdb = await createTestDb();
  shared = await import("./shared");
  service = await import("./service");
  structure = await import("./structure");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

describe("upsert·조회", () => {
  it("정규화 URL로 찾고, 같은 URL을 다시 저장하면 한 행을 덮어쓴다", async () => {
    const a = await seedShared();
    expect(a.urlKey).toBe("toss.im/career/job/1");
    expect((await shared.findSharedPostingByUrl("toss.im/career/job/1/"))?.id).toBe(a.id);
    const b = await seedShared("https://toss.im/career/job/1", { roleTitle: "서버 개발자" });
    expect(b.id).toBe(a.id);
    expect(b.roleTitle).toBe("서버 개발자");
    expect(b.createdBy).toBe("ua");
    expect(await tdb.prisma.sharedPosting.count()).toBe(1);
    expect(await shared.findSharedPostingByUrl("not a url")).toBeNull();
  });

  it("개인 값(note·status)은 공용 공고에 없다", async () => {
    const a = await seedShared();
    const detail = await shared.getSharedPosting(a.id);
    expect(JSON.stringify(detail)).not.toContain("개인 메모");
    expect(detail).not.toHaveProperty("createdBy");
    expect(detail?.structured?.duties.length).toBeGreaterThan(0);
  });
});

describe("보관함 담기", () => {
  it("사본을 만들고 사용자 수를 센다. 다시 담으면 기존 공고", async () => {
    const s = await seedShared();
    const first = await shared.saveSharedToLibrary("ub", s.id);
    expect(first.created).toBe(true);
    expect(first.posting).toMatchObject({ company: "토스", sharedPostingId: s.id, status: "saved", note: "", urlKey: s.urlKey });
    expect(first.posting.sourceText).toBe("원문 페이지 본문");
    const again = await shared.saveSharedToLibrary("ub", s.id);
    expect(again).toMatchObject({ created: false, posting: { id: first.posting.id } });
    await shared.saveSharedToLibrary("ua", s.id, { status: "planned" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: s.id } })).importerCount).toBe(2);
  });

  it("같은 URL을 직접 입력해 둔 공고는 연결만 하고 내용은 그대로", async () => {
    const s = await seedShared();
    const manual = await service.createPosting("ub", posting({ url: "https://toss.im/career/job/1", company: "직접 입력" }));
    const r = await shared.saveSharedToLibrary("ub", s.id);
    expect(r).toMatchObject({ created: false, posting: { id: manual.id, company: "직접 입력", sharedPostingId: s.id } });
  });

  it("숨긴 공고는 찾기·담기에서 빠진다", async () => {
    const s = await seedShared();
    expect(await shared.setSharedPostingHidden(s.id, true)).toBe(true);
    expect(await shared.findSharedPostingByUrl(s.url!)).toBeNull();
    expect((await shared.listSharedPostings()).total).toBe(0);
    await expect(shared.saveSharedToLibrary("ub", s.id)).rejects.toMatchObject({ status: 404 });
  });

  it("공용 공고를 지워도 내 공고는 남는다(연결만 끊김)", async () => {
    const s = await seedShared();
    const { posting: mine } = await shared.saveSharedToLibrary("ub", s.id);
    await tdb.prisma.sharedPosting.delete({ where: { id: s.id } });
    expect((await service.getPosting("ub", mine.id))?.sharedPostingId).toBeNull();
  });
});

describe("다시 가져오기 동기화", () => {
  it("공용 공고 내용으로 맞추되 상태·메모는 유지", async () => {
    const s = await seedShared();
    const { posting: mine } = await shared.saveSharedToLibrary("ub", s.id);
    await service.updatePosting("ub", mine.id, { status: "applied", note: "내 메모" });
    await seedShared("https://toss.im/career/job/1", { roleTitle: "서버 개발자", deadline: "2027-01-15" });
    const synced = await shared.syncPostingFromShared("ub", mine.id);
    expect(synced).toMatchObject({ roleTitle: "서버 개발자", deadline: "2027-01-15", status: "applied", note: "내 메모" });
    const manual = await service.createPosting("ub", posting({ url: "" }));
    expect(await shared.syncPostingFromShared("ub", manual.id)).toBeNull();
    expect(await shared.syncPostingFromShared("ua", mine.id)).toBeNull();
  });
});

describe("목록", () => {
  it("검색·최근 순·내 보관함 표시", async () => {
    const a = await seedShared();
    await seedShared("https://wanted.co.kr/wd/123", { company: "당근", roleTitle: "iOS 개발자", url: "https://wanted.co.kr/wd/123" });
    const { posting: mine } = await shared.saveSharedToLibrary("ub", a.id);
    const all = await shared.listSharedPostings({ viewerId: "ub" });
    expect(all.total).toBe(2);
    expect(all.items[0]!.company).toBe("당근");
    expect(all.items.find((i) => i.id === a.id)?.myPostingId).toBe(mine.id);
    expect((await shared.listSharedPostings({ q: "ios" })).items.map((i) => i.company)).toEqual(["당근"]);
    expect((await shared.listSharedPostings({ q: "강남" })).total).toBe(2);
  });
});
