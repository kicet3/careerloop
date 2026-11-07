/**
 * 단계 jd: 패널 JD 분석(buildJdPrompt)을 그대로 재사용한다. 이력서는 보지 않는다(resumeText ""). JD는 작업 시작 때 자른 값만.
 * 후처리: 요건별 검색 질의 묶음(requirementSignals).
 */
import { runPanelStage } from "@/lib/panel/pipeline";
import { requirementSignals } from "../requirement-signals";
import type { JdStepOutput } from "../schemas";
import { panelInputFor, UsageMeter, type StepContext, type StepResult } from "./shared";

export async function runJdStep(ctx: StepContext): Promise<StepResult<JdStepOutput>> {
  const meter = new UsageMeter();
  const jd = meter.take(
    await runPanelStage("jd", panelInputFor(ctx.job.input, "", "general"), {}, ctx.llm, { signal: ctx.signal, usageTask: "resume-agent-jd", cacheUser: false }),
  );
  const signals = requirementSignals(jd);
  const summary = [`필수 ${jd.mustHave.length} · 우대 ${jd.niceToHave.length} · 키워드 ${jd.keywords.length}`];
  if (jd.source === "inferred") summary.push("공고가 없어 직무명으로 요건을 추정했습니다");
  return { output: { jd, signals }, summary, usage: meter.usage, model: meter.model };
}
