/**
 * POST /api/postings/[id]/structure('AI로 다시 정리', PGlite 테스트 DB, 세션·엔진·LLM은 가짜): 소유권 404, 같은 출처 검사,
 * 하루 횟수 제한, 가짜 LLM 결과 저장(가져온 원문 기준이면 jdText 재조합), LLM 오류의 사용자용 문구.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { LlmPermanentError, type LlmClient } from "@/lib/llm/types";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "가" } as { id: string; email: string; name: string | null } | null,
  crossSite: false,
  llm: null as LlmClient | null,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossSite ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
vi.mock("@/lib/llm", async (orig) => ({ ...(await orig<typeof import("@/lib/llm")>()), createLlmClient: () => state.llm! }));

let tdb: TestDb;
let route: typeof import("./route");
let service: typeof import("@/lib/postings/service");
let http: typeof import("@/lib/postings/http");

const RAW = [
  "회사: 페이랩",
  "모집 직무: 백엔드 개발자",
  "주요 업무",
  "- 결제 API 개발",
  "자격 요건",
  "- Python 3년 이상",
  "- SQL 경험",
  "우대 사항",
  "- Kafka 경험",
  "연봉: 회사 내규에 따름",
].join("\n");

beforeAll(async () => {
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  route = await import("./route");
  service = await import("@/lib/postings/service");
  http = await import("@/lib/postings/http");
});

afterAll(() => tdb.close());

beforeEach(() => {
  state.user = { id: "ua", email: "ua@x.com", name: "가" };
  state.crossSite = false;
  state.llm = new FakeLlmClient();
  for (const id of ["ua", "ub"]) {
    http.postingStructureDailyLimiter.reset(id);
    http.postingImportBurstLimiter.reset(id);
  }
});

const post = (id: string) => route.POST(new Request(`http://localhost/api/postings/${id}/structure`, { method: "POST", headers: { Origin: "http://localhost" } }), { params: Promise.resolve({ id }) });

async function importedPosting() {
  const { PostingCreateInputSchema } = await import("@/lib/domain/postings");
  // URL 가져오기에서 구조가 얇아 jdText에 원문이 그대로 남은 상태.
  return service.createPosting("ua", PostingCreateInputSchema.parse({ company: "페이랩", roleTitle: "백엔드 개발자", jdText: RAW }), {
    extractedBy: "fake",
    structure: null,
    sourceText: RAW,
  });
}

describe("POST /api/postings/[id]/structure", () => {
  it("가짜 LLM 결과를 저장하고, 가져온 원문 기준이면 jdText를 구역 텍스트로 다시 조합한다", async () => {
    const p = await importedPosting();
    const res = await post(p.id);
    expect(res.status).toBe(200);
    const { posting } = (await res.json()) as { posting: Awaited<ReturnType<typeof service.getPosting>> };
    expect(posting!.structured).toMatchObject({
      source: "llm",
      jdComposed: true,
      duties: ["결제 API 개발"],
      requirements: ["Python 3년 이상", "SQL 경험"],
      preferred: ["Kafka 경험"],
      conditions: { salary: "회사 내규에 따름" },
    });
    expect(posting!.jdText).toContain("자격 요건\n- Python 3년 이상");
    expect(posting!.sourceText).toBe(RAW);
    expect((await service.getPosting("ua", p.id))!.structured?.source).toBe("llm");
  });

  it("남의 공고는 404, 다른 출처는 403, 로그인 없으면 401", async () => {
    const { id } = await importedPosting();
    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await post(id)).status).toBe(404);
    state.crossSite = true;
    expect((await post(id)).status).toBe(403);
    state.crossSite = false;
    state.user = null;
    expect((await post(id)).status).toBe(401);
  });

  it("하루 횟수를 넘으면 429", async () => {
    const [p] = await service.listPostings("ua");
    for (let i = 0; i < http.DAILY_POSTING_STRUCTURE_LIMIT; i++) http.postingStructureDailyLimiter.hit("ua");
    const res = await post(p!.id);
    expect(res.status).toBe(429);
    expect(((await res.json()) as { error: string }).error).toContain("하루");
  });

  it("LLM 오류는 사용자용 문구로 바꾼다(내부 내용 없음)", async () => {
    const [p] = await service.listPostings("ua");
    state.llm = {
      name: "broken",
      generate: async () => {
        throw new LlmPermanentError("INTERNAL_SECRET 401 from upstream", "auth");
      },
    };
    const res = await post(p!.id);
    expect(res.status).toBe(502);
    const { error } = (await res.json()) as { error: string };
    expect(error).toContain("AI 계정 로그인");
    expect(error).not.toContain("INTERNAL_SECRET");
  });

  it("JD가 없는 공고는 400", async () => {
    const { PostingCreateInputSchema } = await import("@/lib/domain/postings");
    const empty = await service.createPosting("ua", PostingCreateInputSchema.parse({ company: "빈", roleTitle: "x" }));
    expect((await post(empty.id)).status).toBe(400);
  });
});
