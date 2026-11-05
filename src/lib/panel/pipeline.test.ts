import { describe, expect, it } from "vitest";
import { STAGE_DEPENDENCIES, STAGE_KEYS, type DiagnosisInput, type StageKey, type StageOutputs } from "@/lib/domain/schemas";
import { FakeLlmClient } from "@/test/fake-llm";
import type { GenerateRequest, GenerateResult, LlmClient } from "@/lib/llm/types";
import { scoreFit } from "./fit-score";
import { runPipeline } from "./pipeline";

const INPUT: DiagnosisInput = {
  resumeText: `김지원
jiwon@example.com · 010-1111-2222
경력
- 마케팅 매니저, 하나커머스 (2020.01 ~ 2024.06)
- 신규 고객 캠페인을 기획하고 운영함
- 월간 리포트를 Excel로 작성해 경영진에 보고
- 광고 예산 2억 원을 관리하며 ROAS 320% 달성
- 개발팀과 협업해 랜딩 페이지 A/B 테스트 진행`,
  resumeFileName: null,
  targetRole: "데이터 분석가",
  jdText: null,
  situation: "career_change",
  notes: null,
};

/** 가짜 LLM(FakeLlmClient) 출력을 쓰되 호출 순서·동시성을 기록하고, 지정한 단계는 실패시키는 가짜 클라이언트. */
class RecordingLlm implements LlmClient {
  readonly name = "recording";
  readonly log: string[] = [];
  readonly calls: StageKey[] = [];
  running = 0;
  maxRunning = 0;
  private readonly inner = new FakeLlmClient({ delayMs: 0 });

  constructor(private readonly opts: { fail?: StageKey[]; delay?: (s: StageKey) => number } = {}) {}

  async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
    this.calls.push(req.stage);
    this.log.push(`start:${req.stage}`);
    this.running++;
    this.maxRunning = Math.max(this.maxRunning, this.running);
    try {
      await new Promise((r) => setTimeout(r, this.opts.delay?.(req.stage) ?? 5));
      if (this.opts.fail?.includes(req.stage)) throw new Error(`boom:${req.stage}`);
      return await this.inner.generate(req);
    } finally {
      this.running--;
      this.log.push(`end:${req.stage}`);
    }
  }
}

function collect() {
  const started: StageKey[] = [];
  const done = new Map<StageKey, unknown>();
  const failed = new Map<StageKey, Error>();
  return {
    started,
    done,
    failed,
    callbacks: {
      onStageStart: async (s: StageKey) => void started.push(s),
      onStageDone: async <K extends StageKey>(s: K, out: StageOutputs[K]) => void done.set(s, out),
      onStageFailed: async (s: StageKey, e: Error) => void failed.set(s, e),
    },
  };
}

