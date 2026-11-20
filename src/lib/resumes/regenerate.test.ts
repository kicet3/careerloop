/**
 * 이미 만든 이력서 '다시 생성'(PGlite + 로컬 저장소 + 가짜 LLM + 메모리 그래프, 세션은 가짜).
 * POST /api/resumes/[id]/regenerate: 로그인(401)·같은 출처(403)·남의 이력서(404)·입력 검증(400)·같은 이력서 진행 중(409)·하루 한도(429)·동시 작업.
 * 빠른 초안·에이전트 모두 새 이력서가 아니라 대상 이력서의 새 버전(source 'ai', 메모 'AI 다시 생성 (…)')을 저장하고, 지원 동기·연락처·링크·
 * 사진 설정을 지키고, 고른 양식·고친 JD를 반영한다. 재시도·버려진 실행이 버전을 둘 만들지 않고, 실행 중 삭제된 이력서는 깔끔하게 실패한다.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import type { ResumeDocument } from "@/lib/domain/resumes";
import { AGENT_JD, graphA } from "@/lib/resume-agent/__fixtures__/agent-graph";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-regenerate-")), "storage");

const state = vi.hoisted(() => ({
  user: { id: "ua", email: "ua@x.com", name: "홍길동" } as { id: string; email: string; name: string | null } | null,
  afterTasks: [] as (() => unknown)[],
  client: null as unknown,
  graphs: new Map<string, unknown>(),
  prompts: [] as { task: string; user: string }[],
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: (req: Request) => (req.headers.get("origin") === "https://evil.example" ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
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
      return markGraphOwner(structuredClone(g), userId);
    },
  };
});

let tdb: TestDb;
let route: typeof import("@/app/api/resumes/[id]/regenerate/route");
let draftRetryRoute: typeof import("@/app/api/resumes/drafts/[id]/retry/route");
let service: typeof import("./service");
let draftJobs: typeof import("./draft-jobs");
let agentJobs: typeof import("@/lib/resume-agent/jobs");
let regenerate: typeof import("./regenerate");
let domain: typeof import("@/lib/domain/resumes");
let FakeLlmClient: typeof import("@/test/fake-llm").FakeLlmClient;

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET", "VERCEL", "RESUME_AGENT", "RESUME_AGENT_CHAIN_SECRET", "RESUME_AGENT_MAX_REVISIONS"]) delete process.env[k];
  tdb = await createTestDb();
  route = await import("@/app/api/resumes/[id]/regenerate/route");
  draftRetryRoute = await import("@/app/api/resumes/drafts/[id]/retry/route");
  service = await import("./service");
  draftJobs = await import("./draft-jobs");
  agentJobs = await import("@/lib/resume-agent/jobs");
  regenerate = await import("./regenerate");
  domain = await import("@/lib/domain/resumes");
  ({ FakeLlmClient } = await import("@/test/fake-llm"));
});
afterAll(() => tdb.close());

let resumeId: string;
let otherResumeId: string;

function userDocument(): ResumeDocument {
  const doc = domain.emptyResumeDocument();
  doc.basics.name = "홍길동(직접)";
  doc.basics.email = "me@custom.dev";
  doc.basics.phone = "010-1234-5678";
  doc.basics.portfolioUrl = "https://me.dev";
  doc.basics.links = [{ label: "GitHub", url: "https://github.com/me" }];
  doc.basics.headline = "예전 헤드라인";
  doc.motivation = "토스의 결제 문제를 풀고 싶어 지원합니다.";
  return doc;
}

beforeEach(async () => {
  await tdb.reset();
  state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
  state.afterTasks = [];
  state.prompts = [];
  const fake = new FakeLlmClient();
  state.client = {
    name: "rec",
    generate: async (req: { task?: string; stage?: string; user: string }) => {
      state.prompts.push({ task: req.task ?? req.stage ?? "", user: req.user });
      return fake.generate(req as never);
    },
  };
  state.graphs = new Map([
    ["ua", graphA()],
    ["ub", graphA()],
  ]);
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: id === "ua" ? "홍길동" : null, status: "approved" } });
  const base = { company: "토스", roleTitle: "백엔드 개발자", jdText: AGENT_JD, templateId: "developer" as const, document: userDocument(), source: "manual" as const };
  resumeId = (await service.createResume("ua", { ...base, title: "토스 백엔드", includePhoto: false })).resume.id;
  otherResumeId = (await service.createResume("ub", { ...base, title: "남의 이력서" })).resume.id;
});

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const post = (id: string, body: unknown, headers: Record<string, string> = {}) =>
  route.POST(
    new Request(`http://localhost/api/resumes/${id}/regenerate`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) }),
    ctx(id),
  );
async function runAfter() {
  while (state.afterTasks.length) await state.afterTasks.shift()!();
}
async function versionsOf(id: string) {
  return tdb.prisma.resumeVersion.findMany({ where: { resumeId: id }, orderBy: { versionNo: "asc" } });
}
async function currentDoc(id: string, userId = "ua") {
  const found = await service.getVersionDocument(userId, id);
  return found!;
}

describe("POST /api/resumes/[id]/regenerate — 권한·검증", () => {
  it("로그인이 없으면 401, 다른 출처면 403(작업을 만들지 않는다)", async () => {
    state.user = null;
    expect((await post(resumeId, { mode: "single" })).status).toBe(401);
    state.user = { id: "ua", email: "ua@x.com", name: "홍길동" };
    expect((await post(resumeId, { mode: "single" }, { origin: "https://evil.example" })).status).toBe(403);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(0);
  });

  it("남의 이력서·없는 이력서는 404(한도를 쓰지 않고 작업도 없다)", async () => {
    expect((await post(otherResumeId, { mode: "single" })).status).toBe(404);
    expect((await post("nope", { mode: "agent" })).status).toBe(404);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(0);
    expect(await tdb.prisma.rateEvent.count()).toBe(0);
  });

  it("잘못된 입력은 400(강조할 점 길이·모르는 양식)", async () => {
    expect((await post(resumeId, { mode: "single", note: "가".repeat(501) })).status).toBe(400);
    expect((await post(resumeId, { mode: "single", templateId: "nope" })).status).toBe(400);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
  });

  it("남의 이력서를 대상으로 한 작업은 만들 수 없다(서비스 직접 호출도 잠금 안에서 404)", async () => {
    const meta = (await service.getResumeMeta("ub", otherResumeId))!;
    const input = regenerate.regenerateInputFor(meta, { note: "" }, "single");
    await expect(
      draftJobs.startResumeDraftJob({ id: "ua", name: null }, input, { regenerate: { resumeId: otherResumeId, label: "x" } }),
    ).rejects.toMatchObject({ status: 404 });
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
  });
});

describe("빠른 초안으로 다시 생성", () => {
  it("새 이력서가 아니라 이 이력서의 새 버전으로 저장하고 사용자 칸·사진 설정을 지키며, 양식·JD 변경을 반영한다", async () => {
    // 저장하지 않은 작업본(임시 저장본)도 있다 — 다시 생성은 지우지 않는다.
    const v1 = (await versionsOf(resumeId))[0]!;
    await tdb.prisma.resumeEditDraft.create({ data: { resumeId, userId: "ua", baseVersionId: v1.id, document: userDocument() as never } });

    const res = await post(resumeId, { mode: "single", templateId: "classic", jdText: "Go 서버 개발 경험", note: "Kafka 경험을 앞에" });
    expect(res.status).toBe(202);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const json = (await res.json()) as { mode: string; jobId: string; href: string; draftJob: { label: string; regenerate?: boolean } };
    expect(json).toMatchObject({ mode: "single", href: `/app/resumes/drafts/${json.jobId}` });
    expect(json.draftJob).toMatchObject({ label: "다시 생성 · 토스 백엔드", regenerate: true });
    await runAfter();

    const job = (await draftJobs.getDraftJob("ua", json.jobId))!;
    expect(job).toMatchObject({ status: "completed", resumeId, regenerate: true, targetResumeId: resumeId });
    expect(await tdb.prisma.companyResume.count({ where: { userId: "ua" } })).toBe(1);
    const versions = await versionsOf(resumeId);
    expect(versions.map((v) => [v.versionNo, v.source, v.note])).toEqual([
      [1, "manual", null],
      [2, "ai", "AI 다시 생성 (빠른 초안)"],
    ]);
    const cur = await currentDoc(resumeId);
    expect(cur.version.id).toBe(versions[1]!.id);
    expect(cur.document.motivation).toBe("토스의 결제 문제를 풀고 싶어 지원합니다.");
    expect(cur.document.basics).toMatchObject({
      name: "홍길동(직접)",
      email: "me@custom.dev",
      phone: "010-1234-5678",
      portfolioUrl: "https://me.dev",
      links: [{ label: "GitHub", url: "https://github.com/me" }],
    });
    expect(cur.resume).toMatchObject({ includePhoto: false, templateId: "classic", jdText: "Go 서버 개발 경험" });
    // 작업본은 남는다(편집 화면이 기준 버전 변경을 충돌로 알린다).
    expect(await tdb.prisma.resumeEditDraft.count({ where: { resumeId } })).toBe(1);
    // 강조할 점은 프롬프트에 데이터로 들어갔다.
    expect(state.prompts.find((p) => p.task === "resume-draft")?.user).toContain("사용자가 강조해 달라는 점: Kafka 경험을 앞에");
    // 완료 알림은 이력서(?regenerated=1)로 연결한다.
    const n = await tdb.prisma.notification.findFirst({ where: { userId: "ua", kind: "resume-draft-completed" } });
    expect(n?.link).toBe(`/app/resumes/${resumeId}?regenerated=1`);
  });

  it("현재 값이 비어 있으면 생성된 값을 쓴다(메일은 로그인 메일 기본값)", async () => {
    const doc = userDocument();
    doc.basics.email = "";
    doc.basics.links = [];
    await service.saveVersion("ua", resumeId, doc, { source: "manual" });
    await post(resumeId, { mode: "single" });
    await runAfter();
    const cur = await currentDoc(resumeId);
    expect(cur.version.note).toBe("AI 다시 생성 (빠른 초안)");
    expect(cur.document.basics.email).toBe("ua@x.com");
    expect(cur.document.basics.phone).toBe("010-1234-5678");
  });

  it("같은 이력서를 다시 생성 중이면 두 번째 요청은 409(code regenerating, 진행 화면 경로), 다른 사용자의 같은 id 시도와 섞이지 않는다", async () => {
    const first = await post(resumeId, { mode: "single" });
    expect(first.status).toBe(202);
    const { jobId } = (await first.json()) as { jobId: string };
    const again = await post(resumeId, { mode: "single" });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "regenerating", jobHref: `/app/resumes/drafts/${jobId}` });
    // 에이전트로 요청해도 같은 이력서면 409.
    expect((await post(resumeId, { mode: "agent" })).status).toBe(409);
    // 다른 사용자는 자기 이력서를 다시 생성할 수 있다.
    state.user = { id: "ub", email: "ub@x.com", name: null };
    expect((await post(otherResumeId, { mode: "single" })).status).toBe(202);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(2);
  });

  it("동시에 두 요청이 와도 하나만 시작한다", async () => {
    const [a, b] = await Promise.all([post(resumeId, { mode: "single" }), post(resumeId, { mode: "single" })]);
    expect([a.status, b.status].sort()).toEqual([202, 409]);
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(1);
  });

  it("동시 초안 작업 상한(3개)은 새로 만들기와 함께 센다", async () => {
    for (let i = 0; i < draftJobs.MAX_ACTIVE_DRAFT_JOBS; i++) {
      await tdb.prisma.resumeDraftJob.create({ data: { id: `j${i}`, userId: "ua", runId: `r${i}`, status: "running", label: "x", input: {} } });
    }
    const res = await post(resumeId, { mode: "single" });
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toMatch(/동시에/);
  });

  it("하루 한도는 새로 만들기와 같은 초안 한도를 쓴다(30회 다음은 429)", async () => {
    const { RESUME_DRAFT_LIMIT } = await import("@/lib/auth/db-rate-limit");
    for (let i = 0; i < RESUME_DRAFT_LIMIT.limit; i++) await tdb.prisma.rateEvent.create({ data: { bucket: RESUME_DRAFT_LIMIT.bucket, key: "ua" } });
    const res = await post(resumeId, { mode: "single" });
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBeTruthy();
    expect(await tdb.prisma.resumeDraftJob.count()).toBe(0);
  });

  it("다시 생성 중인 작업은 이력서 수 상한에 세지 않는다(새 이력서를 만들지 않으므로)", async () => {
    await post(resumeId, { mode: "single" });
    const { MAX_RESUMES_PER_USER } = await import("./types");
    for (let i = 0; i < MAX_RESUMES_PER_USER - 2; i++) {
      await tdb.prisma.companyResume.create({ data: { id: `cr${i}`, userId: "ua", company: "c", roleTitle: "r", templateId: "developer", title: "t" } });
    }
    // 이력서 99개 + 다시 생성 1개: 새 이력서 하나는 더 만들 수 있다.
    await expect(draftJobs.assertResumeSlots("ua")).resolves.toBe(1);
  });

  it("실행 중에 이력서를 지우면 작업은 실패로 닫히고 새 이력서를 만들지 않는다", async () => {
    const res = await post(resumeId, { mode: "single" });
    const { jobId } = (await res.json()) as { jobId: string };
    await service.deleteResume("ua", resumeId);
    await runAfter();
    const job = (await draftJobs.getDraftJob("ua", jobId))!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe(regenerate.REGENERATE_TARGET_GONE);
    expect(await tdb.prisma.companyResume.count({ where: { userId: "ua" } })).toBe(0);
    expect(state.prompts).toHaveLength(0);
    const n = await tdb.prisma.notification.findFirst({ where: { userId: "ua", kind: "resume-draft-failed" } });
    expect(n?.title).toBe("이력서를 다시 생성하지 못했습니다");
  });

  it("저장 직후 실행이 버려지면(멈춤 판정) 저장한 버전을 지운다", async () => {
    const res = await post(resumeId, { mode: "single" });
    const { jobId } = (await res.json()) as { jobId: string };
    const job = await tdb.prisma.resumeDraftJob.findUniqueOrThrow({ where: { id: jobId } });
    state.afterTasks = [];
    await draftJobs.runResumeDraftJob("ua", jobId, job.runId, "anthropic", {
      onSaved: async () => {
        await tdb.prisma.resumeDraftJob.update({ where: { id: jobId }, data: { status: "failed", error: "끊김" } });
      },
    });
    expect((await versionsOf(resumeId)).map((v) => v.versionNo)).toEqual([1]);
    expect((await currentDoc(resumeId)).version.versionNo).toBe(1);
  });

  it("저장 뒤 완료 기록 전에 끊긴 시도가 남긴 버전은 다시 시도가 지운다(버전이 둘 생기지 않는다)", async () => {
    const res = await post(resumeId, { mode: "single" });
    const { jobId } = (await res.json()) as { jobId: string };
    state.afterTasks = [];
    // 끊긴 시도 흉내: 버전을 저장하고 작업에 pendingVersionId를 적은 채 'failed'(멈춤 판정)로 닫혔다.
    const orphanId = service.newVersionId();
    await regenerate.saveRegeneratedVersion("ua", resumeId, userDocument(), { mode: "single", versionId: orphanId, templateId: "developer" });
    await tdb.prisma.resumeDraftJob.update({ where: { id: jobId }, data: { status: "failed", error: "끊김", result: { pendingVersionId: orphanId } } });
    expect((await versionsOf(resumeId)).length).toBe(2);

    const retry = await draftRetryRoute.POST(new Request(`http://localhost/api/resumes/drafts/${jobId}/retry`, { method: "POST" }), ctx(jobId));
    expect(retry.status).toBe(202);
    await runAfter();
    const versions = await versionsOf(resumeId);
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(versions.some((v) => v.id === orphanId)).toBe(false);
    expect((await currentDoc(resumeId)).version.id).toBe(versions[1]!.id);
    expect((await draftJobs.getDraftJob("ua", jobId))!.status).toBe("completed");
  });

  it("남의 다시 생성 작업은 조회·다시 시도할 수 없다", async () => {
    const res = await post(resumeId, { mode: "single" });
    const { jobId } = (await res.json()) as { jobId: string };
    expect(await draftJobs.getDraftJob("ub", jobId)).toBeNull();
    state.user = { id: "ub", email: "ub@x.com", name: null };
    const retry = await draftRetryRoute.POST(new Request(`http://localhost/x`, { method: "POST" }), ctx(jobId));
    expect(retry.status).toBe(404);
  });
});

describe("AI 에이전트로 다시 생성", () => {
  it("기본(mode 생략)은 에이전트: 끝나면 이 이력서의 새 버전 + 새 리포트, 사용자 칸 보존, 이전 리포트는 기록으로 남는다", async () => {
    const res = await post(resumeId, { note: "결제 경험 강조" });
    expect(res.status).toBe(202);
    const json = (await res.json()) as { mode: string; jobId: string; href: string };
    expect(json).toMatchObject({ mode: "agent", href: `/app/resumes/agent/${json.jobId}` });
    await runAfter();

    const job = (await agentJobs.getAgentJob("ua", json.jobId))!;
    expect(job).toMatchObject({ status: "completed", resumeId, regenerate: true, targetResumeId: resumeId });
    expect(await tdb.prisma.companyResume.count({ where: { userId: "ua" } })).toBe(1);
    const versions = await versionsOf(resumeId);
    expect(versions.map((v) => [v.versionNo, v.source, v.note])).toEqual([
      [1, "manual", null],
      [2, "ai", "AI 다시 생성 (에이전트)"],
    ]);
    const cur = await currentDoc(resumeId);
    expect(cur.document.motivation).toBe("토스의 결제 문제를 풀고 싶어 지원합니다.");
    expect(cur.document.basics).toMatchObject({ email: "me@custom.dev", phone: "010-1234-5678", links: [{ label: "GitHub", url: "https://github.com/me" }] });
    expect(cur.resume.includePhoto).toBe(false);
    expect(state.prompts.some((p) => p.user.includes("사용자가 강조해 달라는 점: 결제 경험 강조"))).toBe(true);
    const n = await tdb.prisma.notification.findFirst({ where: { userId: "ua", kind: "resume-agent-completed" } });
    expect(n?.link).toBe(`/app/resumes/${resumeId}?report=1&regenerated=1`);

    const first = (await agentJobs.getAgentReportForResume("ua", resumeId))!;
    expect(first.jobId).toBe(json.jobId);
    // 한 번 더 다시 생성: 최신 리포트가 보이고, 이전 리포트는 jobId로 열 수 있다.
    await tdb.prisma.resumeAgentJob.update({ where: { id: json.jobId }, data: { completedAt: new Date(Date.now() - 60_000) } });
    const res2 = await post(resumeId, { mode: "agent" });
    const { jobId: second } = (await res2.json()) as { jobId: string };
    await runAfter();
    const latest = (await agentJobs.getAgentReportForResume("ua", resumeId))!;
    expect(latest.jobId).toBe(second);
    expect(latest.history.map((h) => h.jobId)).toEqual([second, json.jobId]);
    expect((await agentJobs.getAgentReportForResume("ua", resumeId, json.jobId))!.jobId).toBe(json.jobId);
    // 남의 리포트는 보이지 않는다.
    expect(await agentJobs.getAgentReportForResume("ub", resumeId)).toBeNull();
    expect((await versionsOf(resumeId)).length).toBe(3);
  });

  it("finalize가 버전을 저장한 뒤 끊겼으면 다음 시도가 그 버전을 지우고 하나만 남긴다", async () => {
    const res = await post(resumeId, { mode: "agent" });
    const { jobId } = (await res.json()) as { jobId: string };
    state.afterTasks = [];
    // finalize 직전까지 진행한다(저장된 단계 행으로 다음 단계를 계산한다 — jobs.ts와 같은 규칙).
    // 작업의 단계 계획 버전(v1 전체 작성 / v2 구역별 에이전트)을 따른다.
    const { evaluateAny, pipelineOf } = await import("@/lib/resume-agent/pipeline");
    const { agentSettings } = await import("@/lib/resume-agent/config");
    const settings = agentSettings();
    const version = pipelineOf((await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id: jobId } })).pipelineVersion);
    for (let i = 0; i < 40; i++) {
      const rows = await tdb.prisma.resumeAgentStep.findMany({ where: { jobId } });
      const next = evaluateAny(rows, { version, settings, company: true }).next[0];
      if (!next || next.kind === "finalize") break;
      await agentJobs.advanceAgentJob(jobId, { deps: { maxStepsPerCall: 1, chain: async () => ({ ok: true as const }) } });
    }
    const row = await tdb.prisma.resumeAgentJob.findUniqueOrThrow({ where: { id: jobId } });
    expect(row.status).not.toBe("completed");
    // 끊긴 finalize 흉내: 버전을 저장하고 단계 행에 pendingVersionId를 적은 채 'running'으로 남았다.
    const orphanId = service.newVersionId();
    await regenerate.saveRegeneratedVersion("ua", resumeId, userDocument(), { mode: "agent", versionId: orphanId, templateId: "developer" });
    await tdb.prisma.resumeAgentStep.upsert({
      where: { jobId_key: { jobId, key: "finalize" } },
      create: { id: "fin1", jobId, key: "finalize", kind: "finalize", round: 0, status: "running", attempt: 1, output: { pendingVersionId: orphanId } },
      update: { status: "running", attempt: 1, output: { pendingVersionId: orphanId } },
    });
    await tdb.prisma.resumeAgentJob.update({ where: { id: jobId }, data: { status: "waiting", leaseId: null, leaseExpiresAt: null, currentStep: "finalize" } });

    await agentJobs.advanceAgentJob(jobId, { deps: { chain: async () => ({ ok: true as const }) } });
    expect((await agentJobs.getAgentJob("ua", jobId))!.status).toBe("completed");
    const versions = await versionsOf(resumeId);
    expect(versions.map((v) => v.versionNo)).toEqual([1, 2]);
    expect(versions.some((v) => v.id === orphanId)).toBe(false);
    expect(versions[1]!.note).toBe("AI 다시 생성 (에이전트)");
  });

  it("finalize 저장 뒤 완료 기록 전에 실패하면(같은 호출) 버전을 지우고 다시 시도해 하나만 남긴다", async () => {
    const res = await post(resumeId, { mode: "agent" });
    const { jobId } = (await res.json()) as { jobId: string };
    state.afterTasks = [];
    let thrown = false;
    await agentJobs.advanceAgentJob(jobId, {
      deps: {
        chain: async () => ({ ok: true as const }),
        onResumeCreated: async () => {
          if (!thrown) {
            thrown = true;
            throw new Error("완료 기록 전 오류");
          }
        },
      },
    });
    expect(thrown).toBe(true);
    expect((await agentJobs.getAgentJob("ua", jobId))!.status).toBe("completed");
    expect((await versionsOf(resumeId)).map((v) => v.versionNo)).toEqual([1, 2]);
  });

  it("실행 중에 이력서를 지우면 작업은 실패로 닫히고 새 이력서를 만들지 않는다", async () => {
    const res = await post(resumeId, { mode: "agent" });
    const { jobId } = (await res.json()) as { jobId: string };
    await service.deleteResume("ua", resumeId);
    await runAfter();
    const job = (await agentJobs.getAgentJob("ua", jobId))!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe(regenerate.REGENERATE_TARGET_GONE);
    expect(job.resumeId).toBeNull();
    expect(await tdb.prisma.companyResume.count({ where: { userId: "ua" } })).toBe(0);
  });

  it("finalize 도중 이력서가 지워져도 새 이력서를 만들지 않고 실패한다", async () => {
    const res = await post(resumeId, { mode: "agent" });
    const { jobId } = (await res.json()) as { jobId: string };
    state.afterTasks = [];
    await agentJobs.advanceAgentJob(jobId, {
      deps: {
        chain: async () => ({ ok: true as const }),
        onStepStart: async (key) => {
          if (key === "finalize") await service.deleteResume("ua", resumeId);
        },
      },
    });
    const job = (await agentJobs.getAgentJob("ua", jobId))!;
    expect(job.status).toBe("failed");
    expect(job.error).toBe(regenerate.REGENERATE_TARGET_GONE);
    expect(await tdb.prisma.companyResume.count({ where: { userId: "ua" } })).toBe(0);
    expect(await tdb.prisma.resumeVersion.count({ where: { resume: { userId: "ua" } } })).toBe(0);
  });

  it("에이전트 다시 생성은 하루 한도가 없다(예전 한도 기록이 남아 있어도 시작한다)", async () => {
    for (let i = 0; i < 10; i++) await tdb.prisma.rateEvent.create({ data: { bucket: "resume-agent", key: "ua" } });
    const res = await post(resumeId, { mode: "agent" });
    expect(res.status).toBe(202);
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(1);
  });

  it("다른 에이전트 작업이 상한(동시 3개 — 새로 만들기와 함께 센다)만큼 진행 중이면 409, 그보다 적으면 시작한다", async () => {
    const { MAX_ACTIVE_AGENT_JOBS } = agentJobs;
    for (let i = 0; i < MAX_ACTIVE_AGENT_JOBS - 1; i++) {
      await tdb.prisma.resumeAgentJob.create({ data: { id: `other${i}`, userId: "ua", runId: "r", status: "waiting", label: "x", input: {}, createdAt: new Date(Date.now() - (i + 1) * 1000) } });
    }
    const ok = await post(resumeId, { mode: "agent" });
    expect(ok.status).toBe(202);
    await tdb.prisma.resumeAgentJob.updateMany({ where: { targetResumeId: resumeId }, data: { status: "canceled" } });
    await tdb.prisma.resumeAgentJob.create({ data: { id: "newest", userId: "ua", runId: "r", status: "running", label: "x", input: {}, createdAt: new Date(Date.now() + 60_000) } });
    const res = await post(resumeId, { mode: "agent" });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: "busy", agentJobId: "newest" });
  });

  it("에이전트를 쓸 수 없으면(그래프 비어 있음) 빠른 초안으로 다시 생성하고 modeFallback을 알린다", async () => {
    state.graphs.set("ua", { person: { id: "me", name: null }, nodes: [], edges: [] });
    const res = await post(resumeId, { mode: "agent" });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ mode: "single", modeFallback: "agent_unavailable" });
    expect(await tdb.prisma.resumeAgentJob.count()).toBe(0);
    expect(await tdb.prisma.resumeDraftJob.count({ where: { targetResumeId: resumeId } })).toBe(1);
  });

  it("에이전트 작업을 빠른 초안으로 넘겨도 같은 이력서의 새 버전으로 저장한다", async () => {
    const res = await post(resumeId, { mode: "agent" });
    const { jobId } = (await res.json()) as { jobId: string };
    state.afterTasks = [];
    await tdb.prisma.resumeAgentJob.update({ where: { id: jobId }, data: { status: "failed", error: "x" } });
    const retryRoute = await import("@/app/api/resumes/agent-jobs/[id]/retry/route");
    const fb = await retryRoute.POST(new Request(`http://localhost/x?mode=single`, { method: "POST" }), ctx(jobId));
    expect(fb.status).toBe(202);
    await runAfter();
    expect(await tdb.prisma.companyResume.count({ where: { userId: "ua" } })).toBe(1);
    const versions = await versionsOf(resumeId);
    expect(versions.map((v) => v.note)).toEqual([null, "AI 다시 생성 (빠른 초안)"]);
  });
});

describe("preserveUserFields", () => {
  it("지원 동기는 언제나 현재 값, 연락처·링크는 현재 값이 있을 때만", () => {
    const gen = domain.emptyResumeDocument();
    gen.basics.email = "gen@x.com";
    gen.basics.phone = "[ADD: 전화]";
    gen.basics.links = [{ label: "Blog", url: "https://b" }];
    const cur = domain.emptyResumeDocument();
    cur.basics.phone = "010";
    cur.motivation = "동기";
    const out = regenerate.preserveUserFields(gen, cur);
    expect(out.motivation).toBe("동기");
    expect(out.basics).toMatchObject({ email: "gen@x.com", phone: "010", links: [{ label: "Blog", url: "https://b" }] });
    expect(regenerate.preserveUserFields(gen, null)).toBe(gen);
  });
});

describe("다시 생성 — JD 반영·기준 버전", () => {
  it("JD를 고치지 않았으면(같은 값 포함) 이력서 JD 칸을 건드리지 않는다 — 에이전트가 잘라 둔 긴 JD로 바뀌지 않게", async () => {
    const longJd = `${AGENT_JD}\n${"자격 요건 ".repeat(2_500)}`.slice(0, 20_000);
    await tdb.prisma.companyResume.update({ where: { id: resumeId }, data: { jdText: longJd } });
    const meta = (await service.getResumeMeta("ua", resumeId))!;
    expect(regenerate.regenerateInputFor(meta, { note: "" }, "agent").replaceJd).toBeUndefined();
    expect(regenerate.regenerateInputFor(meta, { note: "", jdText: longJd }, "agent").replaceJd).toBeUndefined();
    expect(regenerate.regenerateInputFor(meta, { note: "", jdText: "새 JD" }, "agent").replaceJd).toBe(true);
    // 에이전트 저장 입력처럼 잘린 JD로 완료해도 그대로다.
    await regenerate.applyRegeneratedMeta("ua", resumeId, { kind: "company", jdText: longJd.slice(0, agentJobs.AGENT_JD_MAX_CHARS) });
    expect((await service.getResumeMeta("ua", resumeId))!.jdText).toBe(longJd);
    await regenerate.applyRegeneratedMeta("ua", resumeId, { kind: "company", jdText: "새 JD", replaceJd: true });
    expect((await service.getResumeMeta("ua", resumeId))!.jdText).toBe("새 JD");
    // 남의 이력서에는 쓰지 않는다.
    await regenerate.applyRegeneratedMeta("ua", otherResumeId, { kind: "company", jdText: "x", replaceJd: true });
    expect((await service.getResumeMeta("ub", otherResumeId))!.jdText).toBe(AGENT_JD);
  });

  it("저장 중 다른 저장이 끼어들면(기준 버전 충돌) 다시 읽어 저장하고, 버전은 하나만 생긴다", async () => {
    // 다른 저장이 v2 번호를 예약한 채 아직 현재 버전이 되지 않은 상태 — 기준 버전 저장은 409가 된다.
    await tdb.prisma.resumeVersion.create({ data: { id: "inflight", resumeId, versionNo: 2, storageKey: `x/${resumeId}/2`, source: "manual" } });
    const versionId = service.newVersionId();
    const v = await regenerate.saveRegeneratedVersion("ua", resumeId, domain.emptyResumeDocument(), { mode: "single", versionId, templateId: "developer" });
    expect(v).toMatchObject({ id: versionId, versionNo: 3 });
    expect((await versionsOf(resumeId)).filter((x) => x.note === "AI 다시 생성 (빠른 초안)")).toHaveLength(1);
    const cur = await currentDoc(resumeId);
    expect(cur.version.id).toBe(versionId);
    expect(cur.document.motivation).toBe("토스의 결제 문제를 풀고 싶어 지원합니다.");
  });
});
