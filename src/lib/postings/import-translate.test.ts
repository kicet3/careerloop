/**
 * 영문 공고 가져오기 → 한국어 저장(PGlite, 페이지·LLM은 가짜): URL 가져오기·원문만 붙여넣기·'다시 정리'가 모두 근거 검증 뒤
 * 한국어로 옮겨 저장하고, 공고 찾기(공용 공고)의 공개 필드도 한국어이며, 원문은 sourceText에 남고, 번역 호출 사용량이 기록되는지.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { UsageRecordingLlmClient } from "@/lib/llm/usage";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let imports: typeof import("./imports");
let service: typeof import("./service");
let restructure: typeof import("./restructure");

const ENGLISH_LINES = [
  "Company: Acme Robotics",
  "Role: Senior Backend Engineer",
  "Location: Seoul, South Korea",
  "Full-time. Apply by 2026-12-01.",
  "Responsibilities",
  "- Design and build payment APIs with Kotlin and Spring Boot",
  "- Operate services on Kubernetes and AWS",
  "- Improve observability across 20 microservices",
  "Requirements",
  "- 5+ years of backend engineering experience",
  "- Strong experience with Kotlin or Java",
  "Nice to have",
  "- Experience with Kafka",
];
const englishHtml = `<html><body>${ENGLISH_LINES.map((l) => `<p>${l}</p>`).join("")}</body></html>`;

beforeAll(async () => {
  tdb = await createTestDb();
  imports = await import("./imports");
  service = await import("./service");
  restructure = await import("./restructure");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

const recording = (userId: string) =>
  new UsageRecordingLlmClient(new FakeLlmClient(), { provider: "anthropic", model: "claude-opus-5-5", ctx: { userId } });

describe("영문 공고 → 한국어 저장", () => {
  it("URL 가져오기: 내 공고·공용 공고 모두 한국어, 원문은 sourceText, 번역 사용량 기록", async () => {
    const r = await imports.createImport("ua", "https://jobs.example/acme/backend");
    await imports.runImport(r.job.id, { llm: recording("ua"), fetchPage: async (url) => ({ url, html: englishHtml }) });
    const job = await imports.getImport("ua", r.job.id);
    expect(job).toMatchObject({ status: "completed" });
    const mine = (await service.getPosting("ua", job!.postingId!))!;
    expect(mine).toMatchObject({ company: "Acme Robotics", roleTitle: "시니어 백엔드 엔지니어", deadline: "2026-12-01" });
    expect(mine.location).toContain("서울");
    expect(mine.structured).toMatchObject({ source: "llm", translatedFrom: "en", jdComposed: true });
    expect(mine.structured!.duties).toHaveLength(3);
    expect(mine.structured!.duties.every((d) => /[가-힣]/.test(d))).toBe(true);
    expect(mine.jdText).toContain(mine.structured!.duties[0]);
    expect(mine.sourceText).toContain("Design and build payment APIs with Kotlin and Spring Boot");

    // 공고 찾기에 올라간 공개 필드도 한국어(다른 사용자가 담으면 그대로 받는다).
    const shared = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: job!.sharedPostingId! } });
    expect(shared).toMatchObject({ company: "Acme Robotics", roleTitle: "시니어 백엔드 엔지니어" });
    expect(shared.jdText).toBe(mine.jdText);
    expect((shared.structured as { translatedFrom?: string }).translatedFrom).toBe("en");
    const other = await imports.createImport("ub", "https://jobs.example/acme/backend");
    expect(other.fromShared).toBe(true);
    expect(await service.getPosting("ub", other.job.postingId!)).toMatchObject({ roleTitle: "시니어 백엔드 엔지니어" });

    const usage = await tdb.prisma.llmUsageEvent.findMany({ orderBy: { createdAt: "asc" } });
    expect(usage.map((u) => u.task).sort()).toEqual(["posting-extract", "posting-translate"]);
    expect(usage.every((u) => u.userId === "ua" && u.ok)).toBe(true);
  });

  it("원문만 붙여넣기('직접 추가'의 AI 추가): 한국어 저장, 공용 공고(직접 입력)도 한국어이며 원문은 공유하지 않는다", async () => {
    const r = await imports.createImport("ua", "", { pasted: true });
    await imports.runImport(r.job.id, { llm: new FakeLlmClient(), pastedText: ENGLISH_LINES.join("\n") });
    const job = await imports.getImport("ua", r.job.id);
    expect(job).toMatchObject({ status: "completed" });
    const mine = (await service.getPosting("ua", job!.postingId!))!;
    expect(mine.roleTitle).toBe("시니어 백엔드 엔지니어");
    expect(mine.structured?.translatedFrom).toBe("en");
    expect(mine.sourceText).toContain("Senior Backend Engineer");
    const shared = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: mine.sharedPostingId! } });
    expect(shared).toMatchObject({ url: null, roleTitle: "시니어 백엔드 엔지니어", sourceText: null });
    expect(shared.jdText).not.toContain("- Design and build payment APIs");
    expect(shared.jdText).toContain(mine.structured!.duties[0]);
  });

  it("가져오기 전체 상한이 얼마 남지 않으면 번역을 건너뛰고 검증된 원문을 저장한다(가져오기는 완료)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const r = await imports.createImport("ua", "https://jobs.example/acme/3");
    // 상한 20초 − 여유 10초 = 번역 예산 10초 < 최소 15초.
    await imports.runImport(r.job.id, { llm, timeLimitMs: 20_000, fetchPage: async (url) => ({ url, html: englishHtml }) });
    warn.mockRestore();
    const job = await imports.getImport("ua", r.job.id);
    expect(job).toMatchObject({ status: "completed" });
    expect(spy.mock.calls.map(([req]) => req.task)).toEqual(["posting-extract"]);
    const mine = (await service.getPosting("ua", job!.postingId!))!;
    expect(mine.roleTitle).toBe("Senior Backend Engineer");
    expect(mine.structured?.translatedFrom).toBeUndefined();
  });

  it("한국어 공고는 번역 호출이 없다", async () => {
    const llm = new FakeLlmClient();
    const spy = vi.spyOn(llm, "generate");
    const html = `<p>회사: 페이랩</p><p>모집 직무: 백엔드 개발자</p><p>근무지: 서울</p><p>${"정규직 백엔드 개발자를 채용합니다. Python과 SQL 경험이 필요합니다. ".repeat(5)}</p>`;
    const r = await imports.createImport("ua", "https://jobs.example/pay/1");
    await imports.runImport(r.job.id, { llm, fetchPage: async (url) => ({ url, html }) });
    expect((await imports.getImport("ua", r.job.id))?.status).toBe("completed");
    expect(spy.mock.calls.map(([req]) => req.task)).toEqual(["posting-extract"]);
  });

  it("다시 정리: 영문 원문으로 다시 정리해도 한국어 구역(jdText 재조합)", async () => {
    const r = await imports.createImport("ua", "https://jobs.example/acme/2");
    // 처음 가져올 때 번역이 실패했다고 치고(원문 그대로 저장) — 다시 정리로 한국어가 된다.
    const fake = new FakeLlmClient();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    await imports.runImport(r.job.id, {
      llm: { name: "x", generate: (req) => (req.task === "posting-translate" ? Promise.reject(new Error("down")) : fake.generate(req)) },
      fetchPage: async (url) => ({ url, html: englishHtml }),
    });
    warn.mockRestore();
    const id = (await imports.getImport("ua", r.job.id))!.postingId!;
    const before = (await service.getPosting("ua", id))!;
    expect(before.roleTitle).toBe("Senior Backend Engineer");
    expect(before.structured?.translatedFrom).toBeUndefined();
    expect(before.jdText).toContain("Design and build payment APIs");

    const after = (await restructure.restructurePosting("ua", id, { llm: new FakeLlmClient() }))!;
    expect(after.structured).toMatchObject({ translatedFrom: "en", jdComposed: true });
    expect(after.structured!.duties.every((d) => /[가-힣]/.test(d))).toBe(true);
    expect(after.jdText).toContain(after.structured!.duties[0]);
    expect(after.sourceText).toBe(before.sourceText);
  });
});
