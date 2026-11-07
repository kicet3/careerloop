/**
 * GET·POST /api/resumes/[id]/tips(JD 맞춤 작성 팁, PGlite + 로컬 저장소 + 가짜 LLM + 메모리 그래프, 세션은 가짜):
 * 로그인·같은 출처·소유권(남의 이력서 404 — LLM·횟수 없음)·공용/JD 없음, 서버 거르기(공고에 없는 인용·키워드·근거 없는 숫자·그래프에 없는 노드),
 * 키워드 포함 여부(현재 버전 본문), 캐시(JD 해시 — 같은 JD면 LLM 없이, JD가 바뀌면 stale, 같은 사용자의 다른 이력서는 다시 쓰기),
 * 사용자끼리 캐시를 나누지 않음, 그래프 격리(남의 그래프가 프롬프트에 0회, 다른 소유 표시 그래프는 막힘), 하루 횟수.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { type CareerGraph, edgeId, type GraphNode } from "@/lib/domain/graph";
import type { ResumeJdTipsResponse } from "@/lib/domain/resume-jd-tips";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import type { LlmClient, LlmRequest } from "@/lib/llm/types";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-jd-tips-"));

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "홍길동" } as { id: string; email: string; name: string | null } | null,
  crossSite: false,
  graphs: new Map<string, unknown>(),
  forgedOwner: null as string | null,
  calls: [] as { task: string | undefined; system: string; user: string }[],
  llm: null as LlmClient | null,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossSite ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
vi.mock("@/lib/llm", async (orig) => ({ ...(await orig<typeof import("@/lib/llm")>()), createLlmClient: () => state.llm! }));
vi.mock("@/lib/graph/service", async () => {
  const { markGraphOwner } = await import("@/lib/graph/owner");
  const text = await import("@/lib/graph/text");
  return {
    graphToText: text.graphToText,
    graphEnabled: () => true,
    getCareerGraph: async (userId: string): Promise<CareerGraph> => {
      const g = (state.graphs.get(userId) as CareerGraph | undefined) ?? { person: { id: "me", name: null }, nodes: [], edges: [] };
      return markGraphOwner(structuredClone(g), state.forgedOwner ?? userId);
    },
  };
});

const node = (n: Omit<GraphNode, "createdAt" | "updatedAt">): GraphNode => ({ ...n, createdAt: 1, updatedAt: 1 }) as GraphNode;
const B_MARK = "ZQXB비밀프로젝트";
const graphA = (): CareerGraph => ({
  person: { id: "me", name: null },
  nodes: [
    node({ id: "p1", label: "Project", props: { name: "주문 시스템 개편", action: "Kotlin 서버를 Kafka로 나눴다", result: "처리 시간을 1200ms에서 300ms로 줄였다" } }),
    node({ id: "s_kotlin", label: "Skill", props: { name: "Kotlin" } }),
  ],
  edges: [{ id: edgeId("USED_SKILL", "p1", "s_kotlin"), type: "USED_SKILL", from: "p1", to: "s_kotlin" }],
});
const graphB = (): CareerGraph => ({
  person: { id: "me", name: null },
  nodes: [node({ id: "bp1", label: "Project", props: { name: B_MARK, action: "Kotlin Kafka 운영 9999건" } })],
  edges: [],
});
const JD = ["자격 요건", "- Kotlin 기반 서버 개발 경험", "- Kafka 이벤트 파이프라인 운영 경험", "우대 사항", "- AWS 운영 경험"].join("\n");

let tdb: TestDb;
let route: typeof import("./route");
let service: typeof import("@/lib/resumes/service");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(dir, "storage");
  tdb = await createTestDb();
  route = await import("./route");
  service = await import("@/lib/resumes/service");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(async () => {
  await tdb.reset();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
  state.crossSite = false;
  state.forgedOwner = null;
  state.calls = [];
  state.graphs = new Map<string, unknown>([
    ["ua", graphA()],
    ["ub", graphB()],
  ]);
  const fake = new FakeLlmClient();
  state.llm = {
    name: "rec",
    generate: async <T,>(req: LlmRequest<T>) => {
      state.calls.push({ task: req.task, system: req.system, user: req.user });
      return fake.generate(req);
    },
  };
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const get = (id: string) => route.GET(new Request(`http://localhost/api/resumes/${id}/tips`), ctx(id));
const post = (id: string, body: unknown = {}) =>
  route.POST(
    new Request(`http://localhost/api/resumes/${id}/tips`, {
      method: "POST",
      headers: { Origin: "http://localhost", "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    ctx(id),
  );
const asUser = (id: "ua" | "ub") => (state.user = { id, email: `${id}@x.com`, name: null });

async function resume(userId = "ua", opts: { jdText?: string | null; kind?: "company" | "general"; postingId?: string | null; skills?: string[] } = {}) {
  const document = emptyResumeDocument();
  if (opts.skills) document.skills = [{ category: "백엔드", detail: "", items: opts.skills }];
  const { resume } = await service.createResume(userId, {
    kind: opts.kind,
    company: "페이랩",
    roleTitle: "백엔드 개발자",
    jdText: opts.jdText === undefined ? JD : opts.jdText,
    templateId: "classic",
    document,
    source: "manual",
    postingId: opts.postingId ?? null,
  });
  return resume.id;
}

type Loaded = Extract<ResumeJdTipsResponse, { status: "ready" | "stale" }>;
const json = async (res: Response) => (await res.json()) as ResumeJdTipsResponse;

describe("/api/resumes/[id]/tips", () => {
  it("로그인·같은 출처·소유권: 401, 403, 남의 이력서는 404(LLM·횟수 없음)", async () => {
    const id = await resume("ua");
    state.user = null;
    expect((await get(id)).status).toBe(401);
    expect((await post(id)).status).toBe(401);
    state.user = { id: "ua", email: "ua@x.com", name: null };
    state.crossSite = true;
    expect((await post(id)).status).toBe(403);
    state.crossSite = false;
    asUser("ub");
    expect((await get(id)).status).toBe(404);
    expect((await post(id)).status).toBe(404);
    expect((await post("nope")).status).toBe(404);
    expect(state.calls).toHaveLength(0);
    expect(await tdb.prisma.rateEvent.count()).toBe(0);
    expect(await tdb.prisma.resumeJdTips.count()).toBe(0);
  });

  it("공용 이력서·JD 없음: GET no_jd, POST 400(LLM 없음). 연결 공고의 JD는 쓴다", async () => {
    const general = await resume("ua", { kind: "general" });
    expect(await json(await get(general))).toEqual({ status: "no_jd", reason: "general" });
    expect((await post(general)).status).toBe(400);
    const empty = await resume("ua", { jdText: null });
    expect(await json(await get(empty))).toEqual({ status: "no_jd", reason: "empty" });
    expect((await post(empty)).status).toBe(400);
    expect(state.calls).toHaveLength(0);

    await tdb.prisma.jobPosting.create({ data: { id: "post-a", userId: "ua", company: "페이랩", roleTitle: "백엔드 개발자", jdText: JD } });
    await tdb.prisma.jobPosting.create({ data: { id: "post-b", userId: "ub", company: "페이랩", roleTitle: "백엔드 개발자", jdText: JD } });
    const linked = await resume("ua", { jdText: null, postingId: "post-a" });
    expect(await json(await get(linked))).toEqual({ status: "none" });
    // 남의 공고 id가 붙어 있어도 그 JD는 읽지 않는다.
    await tdb.prisma.companyResume.update({ where: { id: linked }, data: { postingId: "post-b" } });
    expect(await json(await get(linked))).toEqual({ status: "no_jd", reason: "empty" });
  });

  it("만들기: 서버가 공고에 없는 인용·키워드·근거 없는 숫자·그래프에 없는 노드를 거르고, 키워드 포함 여부를 센다", async () => {
    const id = await resume("ua", { skills: ["kotlin"] });
    expect(await json(await get(id))).toEqual({ status: "none" });
    const res = await post(id);
    expect(res.status).toBe(200);
    const body = (await json(res)) as Loaded;
    expect(body.status).toBe("ready");
    expect(body.reused).toBe(false);
    const all = JSON.stringify(body);
    // 근거 없는 숫자(요약 7년, 팁 4500%)·공고에 없는 인용·키워드·노드는 빠진다.
    expect(all).not.toContain("7년");
    expect(all).not.toContain("4500%");
    expect(all).not.toContain("공고 원문에 없는 문장");
    expect(all).not.toContain("공고에없는키워드");
    expect(all).not.toContain("그래프에 없는 노드");
    expect(body.tips.summary.map((s) => s.text)).toEqual(["자격 요건", "Kotlin 기반 서버 개발 경험", "Kafka 이벤트 파이프라인 운영 경험"]);
    expect(body.tips.sections.map((s) => s.section)).toEqual(["first", "highlights"]);
    for (const s of body.tips.sections) for (const t of s.tips) expect(JD.replace(/\s+/g, "")).toContain(t.jdQuote.replace(/\s+/g, ""));
    // 쓸 만한 경험: 본인 그래프 노드 이름·종류만(id는 응답에 없다).
    expect(body.tips.experiences.map((e) => e.name)).toEqual(["주문 시스템 개편", "Kotlin"]);
    expect(body.tips.experiences[0]).not.toHaveProperty("nodeId");
    // 키워드: 공고에 있는 것만, 포함 여부는 이력서 본문(대소문자 무시).
    expect(body.coverage).toEqual([
      { keyword: "Kotlin", included: true },
      { keyword: "Kafka", included: false },
      { keyword: "AWS", included: false },
    ]);

    expect(state.calls).toHaveLength(1);
    const call = state.calls[0]!;
    expect(call.task).toBe("resume-jd-tips");
    expect(call.system).toContain("jdQuote");
    expect(call.system).toContain("지어내지 않는다");
    expect(call.user).toContain("<job_posting>");
    expect(call.user).toContain("<career_graph>");
    expect(call.user).toContain("[p1] 주문 시스템 개편");
    // 남의 그래프는 프롬프트에 없다.
    expect(call.user).not.toContain(B_MARK);
    expect(await tdb.prisma.rateEvent.count({ where: { bucket: "resume-jd-tips", key: "ua" } })).toBe(1);
    const row = await tdb.prisma.resumeJdTips.findUniqueOrThrow({ where: { resumeId: id } });
    expect(row).toMatchObject({ userId: "ua", model: expect.any(String) });
  });

  it("캐시: 같은 JD면 LLM 없이 돌려주고, JD가 바뀌면 stale → 다시 만들면 ready. force는 항상 다시 만든다", async () => {
    const id = await resume("ua");
    await post(id);
    expect(state.calls).toHaveLength(1);
    expect(((await json(await post(id))) as Loaded).status).toBe("ready");
    expect(((await json(await get(id))) as Loaded).status).toBe("ready");
    expect(state.calls).toHaveLength(1);
    // 공백만 다른 JD는 같은 JD다.
    await service.updateResumeMeta("ua", id, { jdText: `  ${JD.replace(/\n/g, "\n\n")}  ` });
    expect(((await json(await get(id))) as Loaded).status).toBe("ready");
    // JD가 바뀌면 stale(예전 팁은 그대로 보인다).
    await service.updateResumeMeta("ua", id, { jdText: `${JD}\n- Redis 캐시 설계 경험` });
    const stale = (await json(await get(id))) as Loaded;
    expect(stale.status).toBe("stale");
    expect(stale.tips.keywords).toContain("Kotlin");
    expect(state.calls).toHaveLength(1);
    const fresh = (await json(await post(id))) as Loaded;
    expect(fresh.status).toBe("ready");
    expect(fresh.tips.keywords).toContain("Redis");
    expect(state.calls).toHaveLength(2);
    expect(((await json(await post(id, { force: true }))) as Loaded).status).toBe("ready");
    expect(state.calls).toHaveLength(3);
    expect(await tdb.prisma.resumeJdTips.count()).toBe(1);
  });

  it("같은 사용자의 다른 이력서가 같은 JD면 LLM 없이 다시 쓴다(reused) — 다른 사용자와는 나누지 않는다", async () => {
    const a1 = await resume("ua");
    await post(a1);
    const a2 = await resume("ua");
    const reused = (await json(await get(a2))) as Loaded;
    expect(reused).toMatchObject({ status: "ready", reused: true });
    expect(((await json(await post(a2))) as Loaded).status).toBe("ready");
    expect(state.calls).toHaveLength(1);
    expect(await tdb.prisma.resumeJdTips.count({ where: { userId: "ua" } })).toBe(2);

    // B: 회사·직무·JD가 완전히 같아도 A의 팁을 보지 않는다.
    asUser("ub");
    const b1 = await resume("ub");
    expect(await json(await get(b1))).toEqual({ status: "none" });
    const bTips = (await json(await post(b1))) as Loaded;
    expect(bTips.reused).toBe(false);
    expect(state.calls).toHaveLength(2);
    expect(JSON.stringify(bTips)).not.toContain("주문 시스템 개편");
    expect(bTips.tips.experiences.map((e) => e.name)).toEqual([B_MARK]);
    // B의 프롬프트에도 A 그래프는 없다.
    expect(state.calls[1]!.user).not.toContain("주문 시스템 개편");
    // B에서 A 이력서 id로 묻는 것은 404.
    expect((await get(a1)).status).toBe(404);
  });

  it("다른 사용자 소유 표시 그래프는 막힌다(LLM 호출·저장 없음)", async () => {
    const id = await resume("ua");
    state.forgedOwner = "ub";
    const res = await post(id);
    expect(res.status).toBe(500);
    expect(state.calls).toHaveLength(0);
    expect(await tdb.prisma.resumeJdTips.count()).toBe(0);
  });

  it("하루 횟수: 10번 만든 뒤 429(저장된 팁 읽기·다시 쓰기는 세지 않는다)", async () => {
    const id = await resume("ua");
    for (let i = 0; i < 10; i++) expect((await post(id, { force: true })).status).toBe(200);
    expect((await post(id)).status).toBe(200);
    const res = await post(id, { force: true });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(state.calls).toHaveLength(10);
  });
});
