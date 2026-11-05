/** GET /api/postings/[id]/match, GET /api/insights/skills — 인증·오류 응답(대조 서비스는 가짜로 바꾼다). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureError } from "@/lib/api/errors";
import { GraphUnavailableError } from "@/lib/graph/errors";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({ user: { id: "u1", email: "a@example.com", name: null } as { id: string } | null }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
}));
const service = vi.hoisted(() => ({ matchPosting: vi.fn(), skillGapAcrossPostings: vi.fn() }));
vi.mock("@/lib/graph/match-service", () => service);

const { GET: matchGet } = await import("./route");
const { GET: skillsGet } = await import("@/app/api/insights/skills/route");

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  state.user = { id: "u1" };
  service.matchPosting.mockReset();
  service.skillGapAcrossPostings.mockReset();
});

describe("GET /api/postings/[id]/match", () => {
  it("로그인 사용자 id로 대조한다", async () => {
    service.matchPosting.mockResolvedValue({ postingId: "p1", items: [] });
    const res = await matchGet(new Request("http://localhost/api/postings/p1/match"), ctx("p1"));
    expect(res.status).toBe(200);
    expect(service.matchPosting).toHaveBeenCalledWith("u1", "p1");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  it("비로그인 401, 남의 공고 404, 그래프 꺼짐 503", async () => {
    state.user = null;
    expect((await matchGet(new Request("http://localhost/x"), ctx("p1"))).status).toBe(401);
    state.user = { id: "u1" };
    service.matchPosting.mockRejectedValueOnce(new FeatureError("공고를 찾을 수 없습니다.", 404));
    const notFound = await matchGet(new Request("http://localhost/x"), ctx("p2"));
    expect(notFound.status).toBe(404);
    expect(await notFound.json()).toEqual({ error: "공고를 찾을 수 없습니다." });
    service.matchPosting.mockRejectedValueOnce(new GraphUnavailableError());
    expect((await matchGet(new Request("http://localhost/x"), ctx("p1"))).status).toBe(503);
  });
});

describe("GET /api/insights/skills", () => {
  it("로그인 사용자 기준 스킬 갭, 그래프 꺼짐 503", async () => {
    service.skillGapAcrossPostings.mockResolvedValue({ items: [], postingsConsidered: 0, graphEmpty: true });
    const res = await skillsGet();
    expect(res.status).toBe(200);
    expect(service.skillGapAcrossPostings).toHaveBeenCalledWith("u1");
    service.skillGapAcrossPostings.mockRejectedValueOnce(new GraphUnavailableError());
    expect((await skillsGet()).status).toBe(503);
    state.user = null;
    expect((await skillsGet()).status).toBe(401);
  });
});
