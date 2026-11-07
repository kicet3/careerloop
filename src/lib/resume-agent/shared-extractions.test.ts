/**
 * 공유 추출(동작 불변 리팩터) 고정: 9378ba3 기준으로 계산한 프롬프트 해시와 비교한다.
 * - 패널 단계 프롬프트(진단 경로, draftMode 없음)는 바이트 단위로 같다. draftMode면 심사 단계 할 일 끝에만 안내가 붙는다.
 * - 단일 초안 프롬프트는 사실 규칙(RESUME_FACT_RULES)을 공유 모듈로 뺀 뒤에도 같다(INJECTION_RULE에 새 자료 태그 이름 두 개가 더해진 것만 다르다).
 * - runPanelStage는 usageTask·effort·cacheUser를 요청에 싣는다.
 * - retrieve의 intents 인자는 의도를 더하고, buildIndex를 넘겨도 결과가 같다.
 */
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { STAGE_KEYS, STAGE_SCHEMAS } from "@/lib/domain/schemas";
import { buildStagePrompt, DRAFT_MODE_NOTE, type PanelInput } from "@/lib/panel/prompts";
import { runPanelStage } from "@/lib/panel/pipeline";
import { buildIndex, retrieve } from "@/lib/graph/retrieve";
import { RESUME_FACT_RULES } from "@/lib/resumes/draft-rules";
import type { LlmClient, LlmRequest } from "@/lib/llm/types";
import { FakeLlmClient } from "@/test/fake-llm";
import { qaGraph } from "@/lib/graph/__fixtures__/qa-graph";

const QA_GRAPH = qaGraph();

vi.mock("server-only", () => ({}));
const { buildResumeDraftPrompt } = await import("@/lib/resumes/draft");

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const input = { resumeText: "홍길동\n- Kafka 운영 3년\n- 주문 시스템 개편", resumeFileName: null, targetRole: "백엔드", jdText: "Kafka 경험", situation: "general" as const, notes: "지원 회사: 토스" };

async function allPrompts(inp: PanelInput) {
  const llm = new FakeLlmClient();
  const outputs: Record<string, unknown> = {};
  for (const s of STAGE_KEYS) {
    const p = buildStagePrompt(s, inp, outputs as never);
    outputs[s] = (await llm.generate({ stage: s, schema: STAGE_SCHEMAS[s] as never, ...p })).output;
  }
  return STAGE_KEYS.map((s) => [s, buildStagePrompt(s, inp, outputs as never)] as const);
}

describe("패널 프롬프트(진단 경로) 불변", () => {
  it("draftMode 없음 → 9378ba3과 같은 해시", async () => {
    const prompts = await allPrompts(input);
    expect(sha(prompts.map(([, p]) => JSON.stringify(p)).join("|"))).toBe("c6bedc448aab5b3a241736f473ea8e2b430b1fd46cc350a6ab9d05c5836fbdf8");
  });

  it("draftMode면 심사 단계(ats·gatekeeper·리더·fit)만 끝에 안내가 붙고 jd·종합 등은 그대로", async () => {
    const plain = new Map(await allPrompts(input));
    const draft = new Map(await allPrompts({ ...input, draftMode: true }));
    for (const s of ["ats", "gatekeeper", "manager", "rival", "ceo", "recruiter", "teammate", "fit"] as const) {
      expect(draft.get(s)!.user).toBe(plain.get(s)!.user + DRAFT_MODE_NOTE);
    }
    expect(draft.get("jd")).toEqual(plain.get("jd"));
  });
});

describe("단일 초안 프롬프트 불변", () => {
  it("사실 규칙 추출 뒤에도 같다(새 자료 태그 이름 두 개만 INJECTION_RULE에 더해짐)", () => {
    const d = buildResumeDraftPrompt({ company: "c", roleTitle: "r", jdText: "j", templateId: "performance", material: { kind: "graph", text: "g" } });
    const before = d.system.replace(", <resume_plan>, <requirement_candidates>", "");
    expect(sha(before + d.user)).toBe("016b7fbe3fb98a3c373864891ce09745ed63c9013be0349289fa2e1f3cc22764");
    const rules = d.system.slice(d.system.indexOf("규칙:"), d.system.indexOf("10. 아래 작성 기준"));
    expect(rules).toBe(["규칙:", ...RESUME_FACT_RULES, ""].join("\n"));
  });
});

describe("runPanelStage", () => {
  it("usageTask·effort·cacheUser를 요청에 싣고 fit 점수는 코드로 다시 계산한다", async () => {
    const seen: LlmRequest<unknown>[] = [];
    const fake = new FakeLlmClient();
    const llm: LlmClient = { name: "spy", generate: async (req) => (seen.push(req as LlmRequest<unknown>), fake.generate(req)) };
    const jd = (await runPanelStage("jd", input, {}, llm, { usageTask: "resume-agent-jd" })).output;
    const fit = await runPanelStage("fit", { ...input, draftMode: true }, { jd }, llm, { usageTask: "resume-agent-review", effort: "low", cacheUser: false });
    expect(seen[1]).toMatchObject({ stage: "fit", usageTask: "resume-agent-review", effort: "low", cacheUser: false });
    expect(seen[0]).not.toHaveProperty("cacheUser");
    expect(fit.output.matchScore).toBeGreaterThanOrEqual(0);
  });
});

describe("retrieve: intents·buildIndex", () => {
  it("색인을 넘겨도 결과가 같고, intents는 질의 의도에 더해진다", () => {
    const q = "Kafka 운영 경험";
    const a = retrieve(QA_GRAPH, q, { nowYear: 2026 });
    const b = retrieve(QA_GRAPH, q, { nowYear: 2026, index: buildIndex(QA_GRAPH) });
    expect(b.candidates.map((c) => [c.node.id, c.signals])).toEqual(a.candidates.map((c) => [c.node.id, c.signals]));
    const c = retrieve(QA_GRAPH, q, { nowYear: 2026, intents: ["project", "achievement"] });
    expect(c.query.intents).toEqual(expect.arrayContaining(["project", "achievement"]));
    expect(a.query.intents).not.toContain("achievement");
  });
});
