/**
 * 공용 공고 먼저(PGlite): 직접 입력도 공용 공고를 먼저 만들고 보관 공고를 연결한다. 메모·상태는 공유되지 않고,
 * 만든 사람이 고치면 공개 필드만 맞춘다. 보관 공고를 지워도 공용 공고는 남는다. 직접 입력 공용 공고는 캡처하지 않는다.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let shared: typeof import("./shared");
let service: typeof import("./service");
let structure: typeof import("./structure");
let captureStore: typeof import("./capture-store");

const NOTE = "개인 메모(공유되면 안 됨)";
const posting = (over: Record<string, unknown> = {}) =>
  PostingCreateInputSchema.parse({
    company: "직접회사",
    roleTitle: "프론트엔드 개발자",
    jdText: "주요 업무\n- 화면 개발\n자격 요건\n- React 2년",
    deadline: "2026-12-31",
    location: "서울 성수",
    status: "applied",
    note: NOTE,
    ...over,
  });

beforeAll(async () => {
  tdb = await createTestDb();
  shared = await import("./shared");
  service = await import("./service");
  structure = await import("./structure");
  captureStore = await import("./capture-store");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

describe("직접 입력 → 공용 공고 먼저", () => {
  it("공용 공고(url 없음, manual)를 만들고 보관 공고를 연결한다 — 메모·상태는 공유하지 않는다", async () => {
    const p = await service.createPosting("ua", posting({ url: "https://intra.example.com/private/1" }));
    expect(p.sharedPostingId).toBeTruthy();
    const row = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: p.sharedPostingId! } });
    expect(row).toMatchObject({
      url: null,
      urlKey: null,
      company: "직접회사",
      roleTitle: "프론트엔드 개발자",
      deadline: "2026-12-31",
      location: "서울 성수",
      extractedBy: "manual",
      createdBy: "ua",
      importerCount: 1,
      sourceText: null,
      // 알려진 채용 플랫폼이 아닌 호스트 이름은 공유하지 않는다.
      platform: null,
    });
    expect(row.id).toHaveLength(21);
    expect(JSON.stringify(row)).not.toContain(NOTE);
    expect(JSON.stringify(row)).not.toContain("intra.example.com");

    // 공고 찾기 목록·상세: 다른 사용자에게 보이고, 메모·상태·주소·캡처는 없다.
    const list = await shared.listSharedPostings({ viewerId: "ub" });
    expect(list.items.map((i) => i.id)).toEqual([row.id]);
    expect(list.items[0]).toMatchObject({ url: null, urlKey: null, myPostingId: null, importerCount: 1 });
    expect(list.items[0]).not.toHaveProperty("capture");
    const detail = await shared.getSharedPosting(row.id, "ub");
    expect(detail).toMatchObject({ jdText: posting().jdText, extractedBy: "manual" });
    expect(JSON.stringify(detail)).not.toContain(NOTE);
    expect(JSON.stringify(detail)).not.toContain("applied");
    // 만든 사람에게는 내 공고로 보인다(주소가 아니라 공용 공고 연결로 맞춘다).
    expect((await shared.listSharedPostings({ viewerId: "ua" })).items[0].myPostingId).toBe(p.id);
  });

  it("주소 없는 공고 여러 개는 각자의 공용 공고를 가진다(url_key NULL 여러 개 허용)", async () => {
    const a = await service.createPosting("ua", posting());
    const b = await service.createPosting("ua", posting({ company: "다른회사" }));
    expect(a.sharedPostingId).not.toBe(b.sharedPostingId);
    expect(await tdb.prisma.sharedPosting.count()).toBe(2);
    // 내 다른 주소 없는 공고가 상대 공용 공고의 '내 공고'로 잘못 맞춰지지 않는다.
    const mine = (await shared.listSharedPostings({ viewerId: "ua" })).items;
    expect(Object.fromEntries(mine.map((i) => [i.id, i.myPostingId]))).toEqual({ [a.sharedPostingId!]: a.id, [b.sharedPostingId!]: b.id });
  });

  it("같은 주소의 공용 공고가 공고 찾기에 있으면 새로 만들지 않고 연결한다", async () => {
    const p = posting({ url: "https://toss.im/career/job/9" });
    const s = await shared.upsertSharedPosting({
      url: "https://toss.im/career/job/9",
      posting: p,
      structure: structure.structureFromText(p.jdText),
      sourceText: "원문",
      extractedBy: "anthropic",
      createdBy: "ub",
    });
    const mine = await service.createPosting("ua", posting({ url: "toss.im/career/job/9?utm_source=x", company: "내가 쓴 회사명" }));
    const wanted = await service.createPosting("ua", posting({ url: "https://www.wanted.co.kr/wd/1" }));
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: wanted.sharedPostingId! } })).platform).toBe("wanted");
    expect(mine.sharedPostingId).toBe(s.id);
    expect(await tdb.prisma.sharedPosting.count()).toBe(2);
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: s.id } })).importerCount).toBe(1);
    // URL로 만든 공용 공고는 직접 입력 사용자가 고쳐도 바뀌지 않는다.
    await service.updatePosting("ua", mine.id, { company: "바꾼 회사명" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: s.id } })).company).toBe("직접회사");
  });

  it("만든 사람이 고치면 공개 필드만 공용 공고에 맞추고, 담은 다른 사용자가 고치면 맞추지 않는다", async () => {
    const p = await service.createPosting("ua", posting());
    const sid = p.sharedPostingId!;
    await service.updatePosting("ua", p.id, { company: "새회사", location: "부산", deadline: "2027-01-15", note: "바뀐 메모", status: "closed" });
    const row = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } });
    expect(row).toMatchObject({ company: "새회사", location: "부산", deadline: "2027-01-15", deadlineKind: "date" });
    expect(JSON.stringify(row)).not.toContain("바뀐 메모");

    // 상태·메모만 바꾸면 공용 공고를 건드리지 않는다.
    const before = row.updatedAt.getTime();
    await new Promise((r) => setTimeout(r, 5));
    await service.updatePosting("ua", p.id, { note: "또 메모", status: "applied" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).updatedAt.getTime()).toBe(before);

    // 구역 편집(jdText 재조합 포함)도 맞춘다.
    const edited = await service.updatePosting("ua", p.id, { jdText: "주요 업무\n- 새 업무" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).jdText).toBe(edited!.jdText);

    const theirs = await shared.saveSharedToLibrary("ub", sid);
    expect(theirs).toMatchObject({ created: true, posting: { sharedPostingId: sid, company: "새회사", note: "", status: "saved", url: "" } });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).importerCount).toBe(2);
    await service.updatePosting("ub", theirs.posting.id, { company: "B가 바꿈" });
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: sid } })).company).toBe("새회사");
    // 다시 가져오기 동기화 대상이 아니다.
    expect(await shared.syncPostingFromShared("ub", theirs.posting.id)).toBeNull();
  });

  it("보관 공고를 지워도 공용 공고는 남고 담은 수만 다시 센다", async () => {
    const p = await service.createPosting("ua", posting());
    expect(await service.deletePosting("ua", p.id)).toBe(true);
    expect(await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: p.sharedPostingId! } })).toMatchObject({ importerCount: 0 });
    expect((await shared.listSharedPostings()).total).toBe(1);
  });

  it("직접 입력 공용 공고는 원문 캡처 대상이 아니다", async () => {
    const p = await service.createPosting("ua", posting());
    const sid = p.sharedPostingId!;
    expect(await captureStore.requestCapture(sid)).toBe(false);
    expect(await captureStore.claimCapture(sid)).toBeNull();
    expect(await captureStore.sharedIdForPosting("ua", p.id)).toBeNull();
    expect(await captureStore.canViewCapture("ua", sid)).toBe(false);
    expect((await service.getPosting("ua", p.id))!.capture).toBeUndefined();
  });

  it("관리자가 숨기면 목록·담기에서 빠진다", async () => {
    const p = await service.createPosting("ua", posting());
    expect(await shared.setSharedPostingHidden(p.sharedPostingId!, true)).toBe(true);
    expect((await shared.listSharedPostings()).total).toBe(0);
    expect((await shared.listSharedPostings({ hidden: "only" })).items[0]).toMatchObject({ id: p.sharedPostingId, hidden: true, url: null });
    await expect(shared.saveSharedToLibrary("ub", p.sharedPostingId!)).rejects.toMatchObject({ status: 404 });
  });

  it("관리자가 숨긴 주소로 직접 입력하면 숨긴 공용 공고에 연결하고 보이는 사본을 만들지 않는다", async () => {
    const p = posting({ url: "https://corp.example/private?token=1" });
    const s = await shared.upsertSharedPosting({
      url: "https://corp.example/private?token=1",
      posting: p,
      structure: null,
      sourceText: "원문",
      extractedBy: "anthropic",
      createdBy: "ub",
    });
    await shared.setSharedPostingHidden(s.id, true);
    const mine = await service.createPosting("ua", p);
    expect(mine.sharedPostingId).toBe(s.id);
    expect(await tdb.prisma.sharedPosting.count()).toBe(1);
    expect((await shared.listSharedPostings()).total).toBe(0);
  });

  it("직접 입력 공고를 URL 공용 공고로 옮기면 남은 사람이 없는 원래 공용 공고는 숨긴다(지우지 않는다)", async () => {
    const p = await service.createPosting("ua", posting({ url: "https://toss.im/career/job/77" }));
    const manualId = p.sharedPostingId!;
    expect((await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: manualId } })).url).toBeNull();
    const s = await shared.upsertSharedPosting({
      url: "https://toss.im/career/job/77",
      posting: posting(),
      structure: null,
      sourceText: "원문",
      extractedBy: "anthropic",
      createdBy: "ub",
    });
    const saved = await shared.saveSharedToLibrary("ua", s.id);
    expect(saved).toMatchObject({ created: false, posting: { id: p.id, sharedPostingId: s.id } });
    const old = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: manualId } });
    expect(old.importerCount).toBe(0);
    expect(old.hiddenAt).not.toBeNull();
    expect((await shared.listSharedPostings()).items.map((i) => i.id)).toEqual([s.id]);
  });
});
