/**
 * 회사 목록 API(PGlite, 세션은 가짜): GET /api/shared-postings/companies(숨긴 공고 제외, 관리자도 같다)·GET /api/postings/companies(내 공고만),
 * 검색어·개수·고른 회사(include), 로그인 없으면 401.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PostingCreateInputSchema } from "@/lib/domain/postings";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "가", role: "user" } as { id: string; email: string; name: string | null; role: string } | null,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
}));

let tdb: TestDb;
let sharedRoute: typeof import("./route");
let libraryRoute: typeof import("@/app/api/postings/companies/route");
let shared: typeof import("@/lib/postings/shared");
let service: typeof import("@/lib/postings/service");

const input = (company: string) => PostingCreateInputSchema.parse({ company, roleTitle: "개발자" });
const get = async (route: { GET: (req: Request) => Promise<Response> }, qs = "") => {
  const res = await route.GET(new Request(`http://localhost/api/x${qs}`));
  return { status: res.status, body: (await res.json()) as { options?: { key: string; label: string; count: number }[] } };
};

beforeAll(async () => {
  tdb = await createTestDb();
  sharedRoute = await import("./route");
  libraryRoute = await import("@/app/api/postings/companies/route");
  shared = await import("@/lib/postings/shared");
  service = await import("@/lib/postings/service");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  await tdb.reset();
  state.user = { id: "ua", email: "ua@x.com", name: "가", role: "user" };
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, status: "approved" } });
});

async function seedShared(i: number, company: string) {
  return shared.upsertSharedPosting({ url: `https://example.com/jobs/${i}`, posting: input(company), structure: null, sourceText: "", extractedBy: "anthropic", createdBy: "ub" });
}

describe("GET /api/shared-postings/companies", () => {
  it("숨기지 않은 공용 공고의 회사만(관리자도), 검색·개수·고른 회사", async () => {
    await seedShared(1, "(주)카카오");
    await seedShared(2, "카카오");
    await seedShared(3, "토스");
    await shared.setSharedPostingHidden((await seedShared(4, "숨긴회사")).id, true);
    const all = await get(sharedRoute);
    expect(all.status).toBe(200);
    expect(all.body.options?.map((o) => [o.key, o.count])).toEqual([
      ["카카오", 2],
      ["토스", 1],
    ]);
    state.user = { id: "ua", email: "ua@x.com", name: "관리자", role: "admin" };
    expect((await get(sharedRoute, "?include=%EC%88%A8%EA%B8%B4%ED%9A%8C%EC%82%AC")).body.options?.map((o) => o.key)).toEqual(["카카오", "토스"]);
    expect((await get(sharedRoute, "?q=%ED%86%A0")).body.options?.map((o) => o.key)).toEqual(["토스"]);
    expect((await get(sharedRoute, "?limit=1&include=%ED%86%A0%EC%8A%A4")).body.options?.map((o) => o.key)).toEqual(["카카오", "토스"]);
  });

  it("로그인 없으면 401", async () => {
    state.user = null;
    expect((await get(sharedRoute)).status).toBe(401);
    expect((await get(libraryRoute)).status).toBe(401);
  });
});

describe("GET /api/postings/companies", () => {
  it("내 공고의 회사만", async () => {
    await service.createPosting("ua", input("Toss Inc."));
    await service.createPosting("ua", input("toss"));
    await service.createPosting("ub", input("남의회사"));
    const res = await get(libraryRoute);
    expect(res.status).toBe(200);
    expect(res.body.options).toEqual([{ key: "toss", label: "toss", count: 2 }]);
    expect((await get(libraryRoute, "?q=%EB%82%A8%EC%9D%98")).body.options).toEqual([]);
  });
});
