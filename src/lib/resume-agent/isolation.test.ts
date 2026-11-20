/**
 * 격리(최우선): 사용자 A의 에이전트 작업의 모든 LLM 프롬프트에 사용자 B의 그래프 문자열이 0회 나온다. 소유 표시가 다른 그래프가
 * 섞이면 GraphOwnerMismatchError로 단계가 실패한다(재시도 없음). 소스 검사: resume-agent 안에서 getCareerGraph는 loadAgentGraph 안에서만,
 * loadAgentGraph에는 assertGraphOwner가 있다.
 *
 * (아래 설정은 jobs.test.ts와 같다) 그래프 이력서 에이전트 통합(PGlite + 로컬 저장소 + 가짜 LLM + 메모리 그래프 저장소, 세션은 가짜).
 * POST /api/resumes(mode agent) → 202 → after()로 이어 가기 → 단계별 저장 → 심사·수정 루프 → 이력서·리포트·알림.
 * 여러 호출에 나눠 실행, 동시 이어 가기(리스 하나), 실패 단계부터 다시 시도, 심사 실패 시 최선 초안 저장, 리스 만료 회수, 24시간 멈춤,
 * 그래프 부족, 동시 작업 3개·이력서 상한, 루프 종료(passed·plateau·max_rounds), "JD 요건 반영" 고정(§0.1).
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import type { LlmClient, LlmRequest } from "@/lib/llm";
import { createTestDb, type TestDb } from "@/test/db";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { AGENT_JD, B_MARK, graphA, graphB } from "./__fixtures__/agent-graph";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-agent-jobs-")), "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "홍길동", role: "user" } as { id: string; email: string; name: string | null } | null,
  afterTasks: [] as (() => unknown)[],
  client: null as unknown,
  graphs: new Map<string, unknown>(),
  calls: [] as { label: string; user: string }[],
  forgedOwner: null as string | null,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => null,
}));
vi.mock("next/server", () => ({ after: (fn: () => unknown) => state.afterTasks.push(fn) }));
vi.mock("@/lib/providers/options", () => ({ resolveRequestedProvider: async () => "anthropic" }));
vi.mock("@/lib/llm", async (orig) => ({ ...(await orig<typeof import("@/lib/llm")>()), createLlmClient: () => state.client }));
vi.mock("@/lib/graph/service", async () => {
  const { markGraphOwner } = await import("@/lib/graph/owner");
  const text = await import("@/lib/graph/text");
  return {
    graphToText: text.graphToText,
    graphEnabled: () => true,
    getCareerGraph: async (userId: string): Promise<CareerGraph> => {
      const g = (state.graphs.get(userId) as CareerGraph | undefined) ?? { person: { id: "me", name: null }, nodes: [], edges: [] };
      // 버그 흉내: forgedOwner가 있으면 다른 사용자의 소유 표시가 붙은 그래프를 돌려준다.
      return markGraphOwner(structuredClone(g), state.forgedOwner ?? userId);
    },
  };
});

let tdb: TestDb;
let resumesRoute: typeof import("@/app/api/resumes/route");
let FakeLlmClient: typeof import("@/test/fake-llm").FakeLlmClient;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL", "RESUME_AGENT", "RESUME_AGENT_CHAIN_SECRET"]) delete process.env[k];
  tdb = await createTestDb();
  resumesRoute = await import("@/app/api/resumes/route");
  ({ FakeLlmClient } = await import("@/test/fake-llm"));
});
afterAll(() => tdb.close());

beforeEach(async () => {
  await tdb.reset();
  state.afterTasks = [];
  state.calls = [];
  state.forgedOwner = null;
  state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
  state.graphs = new Map<string, unknown>([
    ["ua", graphA()],
    ["ub", graphB()],
  ]);
  const fake = new FakeLlmClient();
  state.client = {
    name: "rec",
    generate: async <T,>(req: LlmRequest<T>) => {
      state.calls.push({ label: req.task ?? req.stage, user: `${req.system}\n${req.user}` });
      return fake.generate(req);
    },
  } satisfies LlmClient;
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: id === "ua" ? "홍길동" : "비밀B", status: "approved" } });
});

async function runAgent(opts: { forgeOwnerAfterStart?: string } = {}): Promise<string> {
  const res = await resumesRoute.POST(
    new Request("http://localhost/api/resumes", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD, templateId: "developer", source: { kind: "graph" } }),
    }),
  );
  expect(res.status).toBe(202);
  const id = ((await res.json()) as { agentJob: { id: string } }).agentJob.id;
  if (opts.forgeOwnerAfterStart) state.forgedOwner = opts.forgeOwnerAfterStart;
  while (state.afterTasks.length) await state.afterTasks.shift()!();
  return id;
}

describe("사용자 간 격리", () => {
  it("A의 작업: 모든 프롬프트(system+user)에 B의 노드 이름·속성·이름·메일이 0회, A의 이름·메일도 LLM에 가지 않는다", async () => {
    const id = await runAgent();
    const job = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("completed");
    expect(state.calls.length).toBeGreaterThan(10);
    const b = graphB();
    const bStrings = [B_MARK, "9999건", "8888억", ...b.nodes.map((n) => String((n.props as Record<string, unknown>).name ?? "")).filter((x) => x.length > 3), "ub@x.com", "비밀B"];
    for (const c of state.calls) {
      for (const s of bStrings) expect(c.user.includes(s), `${c.label}: ${s}`).toBe(false);
      // 계정 이름·메일은 프롬프트에 넣지 않는다(저장 때 서버가 채운다).
      expect(c.user.includes("ua@x.com"), c.label).toBe(false);
      expect(c.user.includes("홍길동"), c.label).toBe(false);
      // Neo4j id도 넣지 않는다(E1… ref만).
      expect(/\b(p1|p2|r1|c1|s_kafka)\b/.test(c.user), c.label).toBe(false);
    }
    // 저장한 단계 출력·뷰에도 B 데이터가 없다.
    const steps = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId: id } });
    expect(JSON.stringify(steps)).not.toContain(B_MARK);
  });

  it("다른 사용자 소유 표시가 붙은 그래프가 오면 retrieve 단계가 GraphOwnerMismatchError로 멈춘다(재시도 없음, LLM 근거 호출 없음)", async () => {
    // 시작 요청 때 소유 표시가 틀리면 에이전트를 아예 시작하지 않는다(그래프 확인 실패 → 빠른 초안으로 넘김).
    state.forgedOwner = "ub";
    const fallback = await resumesRoute.POST(
      new Request("http://localhost/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD, templateId: "developer", source: { kind: "graph" }, mode: "agent" }),
      }),
    );
    const fallbackBody = (await fallback.json()) as { agentJob?: unknown; modeFallback?: string };
    expect(fallbackBody.agentJob).toBeUndefined();
    expect(fallbackBody.modeFallback).toBe("agent_unavailable");
    state.afterTasks = [];
    state.forgedOwner = null;
    // 시작 뒤(실행 중) 소유 표시가 틀린 그래프가 오면 retrieve가 멈춘다.
    const id = await runAgent({ forgeOwnerAfterStart: "ub" });
    const job = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id } });
    expect(job.status).toBe("failed");
    expect(job.failedStep).toBe("r0.retrieve");
    const step = await tdb.prisma.resumeAgentStep.findFirstOrThrow({ where: { jobId: id, key: "r0.retrieve" } });
    expect(step.attempt).toBe(1);
    expect(state.calls.filter((c) => c.label === "resume-agent-plan" || c.label === "resume-agent-brief" || c.label === "resume-agent-section")).toHaveLength(0);
  });

  it("B는 A의 작업을 볼 수 없다(404)", async () => {
    const id = await runAgent();
    const route = await import("@/app/api/resumes/agent-jobs/[id]/route");
    state.user = { id: "ub", email: "ub@x.com", name: null };
    const res = await route.GET(new Request("http://localhost/x"), { params: Promise.resolve({ id }) });
    expect(res.status).toBe(404);
  });
});

describe("소스 검사(그래프 읽기 경로)", () => {
  const dir = path.resolve(import.meta.dirname);
  const files = (d: string): string[] =>
    readdirSync(d).flatMap((f) => {
      const p = path.join(d, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") && !p.endsWith(".test.ts") && !p.includes("__fixtures__") ? [p] : [];
    });

  it("v2 근거 검색(evidence-source.ts)은 loadAgentGraph로만 그래프를 읽는다", () => {
    const src = readFileSync(path.join(dir, "evidence-source.ts"), "utf8");
    expect(src).toContain("load: (job: { userId: string }) => Promise<CareerGraph> = loadAgentGraph");
    expect(src).not.toMatch(/getCareerGraph\(/);
  });

  it("resume-agent 안에서 getCareerGraph는 evidence.ts loadAgentGraph 본문에서만 부른다", () => {
    for (const f of files(dir)) {
      const src = readFileSync(f, "utf8");
      const calls = [...src.matchAll(/getCareerGraph\(/g)];
      if (!f.endsWith("evidence.ts")) {
        expect(calls.length, f).toBe(0);
        continue;
      }
      const body = /export async function loadAgentGraph\([^)]*\)[^{]*\{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
      expect(calls.length).toBe(1);
      expect(body).toContain("getCareerGraph(");
      expect(body).toContain("assertGraphOwner(");
      expect(body).toContain("job.userId");
    }
  });
});
