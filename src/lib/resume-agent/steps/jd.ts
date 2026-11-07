/**
 * 단계 jd: 패널 JD 분석(buildJdPrompt)을 그대로 재사용한다. 이력서는 보지 않는다(resumeText ""). JD는 작업 시작 때 자른 값만.
 * 후처리: 요건별 검색 질의 묶음(requirementSignals).
 * v2(runJdStepV2): 먼저 "유저가 선택한 JD 분석"(같은 공고의 저장된 진단 분석 → 같은 이력서의 이전 작업 r0.jd, 같은 JD일 때만)을 다시 쓴다.
 */
import { runPanelStage } from "@/lib/panel/pipeline";
import { jdHash } from "../jd-hash";
import { requirementSignals } from "../requirement-signals";
import type { JdReuse, JdStepOutput } from "../schemas";
import { panelInputFor, UsageMeter, ZERO_USAGE, type StepContext, type StepResult } from "./shared";

export async function runJdStep(ctx: StepContext): Promise<StepResult<JdStepOutput>> {
  const meter = new UsageMeter();
  const jd = meter.take(
    await runPanelStage("jd", panelInputFor(ctx.job.input, "", "general"), {}, ctx.llm, { signal: ctx.signal, usageTask: "resume-agent-jd", cacheUser: false }),
  );
  const signals = requirementSignals(jd);
  const summary = [`필수 ${jd.mustHave.length} · 우대 ${jd.niceToHave.length} · 키워드 ${jd.keywords.length}`];
  if (jd.source === "inferred") summary.push("공고가 없어 직무명으로 요건을 추정했습니다");
  return { output: { jd, signals, reusedFrom: null, jdHash: null }, summary, usage: meter.usage, model: meter.model };
}

/** 저장된 JD 분석 찾기(jd-source.ts — 테스트는 가짜를 넘긴다). */
export type FindJd = (input: { userId: string; jdText: string; postingId?: string | null; resumeId?: string | null }) => Promise<{ jd: JdStepOutput["jd"]; reusedFrom: JdReuse } | null>;

const reuseLabel = (r: JdReuse): string => {
  const d = r.at ? new Date(r.at) : null;
  const date = d && !Number.isNaN(d.getTime()) ? ` ${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, "0")}.${String(d.getDate()).padStart(2, "0")}` : "";
  return r.kind === "diagnosis" ? `저장된 JD 분석을 사용했습니다(진단${date})` : `이 이력서의 이전 JD 분석을 사용했습니다(${date.trim() || "이전 작업"})`;
};

export async function runJdStepV2(ctx: StepContext, find: FindJd): Promise<StepResult<JdStepOutput>> {
  const input = ctx.job.input;
  const hash = jdHash(input.jdText);
  if (input.kind === "company" && input.jdText.trim()) {
    const reused = await find({ userId: ctx.job.userId, jdText: input.jdText, postingId: input.postingId ?? null, resumeId: ctx.targetResumeId ?? null }).catch(() => null);
    if (reused) {
      const signals = requirementSignals(reused.jd);
      const summary = [`필수 ${reused.jd.mustHave.length} · 우대 ${reused.jd.niceToHave.length} · 키워드 ${reused.jd.keywords.length}`, reuseLabel(reused.reusedFrom)];
      return { output: { jd: reused.jd, signals, reusedFrom: reused.reusedFrom, jdHash: hash }, summary, usage: ZERO_USAGE, model: null };
    }
  }
  const res = await runJdStep(ctx);
  return { ...res, output: { ...res.output, jdHash: hash } };
}
