import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { Diagnosis } from "@/lib/db/types";
import type { DiagnosisInput, StageKey } from "@/lib/domain/schemas";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";
import { LlmPermanentError, type GenerateRequest, type GenerateResult, type LlmClient } from "@/lib/llm/types";

vi.mock("server-only", () => ({}));

process.env.DAILY_DIAGNOSIS_LIMIT = "50";

let tdb: TestDb;
let runDiagnosis: typeof import("./runner").runDiagnosis;
let createDiagnosis: typeof import("@/lib/diagnoses/service").createDiagnosis;

const input: DiagnosisInput = {
  resumeText: "홍길동\nhong@example.com\n경력\n- 백엔드 개발자, 페이랩 (2021.01 ~ 2024.06)\n- 결제 API를 Kotlin과 Spring Boot로 개발\n- 정산 배치 처리 시간을 3시간에서 40분으로 단축",
  resumeFileName: null,
  targetRole: "백엔드 개발자",
  jdText: "필수: Kotlin 3년 이상, Spring Boot\n우대: Kafka",
  situation: "general",
  notes: null,
};

/** 가짜 LLM(FakeLlmClient) 출력을 쓰되 단계별로 실패·대기를 끼워 넣는 클라이언트. */
class ScriptedLlm implements LlmClient {
  readonly name = "scripted";
  readonly calls: StageKey[] = [];
  private readonly inner = new FakeLlmClient({ delayMs: 0 });
  constructor(private readonly script: Partial<Record<StageKey, (req: GenerateRequest<unknown>) => Promise<void>>> = {}) {}
  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push(req.stage);
    await this.script[req.stage]?.(req as GenerateRequest<unknown>);
    return this.inner.generate(req);
  }
}

async function load(id: string) {
  const d = (await tdb.prisma.diagnosis.findUnique({ where: { id } })) as Diagnosis | null;
  const stages = await tdb.prisma.diagnosisStage.findMany({ where: { diagnosisId: id } });
  return { d: d!, stage: (k: StageKey) => stages.find((s) => s.stage === k)! };
}

