import "server-only";
/**
 * 경험 질문하기 에이전트 루프(§8) — 구조화 스텝 루프. LLM은 "어떤 도구를 어떤 인자로"만 고른다. 범위·권한은 서버가 정한다:
 * createAuthContext(after() 안에서 사용자 상태·동의 재확인) → 본인 스냅샷 → 스텝마다 권한 버전 확인 → 도구(strict 인자) → 검증 →
 * 검증된 근거만 대화록에 → 최종 답 결정적 검증(스냅샷 재로딩) → 저장(호출자). 스트리밍하지 않는다.
 * 보안 실패(SecurityViolation)는 그 즉시 루프를 멈추고 LLM을 더 부르지 않는다. 오류는 정제해 코드만 남긴다(console 금지, ragLog만).
 */
import { z } from "zod";
import type { GraphAgentAnswerData, GraphAgentCitation, GraphAgentSegment } from "@/lib/domain/chat";
import { SCOPE_VERDICTS } from "@/lib/domain/chat";
import type { CareerGraph } from "@/lib/domain/graph";
import type { LlmClient, LlmUsage } from "@/lib/llm/types";
import { modelScopeVerdict } from "@/lib/chat/scope-guard";
import { type AuthContext, assertPolicyCurrent, createAuthContext } from "./auth-context";
import { readAuthoritativeSource, sourceExistsElsewhere, type SourceExistsElsewhere, type SourceReader } from "./chunks/authoritative";
import { countUserChunks, getChunksByIds, searchChunksSql } from "./chunks/store";
import { sanitizeError } from "./errors";
import { filterMissingInfo, finalValidate, type FinalCheck } from "./final-validate";
import { ragLog } from "./log";
import { AGENT_SYSTEM, buildAgentUser, type TranscriptStep } from "./prompt";
import { EvidenceRegistry, type Evidence } from "./registry";
import { safeText } from "./render";
import { RequestScope } from "./scope";
import { type GraphLoader, loadOwnedSnapshot } from "./snapshot";
import { defaultEvalPlan, executeTool, TOOL_NAMES, type ToolDeps, type ToolOutcome } from "./tools";

export const AGENT_LIMITS = Object.freeze({
  maxSteps: 6,
  maxCallsPerStep: 3,
  maxCallsTotal: 12,
  /** 루프 마감(요청 시작부터). 남은 시간이 finalReserveMs보다 적으면 final 강제. Vercel 300초 안에서 검증·저장 여유. */
  loopMs: 120_000,
  finalReserveMs: 40_000,
  inputTokenBudget: 60_000,
  stepMaxTokens: 6000,
  /** final 호출(thinking 포함). 최대 segment 12개 × 500자 JSON + thinking이 들어가게 기존 QA(8000)보다 크게. */
  finalMaxTokens: 12_000,
});

const FinalSegmentSchema = z
  .object({
    text: z.string().min(1).max(500),
    kind: z.enum(["fact", "advice", "gap"]),
    // 형식만 느슨히 받는다 — 발급 여부는 최종 검증이 본다(가짜 id는 그 segment에서 지워진다).
    evidenceIds: z.array(z.string().max(40)).max(6),
  })
  .strict();

export const FinalAnswerSchema = z
  .object({
    scope: z.enum(SCOPE_VERDICTS).default("on_topic"),
    scopeReason: z.string().default(""),
    segments: z.array(FinalSegmentSchema).min(1).max(12),
    insufficient: z.boolean(),
    missingInfo: z.array(z.string().max(100)).max(3),
  })
  .strict();
export type FinalAnswer = z.infer<typeof FinalAnswerSchema>;

/**
 * 스텝 출력. 도구 인자는 전송 단계에서 객체로만 받고, 서버가 도구별 strict 스키마로 다시 검사한다(executeTool) —
 * 범위 키(userId·admin·cypher…)는 그 단계에서 invalid_args로 거부되고 LLM이 고칠 수 있다.
 */
