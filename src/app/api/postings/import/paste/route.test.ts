/**
 * POST /api/postings/import/paste(PGlite, 세션·엔진·after()는 가짜, LLM은 FakeLlmClient): 출처·로그인, 입력 검사(링크·길이),
 * 202 → after()로 실행 → 작업 완료·공고 생성(사용량 기록용 userId로 클라이언트를 만든다), 중복 409 existingId, 공고 찾기 재사용.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { POSTING_LIMITS } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-posting-paste-"));
process.env.STORAGE_DIR = path.join(dir, "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "가" } as { id: string; email: string; name: string | null } | null,
  crossSite: false,
  afterTasks: [] as (() => unknown)[],
  llmCalls: [] as { provider: string; opts: unknown }[],
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossSite ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
vi.mock("@/lib/llm", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/llm")>();
  const { FakeLlmClient } = await import("@/test/fake-llm");
  return {
    ...actual,
    createLlmClient: (provider: string, opts: unknown) => {
      state.llmCalls.push({ provider, opts });
      return new FakeLlmClient();
    },
  };
});
// 붙여넣기 가져오기는 캡처하지 않는다 — 불리면 실패하게 둔다.
vi.mock("@/lib/postings/capture", () => ({
  runPostingCapture: vi.fn(async () => {
    throw new Error("capture must not run");
  }),
}));

let tdb: TestDb;
let paste: typeof import("./route");
let importJob: typeof import("../[jobId]/route");
let capture: typeof import("@/lib/postings/capture");

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["ua", "ub", "uc", "ud", "ue", "uf"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  paste = await import("./route");
  importJob = await import("../[jobId]/route");
  capture = await import("@/lib/postings/capture");
});
afterAll(() => tdb.close());
beforeEach(() => {
  state.user = { id: "ua", email: "ua@x.com", name: "가" };
  state.crossSite = false;
  state.afterTasks = [];
  state.llmCalls = [];
});

const post = (body: unknown) =>
  paste.POST(
    new Request("http://localhost/api/postings/import/paste", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: JSON.stringify(body),
    }),
  );
const ctx = (jobId: string) => ({ params: Promise.resolve({ jobId }) });
const pageText = [
  "채용 홈 | 채용 공고",
  "회사: 넥스트게임즈",
  "모집 직무: 게임 클라이언트 프로그래머",
  "접수 마감: 2026.12.31",
  "주요 업무",
  "- Unity 기반 클라이언트 개발",
  "자격 요건",
  "- C# 개발 경험 2년 이상",
  "정규직 채용이며 판교 사옥에서 근무합니다. ".repeat(5),
].join("\n");

describe("POST /api/postings/import/paste", () => {
  it("다른 출처 403, 로그인 없으면 401", async () => {
    state.crossSite = true;
    expect((await post({ url: "https://careers.example/1", pageText })).status).toBe(403);
    state.crossSite = false;
    state.user = null;
    expect((await post({ url: "https://careers.example/1", pageText })).status).toBe(401);
  });

  it("입력 검사: 짧은 본문·긴 본문·잘못된 링크·내부 주소는 한국어 400(작업을 만들지 않는다)", async () => {
    state.user = { id: "uc", email: "uc@x.com", name: null };
    const short = await post({ url: "https://careers.example/1", pageText: "회사: 짧음" });
    expect(short.status).toBe(400);
    expect(((await short.json()) as { error: string }).error).toContain("너무 짧습니다");
    const long = await post({ url: "https://careers.example/1", pageText: "가".repeat(POSTING_LIMITS.jdText + 1) });
    expect(long.status).toBe(400);
    expect(((await long.json()) as { error: string }).error).toContain("30,000자");
    expect((await post({ url: "not a url", pageText })).status).toBe(400);
    expect((await post({ url: "http://127.0.0.1/admin", pageText })).status).toBe(400);
    expect((await post({ url: "https://careers.example/1", pageText, extra: 1 })).status).toBe(400);
    expect(await tdb.prisma.postingImport.count({ where: { userId: "uc" } })).toBe(0);
    expect(state.afterTasks).toHaveLength(0);
  });

  it("202 → after()로 붙여넣은 본문을 분석해 공고를 만들고(캡처 없음), 같은 링크는 409 existingId, 다른 사용자에게는 공유되지 않는다", async () => {
    const res = await post({ url: "https://careers.example/recruit/10460", pageText });
    expect(res.status).toBe(202);
    const { jobId, job } = (await res.json()) as { jobId: string; job: { status: string } };
    expect(job.status).toBe("queued");
    expect(state.afterTasks).toHaveLength(1);
    await state.afterTasks[0]!();
    // 사용량 기록: 사용자·작업 id로 LLM 클라이언트를 만든다.
    expect(state.llmCalls).toEqual([{ provider: "anthropic", opts: { userId: "ua", referenceId: jobId } }]);
    expect(capture.runPostingCapture).not.toHaveBeenCalled();

    const polled = (await (await importJob.GET(new Request("http://localhost"), ctx(jobId))).json()) as {
      job: { status: string; postingId: string; errorCode: string | null };
    };
    expect(polled.job).toMatchObject({ status: "completed", errorCode: null });
    const posting = await tdb.prisma.jobPosting.findUniqueOrThrow({ where: { id: polled.job.postingId } });
    expect(posting).toMatchObject({ userId: "ua", company: "넥스트게임즈", roleTitle: "게임 클라이언트 프로그래머", url: "https://careers.example/recruit/10460" });

    const dup = await post({ url: "careers.example/recruit/10460/", pageText });
    expect(dup.status).toBe(409);
    expect(await dup.json()).toMatchObject({ existingId: posting.id });

    state.user = { id: "ub", email: "ub@x.com", name: null };
    state.afterTasks = [];
    // 붙여넣은 본문은 링크 공용 공고가 아니다 — 다른 사용자는 자기 붙여넣기로 새로 가져온다.
    const other = await post({ url: "https://careers.example/recruit/10460", pageText });
    expect(other.status).toBe(202);
    expect(state.afterTasks).toHaveLength(1);
  });

  describe("원문만 붙여넣기(링크 없음)", () => {
    it("url을 빼거나 비우면 링크 없이 202 → 공고를 만든다(출처 링크·링크 공용 공고 없음, 원문은 내 공고에만)", async () => {
      state.user = { id: "ud", email: "ud@x.com", name: null };
      const res = await post({ pageText });
      expect(res.status).toBe(202);
      const { jobId, job } = (await res.json()) as { jobId: string; job: { status: string; url: string } };
      expect(job).toMatchObject({ status: "queued", url: "" });
      await state.afterTasks[0]!();
      expect(state.llmCalls).toEqual([{ provider: "anthropic", opts: { userId: "ud", referenceId: jobId } }]);
      expect(capture.runPostingCapture).not.toHaveBeenCalled();
      const polled = (await (await importJob.GET(new Request("http://localhost"), ctx(jobId))).json()) as { job: { status: string; postingId: string } };
      expect(polled.job.status).toBe("completed");
      const posting = await tdb.prisma.jobPosting.findUniqueOrThrow({ where: { id: polled.job.postingId } });
      expect(posting).toMatchObject({ userId: "ud", company: "넥스트게임즈", roleTitle: "게임 클라이언트 프로그래머", url: null, urlKey: null, deadline: "2026-12-31" });
      expect(posting.sourceText).toContain("Unity 기반 클라이언트 개발");
      const shared = await tdb.prisma.sharedPosting.findUniqueOrThrow({ where: { id: posting.sharedPostingId! } });
      expect(shared).toMatchObject({ url: null, urlKey: null, sourceText: null });

      // 같은 본문을 다시 붙여넣어도 링크 중복 409가 없다(공백 url도 링크 없음).
      state.afterTasks = [];
      expect((await post({ url: "   ", pageText })).status).toBe(202);
    });

    it("입력 검사: 본문 길이(200..30000)·잘못된 링크는 여전히 400", async () => {
      state.user = { id: "ue", email: "ue@x.com", name: null };
      expect((await post({ pageText: "가".repeat(199) })).status).toBe(400);
      expect((await post({ pageText: "가".repeat(POSTING_LIMITS.jdText + 1) })).status).toBe(400);
      expect((await post({ url: "not a url", pageText })).status).toBe(400);
      expect((await post({})).status).toBe(400);
      expect(await tdb.prisma.postingImport.count({ where: { userId: "ue" } })).toBe(0);
    });

    it("출처 403·로그인 401, 하루 횟수 제한은 없다", async () => {
      state.crossSite = true;
      expect((await post({ pageText })).status).toBe(403);
      state.crossSite = false;
      state.user = null;
      expect((await post({ pageText })).status).toBe(401);
      state.user = { id: "uf", email: "uf@x.com", name: null };
      const at = new Date();
      await tdb.prisma.postingImport.createMany({
        data: Array.from({ length: 25 }, (_, i) => ({ id: `uf-old${i}`, userId: "uf", url: "", status: "failed", attempts: 1, createdAt: at, updatedAt: at })),
      });
      expect((await post({ pageText })).status).toBe(202);
    });
  });
});
