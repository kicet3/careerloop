import "server-only";
/**
 * 그래프에 묻기(기능 B): 사용자의 경력 그래프만 근거로 질문에 답하고, 문장마다 [n] 출처(노드 id·라벨·이름·본인에서의 경로)를 단다.
 * 파이프라인(docs/GRAPH-QA.md): 그래프 로드 → retrieve(후보·확장) → rerank(결정적 점수·MMR) → (선택) llmRerank →
 * buildContext(번호 붙인 출처 표) → 답변 LLM → answerFromOutput(인용 검증) → assistant 메시지 저장.
 *
 * 스레드·대기·재시도·after() 흐름은 그래프 채팅(graph-chat.ts)과 같다 — kind='graph-qa' 스레드를 쓴다(스키마 변경 없음).
 */
import { after } from "next/server";
import { FeatureError } from "@/lib/api/errors";
import { GRAPH_QA_LIMIT } from "@/lib/auth/db-rate-limit";
import {
  CHAT_TAGS,
  type ChatMessage,
  type ChatThread,
  type GraphAnswerData,
  type GraphAnswerSuggestion,
  type GraphQaOutput,
  GraphQaOutputSchema,
  type GraphSource,
  type RetrievalDebug,
} from "@/lib/domain/chat";
import { EXPERIENCE_CATEGORIES, type ExperienceCategoryId } from "@/lib/domain/experience-categories";
import type { CareerGraph } from "@/lib/domain/graph";
import type { ProviderId } from "@/lib/domain/providers";
import { addMessage, ConcurrentMessageError, createThread, listMessages, listThreads, renameThread } from "@/lib/chat/store";
import { assessExperienceChecklist, type ExperienceChecklist } from "@/lib/graph/completeness";
import { buildContext } from "@/lib/graph/qa-context";
import { answerK, llmRerank, MIN_K, type Ranked, rerank, shouldLlmRerank } from "@/lib/graph/rerank";
import { INTENT_TAG, type QueryIntent, retrieve } from "@/lib/graph/retrieve";
import { graphEnabled, GraphUnavailableError } from "@/lib/graph/service";
import { LlmPermanentError } from "@/lib/llm";
import {
  assertWithinLimit,
  defaultGraphChatDeps,
  type GraphChatDeps,
  REPLY_TIMEOUT_MS,
  replyErrorMessage,
  replyState,
  requireThread,
  rethrowConcurrent,
  startUserMessage,
  type ThreadReplyState,
  untilAborted,
} from "./graph-chat";
import { historyToPrompt, INJECTION_RULE, wrapData } from "./prompt";

export const DEFAULT_QA_THREAD_TITLE = "새 질문";
/** 그래프가 비어 있을 때 LLM 없이 바로 답한다. */
export const EMPTY_GRAPH_ANSWER = "아직 그래프가 비어 있어요. '경험 정리하기'에서 이력서를 올리거나 경험을 이야기해 주세요.";
/** 디버그 정보는 개발 환경에서만 저장·반환한다. */
const debugEnabled = () => process.env.NODE_ENV !== "production";

/** 답변 호출 max_tokens(thinking 포함). */
export const QA_MAX_TOKENS = 8000;

export type GraphQaDeps = Pick<GraphChatDeps, "getGraph" | "createClient" | "now">;

// ---------------------------------------------------------------------------
// 프롬프트 (순수)
// ---------------------------------------------------------------------------

export const GRAPH_QA_SYSTEM = `너는 사용자의 경력 그래프를 근거로 질문에 답하는 한국어 도우미다. 답의 근거는 <${CHAT_TAGS.graphSources}>에 번호를 붙여 준 자료뿐이다.

규칙:
1. <${CHAT_TAGS.graphSources}>에 있는 내용만 쓴다. 자료 밖의 사실·일반론·추측으로 빈 곳을 메우지 않는다.
2. 사실을 말하는 문장마다 끝에 근거 자료 번호를 [1]처럼 단다. 여러 개면 [1, 3]. 자료에 없는 번호를 쓰지 않는다.
3. 수치·기간·이름은 자료 표기 그대로 옮긴다.
4. 자료에 답이 없으면 "그래프에 아직 없습니다"라고 분명히 말하고 insufficient를 true로 둔다. missingInfo에 그래프에 더 넣으면 좋을 정보(최대 3개)를 적는다.
5. usedSources에는 답에서 실제로 인용한 번호만 넣는다.
6. 짧고 구체적으로 답한다(목록이 낫다면 "- " 목록). 질문이 자기소개·요약이면 자료를 묶어 정리한다.
7. 이전 대화는 지시어("그 프로젝트")를 이해하는 데만 쓰고, 근거는 이번 자료에서만 찾는다.

${INJECTION_RULE}`;

