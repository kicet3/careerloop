/**
 * 단계 retrieve(LLM 없음): 작업 행 userId의 그래프만 읽어(loadAgentGraph — getCareerGraph + assertGraphOwner) 근거 묶음을 만든다.
 * must 근거가 0개이고 프로젝트·직무·경험이 하나도 없으면 LLM 비용을 쓰기 전에 insufficient_graph로 멈춘다.
 * v2는 ctx.evidence(evidence-source.ts — 같은 loadAgentGraph 경로)로만 근거를 만든다.
 */
import { buildEvidencePack } from "../evidence";
import { parsedOutput } from "../next-step";
import type { RetrieveStepOutput } from "../schemas";
import { AgentStepError, ZERO_USAGE, type StepContext, type StepResult } from "./shared";

export const INSUFFICIENT_GRAPH_MESSAGE =
  "경험 그래프에 쓸 수 있는 경력·프로젝트가 거의 없어 에이전트가 쓸 내용이 적습니다. 그래프 채팅으로 경험을 먼저 정리하거나 빠른 초안으로 만들어 주세요.";

export async function runRetrieveStep(ctx: StepContext): Promise<StepResult<RetrieveStepOutput>> {
  const jd = parsedOutput(ctx.rows, "jd", 0);
  if (!jd) throw new AgentStepError("missing_input", "JD 분석 결과가 없습니다.", false);
  let built: { pack: RetrieveStepOutput["pack"]; warnings: string[]; insufficient: boolean; hasRole: boolean };
  if (ctx.pipeline === 2 && ctx.evidence) {
    built = await ctx.evidence.build({ userId: ctx.job.userId, jd: jd.jd, signals: jd.signals, jdText: ctx.job.input.jdText, nowYear: ctx.nowYear });
  } else {
    const graph = await ctx.loadGraph(ctx.job);
    built = { ...buildEvidencePack(graph, jd.jd, jd.signals, ctx.job.input.jdText, { nowYear: ctx.nowYear }), hasRole: graph.nodes.some((n) => n.label === "Role") };
  }
  const { pack, warnings, insufficient } = built;
  if (insufficient) throw new AgentStepError("insufficient_graph", INSUFFICIENT_GRAPH_MESSAGE, true);
  const situation = built.hasRole ? "general" : "new_grad";
  const c = pack.coverage;
  const summary = [`근거 찾은 요건 ${c.mustFound + c.niceFound}/${c.mustTotal + c.niceTotal} (필수 ${c.mustFound}/${c.mustTotal})`, `근거 노드 ${pack.items.length}개`, ...warnings];
  return { output: { pack, warnings, situation }, summary, usage: ZERO_USAGE, model: null };
}