const WireCallSchema = z.object({ tool: z.enum(TOOL_NAMES), args: z.record(z.string(), z.unknown()) }).strict();
export const AgentStepSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("call_tools"), thought: z.string().max(300).default(""), calls: z.array(WireCallSchema).min(1).max(AGENT_LIMITS.maxCallsPerStep) }).strict(),
  z.object({ action: z.literal("final"), answer: FinalAnswerSchema }).strict(),
]);
export const AgentFinalStepSchema = z.object({ action: z.literal("final"), answer: FinalAnswerSchema }).strict();
export type AgentStep = z.infer<typeof AgentStepSchema>;

export interface AgentDeps extends ToolDeps {
  loadGraph: GraphLoader;
  readSource: SourceReader;
  sourceExistsElsewhere: SourceExistsElsewhere;
  getChunksByIds: typeof getChunksByIds;
  countChunks(userId: string): Promise<number>;
  now(): number;
}

export function defaultAgentDeps(loadGraph: GraphLoader, now: () => number = Date.now): AgentDeps {
  return {
    loadGraph,
    readSource: readAuthoritativeSource,
    sourceExistsElsewhere,
    getChunksByIds,
    countChunks: countUserChunks,
    searchChunks: searchChunksSql,
    evalPlan: defaultEvalPlan,
    now,
  };
}

export type AgentOutcome =
  | { kind: "answer"; content: string; data: GraphAgentAnswerData; usage: LlmUsage; requestId: string; graph: CareerGraph }
  | { kind: "scope"; verdict: { category: "off_topic" | "abuse"; reason: string }; usage: LlmUsage }
  | { kind: "empty-graph" }
  | { kind: "blocked"; code: string; requestId: string; usage: LlmUsage }
  | { kind: "policy"; requestId: string | null }
  | { kind: "unavailable" }
  | { kind: "llm-error"; reason: string }
  | { kind: "timeout" }
  | { kind: "fallback"; code: string };