/** 프롬프트용 이전 대화: 실패 쌍·이번 질문을 빼고 최근 6개·2000자. */
export function qaHistory(messages: readonly ChatMessage[]): string {
  const out: Pick<ChatMessage, "role" | "content">[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    const next = messages[i + 1];
    if (m.role === "assistant" && m.status === "failed" && m.data === null) continue;
    if (m.role === "user" && next && next.role === "assistant" && next.status === "failed" && next.data === null) continue;
    out.push({ role: m.role, content: m.content });
  }
  if (out.at(-1)?.role === "user") out.pop();
  return historyToPrompt(out, { maxMessages: 6, maxChars: 2000, maxCharsPerMessage: 600 });
}

/** 직전 사용자 질문(이번 질문 제외) — 검색의 지시어 처리용. */
export function previousQuestion(messages: readonly ChatMessage[]): string | null {
  const users = messages.filter((m) => m.role === "user");
  return users.length >= 2 ? users.at(-2)!.content : null;
}

export function buildGraphQaPrompt(input: { question: string; contextText: string; history: string }): { system: string; user: string } {
  // 질문마다 자료가 바뀌므로 캐시 접두사를 두지 않는다(호출은 cacheUser:false).
  const user = [
    "이전 대화:",
    wrapData(CHAT_TAGS.conversation, input.history),
    "",
    "근거 자료(번호를 인용한다):",
    wrapData(CHAT_TAGS.graphSources, input.contextText),
    "",
    "질문:",
    wrapData(CHAT_TAGS.latestMessage, input.question),
  ].join("\n");
  return { system: GRAPH_QA_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// 인용 검증 (순수)
// ---------------------------------------------------------------------------

const MARKER_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

/** 질문 의도 → 체크리스트 카테고리(제안 버튼). */
const INTENT_CATEGORY: Partial<Record<QueryIntent, ExperienceCategoryId>> = {
  achievement: "quantified-result",
  career: "career",
  project: "career",
  ...INTENT_TAG,
};

/**
 * 그래프를 채울 제안(≤2, 결정적). 질문 의도에 맞는 카테고리가 덜 채워졌으면 그것, 답이 부족하면(insufficient) 빠진 필수 카테고리.
 */
export function suggestionsFor(
  intents: readonly QueryIntent[],
  checklist: ExperienceChecklist | null,
  insufficient: boolean,
): GraphAnswerSuggestion[] {
  if (!checklist) return [];
  const state = new Map(checklist.categories.map((c) => [c.id, c]));
  const ids: ExperienceCategoryId[] = [];
  for (const i of intents) {
    const cat = INTENT_CATEGORY[i];
    if (cat && state.get(cat) && state.get(cat)!.state !== "done" && !ids.includes(cat)) ids.push(cat);
  }
  if (insufficient) {
    for (const c of checklist.categories) if (c.required && c.state !== "done" && !ids.includes(c.id)) ids.push(c.id);
  }
  return ids.slice(0, 2).map((id) => {
    const c = EXPERIENCE_CATEGORIES.find((x) => x.id === id)!;
    return { categoryId: id, name: c.name, chatStarter: c.chatStarter };
  });
}

/**
 * LLM 답 → 저장할 본문·data. 출처 표에 없는 번호, 표에는 있지만 그래프에서 사라진 노드를 가리키는 인용은 지우고 droppedCitations에
 * 남긴다. 출처는 답에 실제로 나온 번호만(usedSources만 있고 본문에 없는 번호는 칩을 만들지 않는다).
 * 유효 인용이 0개면 grounded=false이고 insufficient를 true로 보정한다.
 */
export function answerFromOutput(
  output: GraphQaOutput,
  table: readonly GraphSource[],
  graph: Pick<CareerGraph, "nodes">,
  ctx: { intents: readonly QueryIntent[]; checklist: ExperienceChecklist | null; debug?: RetrievalDebug },
): { content: string; data: GraphAnswerData } {
  const live = new Set(graph.nodes.map((n) => n.id));
  const byN = new Map(table.map((s) => [s.n, s]));
  const valid = (n: number) => byN.has(n) && live.has(byN.get(n)!.nodeId);
  const cited = new Set<number>();
  const dropped = new Set<number>();
  let content = output.answer.replace(MARKER_RE, (_m, list: string) => {
    const nums = list.split(",").map((x) => Number(x.trim()));
    const ok = [...new Set(nums.filter(valid))];
    for (const n of nums) if (!valid(n)) dropped.add(n);
    for (const n of ok) cited.add(n);
    return ok.length ? `[${ok.join(", ")}]` : "";
  });
  content = content.replace(/[ \t]+([.,!?。])/g, "$1").replace(/[ \t]{2,}/g, " ").trim();
  const sources = [...cited].sort((a, b) => a - b).map((n) => byN.get(n)!);
  const grounded = sources.length > 0;
  const insufficient = output.insufficient || !grounded;
  const data: GraphAnswerData = {
    kind: "graph-answer",
    sources,
    insufficient,
    grounded,
    missingInfo: output.missingInfo.map((x) => x.trim()).filter(Boolean).slice(0, 3),
    suggestions: suggestionsFor(ctx.intents, ctx.checklist, insufficient),
    ...(dropped.size > 0 ? { droppedCitations: [...dropped].sort((a, b) => a - b) } : {}),
    ...(ctx.debug ? { debug: ctx.debug } : {}),
  };
  return { content: (content || "그래프에서 답을 찾지 못했습니다.").slice(0, 8000), data };
}

// ---------------------------------------------------------------------------
// 검색 + 리랭크 (LLM 리랭크만 비동기)
// ---------------------------------------------------------------------------

export interface QaRetrieval {
  selected: Ranked[];
  intents: QueryIntent[];
  fallback: boolean;
  debug: RetrievalDebug;
}

/** 질문 → 답변 컨텍스트에 넣을 상위 K개(+디버그 정보). LLM 리랭크는 조건이 맞을 때만, 실패하면 결정적 순서. */
export async function retrieveForQuestion(
  graph: CareerGraph,
  question: string,
  opts: { history?: string | null; provider: ProviderId; client: ReturnType<GraphQaDeps["createClient"]>; deadlineAt: number; signal?: AbortSignal },
): Promise<QaRetrieval> {
  const r = retrieve(graph, question, { history: opts.history });
  let ranked = rerank(r.candidates, r.query.intents, { fallback: r.fallback });
  const k = answerK(r.query.intents);
  const decision = shouldLlmRerank({ poolSize: ranked.length, k, provider: opts.provider, remainingMs: opts.deadlineAt - Date.now() });
  let llmInfo: RetrievalDebug["llmRerank"] = { used: false, reason: decision.reason };
  if (decision.run) {
    const res = await llmRerank(question, ranked, r.query.intents, opts.client, opts.signal);
    ranked = res.ranked;
    llmInfo = { used: res.used, ...(res.reason ? { reason: res.reason } : {}), ms: res.ms };
  }
  const selected = ranked.slice(0, Math.max(MIN_K, k));
  const debug: RetrievalDebug = {
    intents: r.query.intents,
    skills: r.query.skills,
    tags: r.query.tags,
    fallback: r.fallback,
    pool: ranked.slice(0, 20).map((x) => ({
      id: x.candidate.node.id,
      name: x.candidate.name,
      label: x.candidate.node.label,
      signals: Object.fromEntries(Object.entries(x.candidate.signals).map(([k2, v]) => [k2, Math.round(v * 1000) / 1000])),
      det: Math.round(x.det * 1000) / 1000,
      ...(x.llm !== undefined ? { llm: x.llm } : {}),
      final: Math.round(x.final * 1000) / 1000,
    })),
    llmRerank: llmInfo,
    contextChars: 0,
  };
  return { selected, intents: r.query.intents, fallback: r.fallback, debug };
}

// ---------------------------------------------------------------------------
// 서비스
// ---------------------------------------------------------------------------

function assertGraphEnabled(): void {
  if (!graphEnabled()) throw new GraphUnavailableError();
}

const requireQaThread = (userId: string, threadId: string) => requireThread(userId, threadId, "graph-qa");

export function listQaThreads(userId: string): Promise<ChatThread[]> {
  return listThreads(userId, { kind: "graph-qa" });
}

export function createQaThread(userId: string, title?: string | null): Promise<ChatThread> {
  const t = title?.replace(/\s+/g, " ").trim().slice(0, 80);
  return createThread({ userId, kind: "graph-qa", title: t || DEFAULT_QA_THREAD_TITLE });
}

export async function renameQaThread(userId: string, threadId: string, title: string): Promise<ChatThread> {
  await requireQaThread(userId, threadId);
  const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) throw new FeatureError("대화 제목을 입력해 주세요.", 400);
  await renameThread(userId, threadId, t);
  return requireQaThread(userId, threadId);
}

export interface GraphQaThreadView extends ThreadReplyState {
  thread: ChatThread;
  messages: ChatMessage[];
}

/**
 * 스레드와 메시지. 출처가 있으면 그래프를 한 번 읽어 각 출처에 exists를 표시한다(못 읽으면 표시 없이). 운영 환경에서는 debug를 지운다.
 */
export async function getQaThreadView(
  userId: string,
  threadId: string,
  personName: string | null,
  deps: GraphQaDeps = defaultGraphChatDeps,
): Promise<GraphQaThreadView> {
  const thread = await requireQaThread(userId, threadId);
  const messages = (await listMessages(userId, threadId)) ?? [];
  const withSources = messages.some((m) => m.data?.kind === "graph-answer" && m.data.sources.length > 0);
  let live: Set<string> | null = null;
  if (withSources && graphEnabled()) {
    const graph = await deps.getGraph(userId, personName).catch(() => null);
    live = graph ? new Set(graph.nodes.map((n) => n.id)) : null;
  }
  const showDebug = debugEnabled();
  const view = messages.map((m) => {
    if (m.data?.kind !== "graph-answer") return m;
    const { debug, ...rest } = m.data;
    const data: GraphAnswerData = {
      ...rest,
      sources: rest.sources.map((s) => (live ? { ...s, exists: live.has(s.nodeId) } : s)),
      ...(showDebug && debug ? { debug } : {}),
    };
    return { ...m, data };
  });
  return { thread, messages: view, ...replyState(messages, deps.now()) };
}

/** 질문을 저장한다(답변은 runQaReply). 대기 중이면 409, 상한(GRAPH_QA_LIMIT)을 넘으면 429. */
export async function startQaMessage(
  userId: string,
  threadId: string,
  question: string,
  deps: Pick<GraphQaDeps, "now"> = defaultGraphChatDeps,
): Promise<ChatMessage> {
  assertGraphEnabled();
  return startUserMessage(
    userId,
    threadId,
    { content: question, data: null, title: question, kind: "graph-qa", limit: GRAPH_QA_LIMIT, defaultTitle: DEFAULT_QA_THREAD_TITLE },
    deps,
  );
}

/** 답변 실패·무응답 뒤 다시 시도: 마지막 질문을 다시 보낸다. */
export async function startQaRetry(
  userId: string,
  threadId: string,
  deps: Pick<GraphQaDeps, "now"> = defaultGraphChatDeps,
): Promise<ChatMessage> {
  assertGraphEnabled();
  await requireQaThread(userId, threadId);
  const messages = (await listMessages(userId, threadId, { limit: 2 })) ?? [];
  const state = replyState(messages, deps.now());
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!state.canRetry || !lastUser) throw new FeatureError("다시 시도할 질문이 없습니다.", 409);
  await assertWithinLimit(GRAPH_QA_LIMIT, userId);
  let lastId = messages.at(-1)!.id;
  if (state.stale) {
    const marker = await addMessage(
      userId,
      { threadId, role: "assistant", content: "답변을 받지 못했습니다.", status: "failed", data: null },
      { expectLastId: lastId },
    ).catch(rethrowConcurrent);
    if (!marker) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
    lastId = marker.id;
  }
  const msg = await addMessage(userId, { threadId, role: "user", content: lastUser.content }, { expectLastId: lastId }).catch(rethrowConcurrent);
  if (!msg) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  return msg;
}