beforeAll(async () => {
  tdb = await createTestDb();
  ({ runDiagnosis } = await import("./runner"));
  ({ createDiagnosis } = await import("@/lib/diagnoses/service"));
  for (const id of ["r1", "r2", "r3", "r4", "r5", "r6"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
});

afterAll(() => tdb.close());

describe("runDiagnosis", () => {
  it("끝까지 실행하면 done, fit 점수는 매트릭스와 일치", async () => {
    const { id } = await createDiagnosis("r1", input);
    await runDiagnosis(id, { llm: new ScriptedLlm() });
    const { d } = await load(id);
    expect(d.status).toBe("done");
    expect(d.runId).toBeTruthy();
    // 끝나면 진단 화면으로 가는 완료 알림을 남긴다.
    const notes = await tdb.prisma.notification.findMany({ where: { userId: "r1" } });
    expect(notes).toEqual([expect.objectContaining({ kind: "diagnosis-completed", link: `/app/d/${id}` })]);
  });

  it("실패한 단계가 쓴 토큰도 사용량에 더한다", async () => {
    const { id } = await createDiagnosis("r2", input);
    const llm = new ScriptedLlm({
      rewrite: async () => {
        throw new LlmPermanentError("cut", "max_tokens", {
          inputTokens: 0,
          outputTokens: 50_000,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        });
      },
    });
    await runDiagnosis(id, { llm });
    const { d, stage } = await load(id);
    expect(d.status).toBe("failed");
    expect(stage("rewrite").error).toContain("출력 길이 한도");
    expect(d.usage!.outputTokens).toBeGreaterThanOrEqual(50_000);
    expect(await tdb.prisma.notification.findMany({ where: { userId: "r2" } })).toEqual([expect.objectContaining({ kind: "diagnosis-failed" })]);
  });

  it("멈춤 판정 뒤 다른 실행이 차지하면, 예전 실행은 LLM 호출을 멈추고 아무 행도 덮어쓰지 않는다", async () => {
    const { id } = await createDiagnosis("r3", input);
    let release!: () => void;
    let reached!: () => void;
    const atSynthesis = new Promise<void>((r) => (reached = r));
    const gate = new Promise<void>((r) => (release = r));
    const llm = new ScriptedLlm({
      synthesis: async () => {
        reached();
        await gate;
      },
    });
    const run = runDiagnosis(id, { llm, heartbeatMs: 10 });
    await atSynthesis;
    // markStaleRunsFailed → prepareRetry → 새 실행이 차지한 상황을 흉내 낸다.
    await tdb.prisma.diagnosis.update({ where: { id }, data: { status: "running", runId: "newer-run" } });
    await new Promise((r) => setTimeout(r, 40)); // 하트비트가 소유권 상실을 알아차릴 시간
    release();
    await run;

    const { d, stage } = await load(id);
    expect(d.status).toBe("running");
    expect(d.runId).toBe("newer-run");
    expect(stage("synthesis").status).toBe("running"); // 예전 실행의 done/failed 쓰기가 반영되지 않음
    expect(llm.calls).not.toContain("rewrite");
    expect(llm.calls).not.toContain("plan");
  });

  it("시간 예산을 넘기면 중단하고 실패(재시도 가능)로 기록한다", async () => {
    const { id } = await createDiagnosis("r4", input);
    const llm = new ScriptedLlm({ fit: (req) => new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(req.signal!.reason))) });
    await runDiagnosis(id, { llm, deadlineAt: Date.now() + 50 });
    const { d, stage } = await load(id);
    expect(d.status).toBe("failed");
    expect(d.error).toContain("시간 제한");
    expect(stage("fit").error).toContain("시간 제한");
    expect(llm.calls).not.toContain("synthesis");
    // 시간 예산으로 멈춘 것은 진행 화면이 이어서 실행하므로 알리지 않는다.
    expect(await tdb.prisma.notification.count({ where: { userId: "r4" } })).toBe(0);

    // 아무도 이어서 실행하지 않고 멈춘 채 남으면 알림 폴링(notifyIdleDeadlineStops)이 한 번 알린다.
    const { notifyIdleDeadlineStops } = await import("@/lib/diagnoses/service");
    expect(await notifyIdleDeadlineStops("r4")).toBe(0); // 막 멈춤 — 진행 화면이 이어서 실행할 시간
    await tdb.prisma.diagnosis.update({ where: { id }, data: { updatedAt: new Date(Date.now() - 3 * 60_000) } });
    expect(await notifyIdleDeadlineStops("r4")).toBe(1);
    expect(await notifyIdleDeadlineStops("r4")).toBe(0);
    expect(await tdb.prisma.notification.findMany({ where: { userId: "r4" } })).toEqual([
      expect.objectContaining({ kind: "diagnosis-failed", link: `/app/d/${id}` }),
    ]);
  });

  it("실행 중 치명적 오류로 끝나도 실패 알림을 남긴다", async () => {
    const { id } = await createDiagnosis("r5", input);
    const opts = {
      get llm(): LlmClient {
        throw new Error("boom");
      },
    };
    await runDiagnosis(id, opts);
    const { d } = await load(id);
    expect(d.status).toBe("failed");
    expect(await tdb.prisma.notification.findMany({ where: { userId: "r5" } })).toEqual([
      expect.objectContaining({ kind: "diagnosis-failed", link: `/app/d/${id}` }),
    ]);
  });

  it("하트비트가 끊겨 멈춤으로 닫힌 진단도 실패 알림을 한 번 남긴다", async () => {
    const { markStaleRunsFailed } = await import("@/lib/diagnoses/service");
    const { id } = await createDiagnosis("r6", input);
    await tdb.prisma.diagnosis.update({ where: { id }, data: { status: "running", updatedAt: new Date(Date.now() - 10 * 60_000) } });
    expect(await markStaleRunsFailed("r6")).toBe(1);
    expect(await markStaleRunsFailed("r6")).toBe(0);
    expect((await load(id)).d.status).toBe("failed");
    expect(await tdb.prisma.notification.count({ where: { userId: "r6", kind: "diagnosis-failed" } })).toBe(1);
  });
});