describe("runPipeline", () => {
  it("모든 단계를 의존 순서대로, 가능한 것은 동시에 실행한다", async () => {
    const llm = new RecordingLlm();
    const c = collect();
    const res = await runPipeline(INPUT, { llm, existing: {}, ...c.callbacks });

    expect(res.ok).toBe(true);
    expect(new Set(llm.calls)).toEqual(new Set(STAGE_KEYS));
    expect(llm.calls).toHaveLength(STAGE_KEYS.length);
    expect(c.done.size).toBe(STAGE_KEYS.length);
    expect(c.failed.size).toBe(0);

    // 각 단계는 의존 단계가 모두 끝난 뒤에 시작한다.
    for (const stage of STAGE_KEYS) {
      const startAt = llm.log.indexOf(`start:${stage}`);
      for (const dep of STAGE_DEPENDENCIES[stage]) expect(llm.log.indexOf(`end:${dep}`)).toBeLessThan(startAt);
    }
    // jd 다음 8개(리뷰어 7 + fit)는 동시에 돈다.
    expect(llm.maxRunning).toBeGreaterThanOrEqual(8);
  });

  it("plan은 rewrite를 기다리지 않고 synthesis·fit 직후 시작한다", async () => {
    const llm = new RecordingLlm({ delay: (s) => (s === "rewrite" ? 60 : 5) });
    const c = collect();
    await runPipeline(INPUT, { llm, existing: {}, ...c.callbacks });
    expect(llm.log.indexOf("start:plan")).toBeLessThan(llm.log.indexOf("end:rewrite"));
  });

  it("existing에 있는 단계는 건너뛰고 나머지만 실행한다", async () => {
    const first = new RecordingLlm();
    const c1 = collect();
    await runPipeline(INPUT, { llm: first, existing: {}, ...c1.callbacks });
    const existing = Object.fromEntries(
      [...c1.done].filter(([s]) => s !== "rewrite" && s !== "rescreen" && s !== "plan"),
    ) as Partial<StageOutputs>;

    const llm = new RecordingLlm();
    const c = collect();
    const res = await runPipeline(INPUT, { llm, existing, ...c.callbacks });
    expect(res.ok).toBe(true);
    expect(new Set(llm.calls)).toEqual(new Set(["rewrite", "plan", "rescreen"]));
    expect(new Set(c.started)).toEqual(new Set(["rewrite", "plan", "rescreen"]));
  });

  it("실패한 단계에 의존하는 단계는 실행하지 않는다", async () => {
    const llm = new RecordingLlm({ fail: ["manager"] });
    const c = collect();
    const res = await runPipeline(INPUT, { llm, existing: {}, ...c.callbacks });

    expect(res.ok).toBe(false);
    expect([...c.failed.keys()]).toEqual(["manager"]);
    expect(c.failed.get("manager")?.message).toBe("boom:manager");
    for (const s of ["synthesis", "rewrite", "plan", "rescreen"] as const) {
      expect(llm.calls).not.toContain(s);
      expect(c.started).not.toContain(s);
    }
    // 같은 층의 다른 단계는 끝까지 실행된다.
    for (const s of ["ats", "gatekeeper", "rival", "ceo", "recruiter", "teammate", "fit"] as const) {
      expect(c.done.has(s)).toBe(true);
    }
  });

  it("rewrite가 실패해도 plan은 실행되고 rescreen만 막힌다", async () => {
    const llm = new RecordingLlm({ fail: ["rewrite"] });
    const c = collect();
    const res = await runPipeline(INPUT, { llm, existing: {}, ...c.callbacks });
    expect(res.ok).toBe(false);
    expect(c.done.has("plan")).toBe(true);
    expect(llm.calls).not.toContain("rescreen");
  });

  it("jd가 실패하면 아무것도 더 실행하지 않는다", async () => {
    const llm = new RecordingLlm({ fail: ["jd"] });
    const c = collect();
    const res = await runPipeline(INPUT, { llm, existing: {}, ...c.callbacks });
    expect(res.ok).toBe(false);
    expect(llm.calls).toEqual(["jd"]);
  });

  it("onStageDone 콜백이 던지면 그 단계를 실패로 처리한다", async () => {
    const llm = new RecordingLlm();
    const c = collect();
    const res = await runPipeline(INPUT, {
      llm,
      existing: {},
      ...c.callbacks,
      onStageDone: async (s) => {
        if (s === "fit") throw new Error("db down");
        c.done.set(s, true);
      },
    });
    expect(res.ok).toBe(false);
    expect(c.failed.get("fit")?.message).toBe("db down");
    expect(llm.calls).not.toContain("synthesis");
  });

  it("fit의 matchScore는 모델 값 대신 매트릭스로 다시 계산해 저장하고 다음 단계에 넘긴다", async () => {
    class WrongScoreLlm extends RecordingLlm {
      async generate<T>(req: GenerateRequest<T>): Promise<GenerateResult<T>> {
        const r = await super.generate(req);
        if (req.stage === "fit") return { ...r, output: { ...(r.output as object), matchScore: 99 } as T };
        return r;
      }
    }
    const llm = new WrongScoreLlm();
    const c = collect();
    await runPipeline(INPUT, { llm, existing: {}, ...c.callbacks });
    const jd = c.done.get("jd") as StageOutputs["jd"];
    const fit = c.done.get("fit") as StageOutputs["fit"];
    expect(fit.matchScore).not.toBe(99);
    expect(fit.matchScore).toBe(scoreFit(jd, fit));
  });

  it("signal이 중단되면 남은 단계를 시작하지 않는다", async () => {
    const controller = new AbortController();
    const llm = new RecordingLlm();
    const c = collect();
    const res = await runPipeline(INPUT, {
      llm,
      existing: {},
      signal: controller.signal,
      ...c.callbacks,
      onStageDone: async (s, out) => {
        c.done.set(s, out);
        if (s === "jd") controller.abort();
      },
    });
    expect(res.ok).toBe(false);
    expect(llm.calls).toEqual(["jd"]);
  });
});