/**
 * 마지막 질문에 답한다(백그라운드). 결과는 assistant 메시지(status null, data GraphAnswerData)로 저장한다. 실패는
 * status='failed', data=null. 예외를 밖으로 던지지 않는다. 이미 답이 있으면 null.
 */
export async function runQaReply(
  userId: string,
  threadId: string,
  provider: ProviderId,
  personName: string | null,
  deps: GraphQaDeps = defaultGraphChatDeps,
  opts: { startedAt?: number } = {},
): Promise<ChatMessage | null> {
  const messages = await listMessages(userId, threadId, { limit: 20 });
  const latest = messages?.at(-1);
  if (!messages || !latest || latest.role !== "user") return null;
  const deadlineAt = (opts.startedAt ?? Date.now()) + REPLY_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
  const save = (content: string, data: GraphAnswerData | null, usage?: Parameters<typeof addMessage>[1]["usage"]) =>
    addMessage(
      userId,
      { threadId, role: "assistant", content, data, status: data ? null : "failed", ...(usage ? { usage } : {}) },
      { expectLastId: latest.id },
    );
  try {
    deadline.throwIfAborted();
    const graph = await untilAborted(deps.getGraph(userId, personName), deadline);
    const checklist = assessExperienceChecklist(graph);
    if (graph.nodes.length === 0) {
      return await save(EMPTY_GRAPH_ANSWER, {
        kind: "graph-answer",
        sources: [],
        insufficient: true,
        grounded: false,
        missingInfo: [],
        suggestions: suggestionsFor([], checklist, true),
      });
    }
    const client = deps.createClient(provider);
    const r = await retrieveForQuestion(graph, latest.content, {
      history: previousQuestion(messages),
      provider,
      client,
      deadlineAt,
      signal: deadline,
    });
    const ctx = buildContext(r.selected, graph, { checklist, noDirectMatch: r.fallback });
    r.debug.contextChars = ctx.chars;
    const prompt = buildGraphQaPrompt({ question: latest.content, contextText: ctx.text, history: qaHistory(messages) });
    const { output, usage } = await client.generate({
      task: "graph-qa",
      system: prompt.system,
      user: prompt.user,
      schema: GraphQaOutputSchema,
      effort: "low",
      // 출력 목표는 1,200토큰 안팎이지만 Opus 5.5는 thinking 토큰도 max_tokens에 들어가 여유를 둔다.
      maxTokens: QA_MAX_TOKENS,
      cacheUser: false,
      signal: deadline,
    });
    const answer = answerFromOutput(output, ctx.sources, graph, {
      intents: r.intents,
      checklist,
      ...(debugEnabled() ? { debug: r.debug } : {}),
    });
    if (debugEnabled()) {
      console.info(
        `[graph-qa] ${threadId} intents=${r.intents.join(",")} pool=${r.debug.pool.length} llmRerank=${r.debug.llmRerank.used} cited=${answer.data.sources.length} dropped=${answer.data.droppedCitations?.length ?? 0}`,
      );
    }
    return await save(answer.content, answer.data, usage);
  } catch (err) {
    if (err instanceof ConcurrentMessageError) return null;
    if (!(err instanceof LlmPermanentError)) console.error("[graph-qa reply]", threadId, err);
    else console.warn(`[graph-qa reply] ${threadId} LLM 실패: ${err.reason}`);
    return save(replyErrorMessage(err, { timedOut: deadline.aborted }), null).catch(() => null);
  }
}

/** 응답 뒤 답변을 만든다(라우트 핸들러 안에서만). startedAt은 핸들러 진입 시각. */
export function scheduleQaReply(userId: string, threadId: string, provider: ProviderId, personName: string | null, startedAt?: number): void {
  after(async () => {
    await runQaReply(userId, threadId, provider, personName, defaultGraphChatDeps, { startedAt });
  });
}