const zeroUsage = (): LlmUsage => ({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
const addUsage = (a: LlmUsage, b: LlmUsage) => {
  a.inputTokens += b.inputTokens;
  a.outputTokens += b.outputTokens;
  a.cacheReadTokens += b.cacheReadTokens;
  a.cacheWriteTokens += b.cacheWriteTokens;
};

/** 근거 없는 답·전부 지워진 답의 고정 안내. */
export const INSUFFICIENT_TEXT = "근거를 확인할 수 있는 답을 만들지 못했어요. 그래프나 문서에 관련 경험을 더 넣어 주세요.";

function outcomeLine(n: number, tool: string, o: ToolOutcome): string {
  if (o.status === "ok") return `#${n} ${tool} → ok(${o.evidence.length}건${o.truncated ? ", 잘림" : ""})\n${o.text}`;
  if (o.status === "empty") return `#${n} ${tool} → empty(결과 없음)`;
  return `#${n} ${tool} → error: ${o.code}${o.hint ? ` (${o.hint})` : ""}`;
}

/**
 * 대화록이 길어 접힌 스텝의 요약 줄. 머리(근거 id·handle)만 서버가 쓰고, 데이터 부분(라벨·이름 — 노드 제목·파일 이름)은 본문과 같이
 * 무력화한다(CHAT_TAGS 태그·근거 id·handle 표식, §8.3).
 */
export function summaryLine(e: Pick<Evidence, "evidenceId" | "handle" | "display">): string {
  return `[${e.evidenceId}]${e.handle ? ` ${e.handle}` : ""} ${safeText(`${e.display.label} ${e.display.name}`, 120)}`;
}

/** 검증 결과 → 저장 형태. 인용 번호는 처음 나온 순서. */
export function buildAnswerData(
  check: FinalCheck,
  answer: FinalAnswer,
  ctx: AuthContext,
): { content: string; data: GraphAgentAnswerData } {
  const nOf = new Map<string, number>();
  const citations: GraphAgentCitation[] = [];
  const cite = (e: Evidence) => {
    let n = nOf.get(e.evidenceId);
    if (n === undefined) {
      n = citations.length + 1;
      nOf.set(e.evidenceId, n);
      citations.push(toCitation(n, e));
    }
    return n;
  };
  let segments: GraphAgentSegment[] = check.segments.map((s) => ({ text: s.text.trim(), kind: s.kind, citations: [...new Set(s.evidence.map(cite))] }));
  const grounded = segments.some((s) => s.kind === "fact");
  if (check.allFactsDropped || segments.length === 0) segments = [{ text: INSUFFICIENT_TEXT, kind: "gap", citations: [] }, ...segments.filter((s) => s.kind !== "fact")];
  const insufficient = answer.insufficient || !grounded;
  const content = segments
    .map((s) => (s.citations.length ? `${s.text} [${s.citations.join(", ")}]` : s.text))
    .join("\n")
    .slice(0, 8000);
  const data: GraphAgentAnswerData = {
    kind: "graph-agent-answer",
    segments,
    citations,
    insufficient,
    grounded,
    // 근거 없이 저장·표시되므로 gap 규칙(수치·날짜·스냅샷 밖 이름 금지)으로 거른다.
    missingInfo: filterMissingInfo(answer.missingInfo, check.fresh),
    suggestions: [],
    requestId: ctx.requestId,
    ...(check.dropped.length ? { dropped: check.dropped.map((d) => ({ reason: d.reason })) } : {}),
  };
  return { content, data };
}

function toCitation(n: number, e: Evidence): GraphAgentCitation {
  const base: GraphAgentCitation = {
    n,
    evidenceId: e.evidenceId,
    kind: e.kind,
    label: e.display.label,
    name: e.display.name.slice(0, 120),
    snippet: e.display.snippet.slice(0, 200),
    ...(e.display.pathText ? { pathText: e.display.pathText.slice(0, 300) } : {}),
    ...(e.display.sourceType ? { sourceType: e.display.sourceType } : {}),
    ...(e.kind === "node" ? { nodeId: e.sourceKey } : {}),
    sourceKey: e.sourceKey,
    version: e.version,
    inputIds: [...e.inputIds].slice(0, 200),
    ...(e.kind === "aggregate" && e.aggregate ? { aggregatePlan: e.aggregate.plan } : {}),
  };
  if (e.chunk) base.sourceRef = { type: e.chunk.sourceType, id: e.chunk.sourceId, version: e.chunk.sourceVersion, start: e.chunk.spanStart, end: e.chunk.spanEnd, hash: e.chunk.contentHash };
  if (e.span) base.sourceRef = { type: e.span.sourceType, id: e.span.sourceId, version: e.span.sourceVersion, start: e.span.start, end: e.span.end, hash: e.span.hash };
  return base;
}

export interface RunAgentInput {
  userId: string;
  threadId: string;
  question: string;
  /** 본인 스레드의 이전 대화(근거가 사라진 fact는 이미 뺀 것). */
  history: string;
  client: LlmClient;
  deps: AgentDeps;
  startedAt: number;
  signal?: AbortSignal;
}

/**
 * 에이전트 실행. 예외를 밖으로 던지지 않고 결과 종류를 돌려준다(오류는 정제된 코드만).
 */
export async function runAgentQa(input: RunAgentInput): Promise<AgentOutcome> {
  const usage = zeroUsage();
  let ctx: AuthContext | null = null;
  let tool = "";
  let step = 0;
  try {
    ctx = await createAuthContext(input.userId, { now: input.startedAt });
    const snapshot = await loadOwnedSnapshot(ctx.principalUserId, input.deps.loadGraph);
    if (snapshot.nodes.size <= 1 && (await input.deps.countChunks(ctx.principalUserId)) === 0) return { kind: "empty-graph" };
    const scope = new RequestScope(ctx, snapshot, new EvidenceRegistry(ctx), {
      readSource: input.deps.readSource,
      sourceExistsElsewhere: input.deps.sourceExistsElsewhere,
    });
    const steps: TranscriptStep[] = [];
    let answer: FinalAnswer | null = null;
    let calls = 0;
    const loopEnd = input.startedAt + AGENT_LIMITS.loopMs;
    for (step = 1; step <= AGENT_LIMITS.maxSteps && !answer; step++) {
      input.signal?.throwIfAborted();
      await assertPolicyCurrent(ctx);
      const finalOnly =
        step === AGENT_LIMITS.maxSteps ||
        loopEnd - input.deps.now() < AGENT_LIMITS.finalReserveMs ||
        usage.inputTokens >= AGENT_LIMITS.inputTokenBudget ||
        calls >= AGENT_LIMITS.maxCallsTotal;
      const user = buildAgentUser({ history: input.history, question: input.question, steps, finalOnly });
      const res = await input.client.generate({
        task: finalOnly ? "graph-agent-final" : "graph-agent-step",
        system: AGENT_SYSTEM,
        user,
        schema: (finalOnly ? AgentFinalStepSchema : AgentStepSchema) as z.ZodType<AgentStep>,
        effort: "low",
        maxTokens: finalOnly ? AGENT_LIMITS.finalMaxTokens : AGENT_LIMITS.stepMaxTokens,
        cacheUser: false,
        ...(input.signal ? { signal: input.signal } : {}),
      });
      addUsage(usage, res.usage);
      const out = res.output;
      if (out.action === "final") {
        answer = out.answer;
        break;
      }
      const blocks: string[] = [];
      const summary: string[] = [];
      for (const call of out.calls) {
        tool = call.tool;
        calls += 1;
        const outcome: ToolOutcome =
          calls > AGENT_LIMITS.maxCallsTotal ? { status: "error", code: "budget" } : await executeTool(scope, call.tool, call.args, input.deps);
        blocks.push(outcomeLine(calls, call.tool, outcome));
        if (outcome.status === "ok") for (const e of outcome.evidence) summary.push(summaryLine(e));
      }
      tool = "";
      steps.push({ step, blocks, summary });
    }
    if (!answer) return { kind: "fallback", code: "no_final" };
    const verdict = modelScopeVerdict(answer);
    if (verdict) return { kind: "scope", verdict, usage };
    const check = await finalValidate(scope, answer.segments, {
      loadGraph: input.deps.loadGraph,
      readSourceFresh: input.deps.readSource,
      getChunksByIds: input.deps.getChunksByIds,
    });
    const built = buildAnswerData(check, answer, ctx);
    ragLog("agent_done", { requestId: ctx.requestId, threadId: input.threadId, step, counts: calls, code: check.dropped.length ? "dropped" : "ok" });
    return { kind: "answer", ...built, usage, requestId: ctx.requestId, graph: check.fresh.graph };
  } catch (err) {
    const e = sanitizeError(err);
    const requestId = ctx?.requestId ?? "";
    switch (e.kind) {
      case "security_violation":
        ragLog("security_violation", { requestId, threadId: input.threadId, code: e.code, tool, step });
        return { kind: "blocked", code: e.code, requestId, usage };
      case "access_revoked":
        ragLog(e.code === "policy_changed" ? "policy_changed" : "access_revoked", { requestId, threadId: input.threadId, step });
        return { kind: "policy", requestId: ctx?.requestId ?? null };
      case "unavailable":
        return { kind: "unavailable" };
      case "timeout":
        return { kind: "timeout" };
      case "llm":
        ragLog("agent_error", { requestId, threadId: input.threadId, code: e.code, name: "LlmPermanentError", step });
        // 출력 형식 문제는 기존 파이프라인으로 넘긴다. 계정·한도·엔진 문제는 기존 파이프라인도 같으므로 실패로 남긴다.
        return ["invalid_output", "max_tokens", "context_window", "bad_request"].includes(e.code) ? { kind: "fallback", code: e.code } : { kind: "llm-error", reason: e.code };
      default:
        ragLog("agent_error", { requestId, threadId: input.threadId, code: e.code, name: e.originalName ?? "Error", step, tool });
        return { kind: "fallback", code: e.code };
    }
  }
}

