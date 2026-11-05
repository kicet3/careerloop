import "server-only";
/**
 * 그래프 채팅(기능 2): 사용자가 경험을 이야기하면 LLM이 현재 그래프 요약 + 대화 이력 + 새 메시지를 보고 답변과 그래프
 * 변경안(GraphOp)을 낸다. 변경안은 assistant 메시지 data에 status='proposed'로 저장하고, 사용자가 확인하면 적용한다.
 *
 * 흐름(라우트):
 * 1) startGraphChatMessage — 사용자 메시지 저장(동기). 직전 답변을 기다리는 중이면 409.
 * 2) runGraphChatReply — after()에서 LLM 호출 → 변경안 정리 → assistant 메시지 저장. 실패도 assistant 메시지로 남긴다
 *    (status='failed', data=null). CLI 엔진은 수십 초~수 분 걸리므로 클라이언트는 스레드를 폴링한다.
 * 3) applyGraphProposal / dismissGraphProposal — 'proposed'일 때만 바꾼다(updateMessage expectStatus로 중복 적용 방지).
 *
 * '답변 대기 중'은 별도 상태 컬럼 없이 "마지막 메시지가 사용자 메시지"로 판단한다. 서버가 재시작돼 답이 끝내 오지 않으면
 * STALE_AFTER_MS 뒤 stale로 보고 다시 시도(retry)를 허용한다.
 */
import Anthropic from "@anthropic-ai/sdk";
import { after } from "next/server";
import type { ProviderId } from "@/lib/domain/providers";
import {
  type ApplyGraphOpsResult,
  type CareerGraph,
  describeGraphOp,
  type GraphOp,
  MAX_OPS_PER_BATCH,
  NODE_LABEL_META,
  NODE_LABELS,
  NODE_TITLE_KEY,
  allowedPropKeys,
  type NodeLabel,
  PERSON_ID,
  REL_RULES,
  REL_TYPES,
  toGraphOps,
  edgeId,
} from "@/lib/domain/graph";
import {
  CHAT_TAGS,
  type ChatMessage,
  type ChatThread,
  type GraphChatOutput,
  GraphChatOutputSchema,
  type GraphProposalData,
} from "@/lib/domain/chat";
import { FeatureError } from "@/lib/api/errors";
import { createRateLimiter } from "@/lib/auth/rate-limit";
import { BodyTooLargeError, readBodyLimited } from "@/lib/diagnoses/body";
import {
  addMessage,
  ConcurrentMessageError,
  createThread,
  getMessage,
  getThread,
  listMessages,
  listThreads,
  renameThread,
  updateMessage,
} from "@/lib/chat/store";
import { field, historyToPrompt, INJECTION_RULE, wrapData } from "@/lib/chat/prompt";
import { applyGraphOps, getCareerGraph, graphEnabled, GraphOpError, GraphUnavailableError, graphToText } from "@/lib/graph/service";
import { planGraphOps } from "@/lib/graph/plan";
import { createLlmClient, LlmPermanentError, type LlmClient } from "@/lib/llm";
import { STAGE_TASK_DELIMITER } from "@/lib/panel/prompts";
import { stageErrorMessage } from "@/lib/panel/runner";
import { kstToday } from "@/lib/time/kst";

/** LLM 답변 제한 시간. 라우트 maxDuration(300초) 안에 끝나도록 잡는다. */
export const REPLY_TIMEOUT_MS = 270_000;
/** 마지막 사용자 메시지가 이보다 오래됐는데 답이 없으면 '응답 없음'으로 보고 다시 시도를 허용한다. */
export const STALE_AFTER_MS = 330_000;
/** 새 스레드 기본 제목(첫 메시지로 바뀐다). */
export const DEFAULT_THREAD_TITLE = "새 대화";
/** 프롬프트에 넣는 그래프 요약 상한(글자). */
const GRAPH_TEXT_MAX_CHARS = 12_000;

/** 사용자당 메시지 전송 상한(프로세스별 메모리 — 느슨한 비용 방어). */
const g = globalThis as unknown as { __graphChatLimiter?: ReturnType<typeof createRateLimiter> };
const sendLimiter = (g.__graphChatLimiter ??= createRateLimiter({ limit: 30, windowMs: 10 * 60_000 }));

// ---------------------------------------------------------------------------
// 프롬프트 (순수)
// ---------------------------------------------------------------------------

function modelGuide(): string {
  const labels = NODE_LABELS.map(
    (l) => `- ${l}(${NODE_LABEL_META[l].name}): ${NODE_LABEL_META[l].description}. 속성: ${allowedPropKeys(l).join(", ")} (대표 이름: ${NODE_TITLE_KEY[l]})`,
  ).join("\n");
  const rels = REL_TYPES.map((t) => `- ${t}(${REL_RULES[t].name}): ${REL_RULES[t].from.join("|")} → ${REL_RULES[t].to.join("|")}`).join("\n");
  return `노드 종류(본인은 Person, id "${PERSON_ID}"):\n${labels}\n\n관계(허용 방향만 쓸 수 있다):\n${rels}`;
}

export const GRAPH_CHAT_SYSTEM = `너는 한국어 경력 정리 도우미다. 사용자가 대화로 들려주는 경력·경험을 '경력 그래프'로 정리하는 변경안을 만든다.
변경안은 사용자가 확인한 뒤에만 적용된다. reply에는 무엇을 정리했는지 짧게 설명하고, 변경할 것이 없으면 ops는 []로 둔다.

${modelGuide()}

규칙:
1. 사실을 지어내지 않는다. 사용자가 말한 내용(최근 메시지와 이전 대화)에 있는 것만 속성으로 넣는다. 회사명·기간·숫자·직함을 추측해 채우지 않는다.
2. 기간(시작·종료), 성과 수치, 팀 규모, 맡은 역할처럼 빠진 정보는 속성을 비워 두고 followUpQuestions(최대 3개)로 구체적으로 묻는다.
3. 중복을 만들지 않는다. <${CHAT_TAGS.careerGraph}>에 같은(또는 표기만 다른) 회사·프로젝트·기술 등이 이미 있으면 addNode 대신 그 [id]를 써서 updateNode로 보강하거나 addEdge로 연결한다.
4. 새 노드는 addNode로 만들고 ref를 "new:<영문·숫자>"(변경안 안에서 유일)로 준다. 같은 변경안의 뒤 연산에서 그 ref로 연결한다.
5. 새 노드는 반드시 관계로 이어 둔다: 회사는 me -WORKED_AT->, 직무는 me -HAD_ROLE-> 와 Role -AT_COMPANY-> Company, 프로젝트는 Role 또는 me -WORKED_ON->, 경험은 me -HAS_EXPERIENCE->, 기술은 사용한 곳 -USED_SKILL-> 또는 me -HAS_SKILL->, 성과는 이룬 곳 -ACHIEVED->, 학력은 me -STUDIED_AT->, 자격증은 me -EARNED->.
6. 날짜는 YYYY, YYYY-MM, YYYY-MM-DD 형식만 쓴다. 현재 재직 중이면 Role.current="true"로 두고 endDate는 비운다.
7. deleteNode·deleteEdge는 사용자가 지우거나 바로잡아 달라고 분명히 말했을 때만 쓴다.
8. 이전 대화에서 사용자가 거절한 변경안은 다시 제안하지 않는다. 이미 적용된 내용은 다시 추가하지 않는다.
9. 사용자가 단순히 질문하거나 잡담하면 ops 없이 답한다. 그래프 밖의 일(이력서 작성 대행, 다른 사람 정보 등)은 정중히 범위를 알려 준다.
10. 각 연산에서 해당 없는 필드는 "" 또는 []로 둔다. updateNode의 props에는 바꿀 속성만 넣는다(값 ""는 그 속성 삭제).

${INJECTION_RULE}`;

/** 프롬프트용 대화 이력: 답변 실패 메시지와 그 직전 사용자 메시지(다시 보낸 것), 그리고 이번 메시지는 뺀다. */
export function conversationForPrompt(messages: readonly ChatMessage[]): Pick<ChatMessage, "role" | "content">[] {
  const out: Pick<ChatMessage, "role" | "content">[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isReplyError(m)) continue;
    if (m.role === "user" && messages[i + 1] && isReplyError(messages[i + 1]!)) continue;
    if (m.role === "assistant" && m.data?.kind === "graph-proposal" && m.data.ops.length > 0) {
      const note = { proposed: "확인 대기", applied: "적용됨", dismissed: "사용자가 거절", failed: "적용 실패" }[m.status ?? "proposed"];
      out.push({ role: "assistant", content: `${m.content}\n(변경안: ${m.data.summary || `${m.data.ops.length}개 변경`} — ${note})` });
      continue;
    }
    out.push({ role: m.role, content: m.content });
  }
  // 마지막 사용자 메시지는 latest_message로 따로 넣는다.
  if (out.at(-1)?.role === "user") out.pop();
  return out;
}

export function buildGraphChatPrompt(input: {
  graph: CareerGraph;
  messages: readonly ChatMessage[];
  latestMessage: string;
  today?: Date;
}): { system: string; user: string } {
  // 날짜는 한국 시간 기준(UTC로 자르면 KST 00:00~09:00에 하루 전 날짜가 들어간다).
  const today = kstToday(input.today ?? Date.now());
  // 그래프가 바뀌지 않는 동안 같은 앞부분(본인 이름·그래프)을 캐시 접두사로 두고, 날짜·대화·최근 메시지는 구분자 뒤에 둔다.
  const user = [
    field("본인 이름", input.graph.person.name ?? "(모름)"),
    "",
    "현재 경력 그래프([id]로 기존 노드를 가리킨다):",
    wrapData(CHAT_TAGS.careerGraph, graphToText(input.graph, { maxChars: GRAPH_TEXT_MAX_CHARS })),
    STAGE_TASK_DELIMITER,
    field("오늘 날짜", today),
    "",
    "이전 대화:",
    wrapData(CHAT_TAGS.conversation, historyToPrompt(conversationForPrompt(input.messages))),
    "",
    "사용자의 최근 메시지(이것을 바탕으로 답하고 변경안을 만든다):",
    wrapData(CHAT_TAGS.latestMessage, input.latestMessage),
  ].join("\n");
  return { system: GRAPH_CHAT_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// 변경안 정리 (순수)
// ---------------------------------------------------------------------------

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/]+/g, "");

function titleOf(label: NodeLabel, props: Record<string, unknown>): string {
  const v = props[NODE_TITLE_KEY[label]];
  return typeof v === "string" ? v : "";
}

/**
 * LLM이 이미 있는 노드를 다시 addNode하면 기존 노드를 가리키도록 바꾼다(같은 라벨·같은 대표 이름).
 * 비어 있던 속성만 updateNode로 보강하고, 같은 변경안 뒤 연산의 ref는 기존 id로 바꾼다. 이미 있는 관계 추가는 버린다.
 */
export function dedupeAgainstGraph(ops: readonly GraphOp[], graph: CareerGraph): { ops: GraphOp[]; merged: string[] } {
  const byKey = new Map<string, CareerGraph["nodes"][number]>();
  for (const n of graph.nodes) byKey.set(`${n.label}:${norm(titleOf(n.label, n.props as Record<string, unknown>))}`, n);
  const remap = new Map<string, string>();
  const merged: string[] = [];
  const out: GraphOp[] = [];
  const edges = new Set(graph.edges.map((e) => e.id));
  const seenEdges = new Set<string>();

  for (const op of ops) {
    if (op.op === "addNode") {
      const existing = byKey.get(`${op.label}:${norm(titleOf(op.label, op.props as Record<string, unknown>))}`);
      if (existing && norm(titleOf(op.label, op.props as Record<string, unknown>))) {
        remap.set(op.ref, existing.id);
        merged.push(`${NODE_LABEL_META[op.label].name} '${titleOf(op.label, op.props as Record<string, unknown>)}'은(는) 이미 있어 기존 항목에 합쳤습니다`);
        const cur = existing.props as Record<string, unknown>;
        const fill = Object.fromEntries(
          Object.entries(op.props as Record<string, unknown>).filter(([k, v]) => k !== NODE_TITLE_KEY[op.label] && v !== undefined && (cur[k] === undefined || cur[k] === "")),
        );
        if (Object.keys(fill).length > 0) out.push({ op: "updateNode", id: existing.id, label: op.label, props: fill } as GraphOp);
        continue;
      }
      out.push(op);
      continue;
    }
    if (op.op === "addEdge" || op.op === "deleteEdge") {
      const from = remap.get(op.from) ?? op.from;
      const to = remap.get(op.to) ?? op.to;
      if (op.op === "addEdge") {
        const id = edgeId(op.type, from, to);
        if (edges.has(id) || seenEdges.has(id)) continue;
        seenEdges.add(id);
      }
      out.push({ ...op, from, to });
      continue;
    }
    if (op.op === "updateNode" || op.op === "deleteNode") {
      out.push({ ...op, id: remap.get(op.id) ?? op.id } as GraphOp);
      continue;
    }
  }
  return { ops: out, merged };
}

/**
 * 현재 그래프 기준으로 연산을 하나씩 검사해(plan.ts — 적용 때와 같은 규칙) 통과하는 것만 남긴다.
 * 앞의 연산이 빠지면 그것을 참조하는 뒤 연산도 함께 빠진다. 버린 연산은 사유를 남긴다.
 */
export function validateAgainstGraph(ops: readonly GraphOp[], graph: CareerGraph): { ops: GraphOp[]; dropped: string[] } {
  const existing = new Map<string, NodeLabel>(graph.nodes.map((n) => [n.id, n.label]));
  const kept: GraphOp[] = [];
  const dropped: string[] = [];
  let seq = 0;
  for (const op of ops) {
    try {
      planGraphOps(existing, [...kept, op], () => `__check${seq++}`);
      kept.push(op);
    } catch (err) {
      if (!(err instanceof GraphOpError)) throw err;
      const reason = err.message.replace(/^변경 #\d+: /, "");
      dropped.push(`${describeGraphOp(op, graph, kept)} — ${reason}`);
    }
  }
  return { ops: kept, dropped };
}

/** LLM 출력 → assistant 메시지(내용·data·상태). 남은 연산이 없으면 상태 null(일반 답변). */
export function proposalFromOutput(
  output: GraphChatOutput,
  graph: CareerGraph,
): { content: string; data: GraphProposalData; status: "proposed" | null } {
  const converted = toGraphOps(output.ops);
  const deduped = dedupeAgainstGraph(converted.ops, graph);
  const validated = validateAgainstGraph(deduped.ops.slice(0, MAX_OPS_PER_BATCH), graph);
  const droppedOps = [...converted.errors, ...validated.dropped];
  const data: GraphProposalData = {
    kind: "graph-proposal",
    ops: validated.ops,
    summary: validated.ops.length > 0 ? output.summary.trim().slice(0, 300) || `${validated.ops.length}개 변경` : "",
    followUpQuestions: output.followUpQuestions.map((q) => q.trim()).filter(Boolean).slice(0, 3),
    ...(droppedOps.length > 0 || deduped.merged.length > 0 ? { droppedOps: [...deduped.merged, ...droppedOps].slice(0, 20) } : {}),
  };
  const content = output.reply.trim() || (validated.ops.length > 0 ? "말씀하신 내용으로 변경안을 만들었어요. 확인 후 적용해 주세요." : "알겠습니다.");
  return { content: content.slice(0, 8000), data, status: validated.ops.length > 0 ? "proposed" : null };
}

// ---------------------------------------------------------------------------
// 대기 상태 (순수)
// ---------------------------------------------------------------------------

/** 답변 생성 실패로 남긴 assistant 메시지. */
export function isReplyError(m: Pick<ChatMessage, "role" | "status" | "data">): boolean {
  return m.role === "assistant" && m.status === "failed" && m.data === null;
}

export interface ThreadReplyState {
  /** 마지막 사용자 메시지의 답을 기다리는 중. */
  pending: boolean;
  /** 기다린 지 너무 오래됐다(서버 재시작 등) — 다시 시도할 수 있다. */
  stale: boolean;
  /** retry 엔드포인트를 쓸 수 있는가(답변 실패 또는 stale). */
  canRetry: boolean;
}

export function replyState(messages: readonly Pick<ChatMessage, "role" | "status" | "data" | "createdAt">[], now: number): ThreadReplyState {
  const last = messages.at(-1);
  if (!last) return { pending: false, stale: false, canRetry: false };
  if (last.role === "user") {
    const stale = now - last.createdAt > STALE_AFTER_MS;
    return { pending: !stale, stale, canRetry: stale };
  }
  return { pending: false, stale: false, canRetry: isReplyError(last) };
}

// ---------------------------------------------------------------------------
// 서비스
// ---------------------------------------------------------------------------

export interface GraphChatDeps {
  getGraph(userId: string, personName: string | null): Promise<CareerGraph>;
  applyOps(userId: string, ops: GraphOp[]): Promise<ApplyGraphOpsResult>;
  createClient(provider: ProviderId): LlmClient;
  now(): number;
}

export const defaultGraphChatDeps: GraphChatDeps = {
  getGraph: (userId, personName) => getCareerGraph(userId, { personName }),
  applyOps: (userId, ops) => applyGraphOps(userId, ops),
  createClient: (provider) => createLlmClient(provider),
  now: () => Date.now(),
};

function assertGraphEnabled(): void {
  if (!graphEnabled()) throw new GraphUnavailableError();
}

async function requireGraphThread(userId: string, threadId: string): Promise<ChatThread> {
  const thread = await getThread(userId, threadId);
  if (!thread || thread.kind !== "graph") throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  return thread;
}

export function listGraphThreads(userId: string): Promise<ChatThread[]> {
  return listThreads(userId, { kind: "graph" });
}

export function createGraphThread(userId: string, title?: string | null): Promise<ChatThread> {
  const t = title?.replace(/\s+/g, " ").trim().slice(0, 80);
  return createThread({ userId, kind: "graph", title: t || DEFAULT_THREAD_TITLE });
}

export async function renameGraphThread(userId: string, threadId: string, title: string): Promise<ChatThread> {
  await requireGraphThread(userId, threadId);
  const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) throw new FeatureError("대화 제목을 입력해 주세요.", 400);
  await renameThread(userId, threadId, t);
  return requireGraphThread(userId, threadId);
}

/** 화면용 메시지: 변경안 연산을 사람이 읽을 줄로 함께 내려 준다. */
export type GraphChatMessageView = ChatMessage & { opLines?: string[] };

export interface GraphThreadView extends ThreadReplyState {
  thread: ChatThread;
  messages: GraphChatMessageView[];
}

export async function getGraphThreadView(
  userId: string,
  threadId: string,
  personName: string | null,
  deps: GraphChatDeps = defaultGraphChatDeps,
): Promise<GraphThreadView> {
  const thread = await requireGraphThread(userId, threadId);
  const messages = (await listMessages(userId, threadId)) ?? [];
  const withOps = messages.filter((m) => m.data?.kind === "graph-proposal" && m.data.ops.length > 0);
  let graph: CareerGraph | null = null;
  if (withOps.length > 0 && graphEnabled()) {
    // 노드 이름 표시용일 뿐이라 그래프를 못 읽어도 대화는 보여 준다.
    graph = await deps.getGraph(userId, personName).catch(() => null);
  }
  const view: GraphChatMessageView[] = messages.map((m) => {
    if (m.data?.kind !== "graph-proposal" || m.data.ops.length === 0) return m;
    const ops = m.data.ops;
    return { ...m, opLines: ops.map((op) => describeGraphOp(op, graph, ops)) };
  });
  return { thread, messages: view, ...replyState(messages, deps.now()) };
}

/** 사용자 메시지를 저장한다(답변은 runGraphChatReply). 답을 기다리는 중이면 409. */
export async function startGraphChatMessage(
  userId: string,
  threadId: string,
  text: string,
  deps: Pick<GraphChatDeps, "now"> = defaultGraphChatDeps,
): Promise<ChatMessage> {
  assertGraphEnabled();
  const thread = await requireGraphThread(userId, threadId);
  const recent = (await listMessages(userId, threadId, { limit: 1 })) ?? [];
  if (replyState(recent, deps.now()).pending) {
    throw new FeatureError("이전 메시지의 답변을 만드는 중입니다. 잠시 후 다시 보내 주세요.", 409);
  }
  const limit = sendLimiter.hit(userId);
  if (!limit.ok) throw new FeatureError(`메시지를 너무 자주 보냈습니다. ${Math.ceil(limit.retryAfterSec / 60)}분 뒤 다시 시도해 주세요.`, 429);
  // 대기 검사와 삽입을 한 문장으로: 읽은 뒤 다른 요청(다른 탭·두 번 클릭)이 먼저 메시지를 넣었으면 409.
  const msg = await addMessage(userId, { threadId, role: "user", content: text }, { expectLastId: recent.at(-1)?.id ?? null }).catch(
    rethrowConcurrent,
  );
  if (!msg) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  if (thread.title === DEFAULT_THREAD_TITLE) {
    await renameThread(userId, threadId, text.replace(/\s+/g, " ").trim().slice(0, 40));
  }
  return msg;
}

/** 답변 실패·무응답 뒤 다시 시도: 마지막 사용자 메시지를 다시 보낸다(이전 실패 쌍은 프롬프트에서 빠진다). */
export async function startGraphChatRetry(
  userId: string,
  threadId: string,
  deps: Pick<GraphChatDeps, "now"> = defaultGraphChatDeps,
): Promise<ChatMessage> {
  assertGraphEnabled();
  await requireGraphThread(userId, threadId);
  const messages = (await listMessages(userId, threadId, { limit: 2 })) ?? [];
  const state = replyState(messages, deps.now());
  if (!state.canRetry) throw new FeatureError("다시 시도할 메시지가 없습니다.", 409);
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  if (!lastUser) throw new FeatureError("다시 시도할 메시지가 없습니다.", 409);
  const limit = sendLimiter.hit(userId);
  if (!limit.ok) throw new FeatureError(`메시지를 너무 자주 보냈습니다. ${Math.ceil(limit.retryAfterSec / 60)}분 뒤 다시 시도해 주세요.`, 429);
  let lastId = messages.at(-1)!.id;
  if (state.stale) {
    // 답이 오지 않은 메시지: 실패 표시를 남겨 기록을 맞춘 뒤 다시 보낸다(동시 재시도 중 하나만 통과).
    const marker = await addMessage(
      userId,
      { threadId, role: "assistant", content: "답변을 받지 못했습니다.", status: "failed", data: null },
      { expectLastId: lastId },
    ).catch(rethrowConcurrent);
    if (!marker) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
    lastId = marker.id;
  }
  const msg = await addMessage(userId, { threadId, role: "user", content: lastUser.content }, { expectLastId: lastId }).catch(
    rethrowConcurrent,
  );
  if (!msg) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  return msg;
}

function rethrowConcurrent(err: unknown): never {
  if (err instanceof ConcurrentMessageError) {
    throw new FeatureError("이전 메시지의 답변을 만드는 중입니다. 잠시 후 다시 보내 주세요.", 409);
  }
  throw err;
}

/** 사용자에게 보일 답변 실패 사유. */
export function replyErrorMessage(err: unknown, opts: { timedOut?: boolean } = {}): string {
  if (err instanceof LlmPermanentError) return `답변을 만들지 못했습니다. ${stageErrorMessage(err).replace("이 단계의 ", "")}`;
  if (err instanceof GraphUnavailableError) return `답변을 만들지 못했습니다. ${err.message}`;
  // Anthropic SDK는 중단을 APIUserAbortError(name은 'Error')로 던진다 — 이름 대신 클래스·넘긴 signal 상태로 판정한다.
  if (
    opts.timedOut ||
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
  ) {
    return "답변 시간이 너무 오래 걸려 중단했습니다. 메시지를 짧게 나눠 다시 보내 주세요.";
  }
  return "답변을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.";
}

/**
 * 마지막 사용자 메시지에 답한다(백그라운드). 결과는 assistant 메시지로 저장하고 반환한다. 예외를 밖으로 던지지 않는다.
 * 이미 답이 있으면(중복 실행) 아무것도 하지 않고 null.
 */
export async function runGraphChatReply(
  userId: string,
  threadId: string,
  provider: ProviderId,
  personName: string | null,
  deps: GraphChatDeps = defaultGraphChatDeps,
): Promise<ChatMessage | null> {
  const messages = await listMessages(userId, threadId, { limit: 40 });
  const latest = messages?.at(-1);
  if (!messages || !latest || latest.role !== "user") return null;
  const deadline = AbortSignal.timeout(REPLY_TIMEOUT_MS);
  try {
    const graph = await deps.getGraph(userId, personName);
    const prompt = buildGraphChatPrompt({ graph, messages, latestMessage: latest.content, today: new Date(deps.now()) });
    const { output, usage } = await deps.createClient(provider).generate({
      task: "graph-chat",
      system: prompt.system,
      user: prompt.user,
      schema: GraphChatOutputSchema,
      effort: "medium",
      signal: deadline,
    });
    const proposal = proposalFromOutput(output, graph);
    // 저장 직전에도 마지막 메시지가 여전히 이 사용자 메시지일 때만 답을 단다(중복 실행·그 사이 새 메시지면 버린다).
    return await addMessage(
      userId,
      { threadId, role: "assistant", content: proposal.content, data: proposal.data, status: proposal.status, usage },
      { expectLastId: latest.id },
    );
  } catch (err) {
    if (err instanceof ConcurrentMessageError) return null;
    if (!(err instanceof LlmPermanentError)) console.error("[graph-chat reply]", threadId, err);
    else console.warn(`[graph-chat reply] ${threadId} LLM 실패: ${err.reason}`);
    return addMessage(
      userId,
      { threadId, role: "assistant", content: replyErrorMessage(err, { timedOut: deadline.aborted }), status: "failed", data: null },
      { expectLastId: latest.id },
    ).catch(() => null);
  }
}

/** 응답을 보낸 뒤 답변을 만든다(라우트 핸들러 안에서만 부른다). 실행 시간은 라우트 maxDuration을 따른다. */
export function scheduleGraphChatReply(userId: string, threadId: string, provider: ProviderId, personName: string | null): void {
  after(async () => {
    await runGraphChatReply(userId, threadId, provider, personName);
  });
}

async function requireProposal(userId: string, messageId: string): Promise<ChatMessage & { data: GraphProposalData }> {
  const msg = await getMessage(userId, messageId);
  if (!msg || msg.data?.kind !== "graph-proposal") throw new FeatureError("변경안을 찾을 수 없습니다.", 404);
  await requireGraphThread(userId, msg.threadId);
  return msg as ChatMessage & { data: GraphProposalData };
}

/**
 * 변경안을 적용한다. 'proposed' → 'applied'로 먼저 선점(동시 클릭·중복 요청 방지)한 뒤 applyGraphOps를 부르고,
 * 실패하면 'failed'(+사유)로 바꾼다. applyGraphOps는 한 트랜잭션이라 실패하면 그래프는 그대로다.
 */
export async function applyGraphProposal(
  userId: string,
  messageId: string,
  deps: Pick<GraphChatDeps, "applyOps" | "getGraph"> = defaultGraphChatDeps,
): Promise<{ message: ChatMessage; result: ApplyGraphOpsResult | null }> {
  assertGraphEnabled();
  const msg = await requireProposal(userId, messageId);
  if (msg.status !== "proposed" || msg.data.ops.length === 0) throw new FeatureError("이미 처리된 변경안입니다.", 409);
  const claimed = await updateMessage(userId, messageId, { status: "applied" }, { expectStatus: "proposed" });
  if (!claimed) throw new FeatureError("이미 처리된 변경안입니다.", 409);
  try {
    // 제안 뒤에 다른 변경안이 같은 노드를 먼저 만들었을 수 있다: 적용 직전 그래프로 중복을 다시 합친다.
    const current = await deps.getGraph(userId, null);
    const deduped = dedupeAgainstGraph(msg.data.ops, current);
    const result = await deps.applyOps(userId, deduped.ops);
    const data: GraphProposalData = { ...msg.data, created: result.created };
    if (deduped.merged.length > 0) {
      data.ops = deduped.ops;
      data.droppedOps = [...deduped.merged, ...(msg.data.droppedOps ?? [])].slice(0, 20);
    }
    const message = await updateMessage(userId, messageId, { data });
    return { message: message ?? claimed, result };
  } catch (err) {
    if (!(err instanceof GraphOpError)) {
      // 저장소 연결 문제 등: 그래프는 바뀌지 않았으므로 다시 적용할 수 있게 되돌리고 오류를 알린다.
      await updateMessage(userId, messageId, { status: "proposed" }).catch(() => null);
      throw err;
    }
    const reason = `${err.message} (그래프가 바뀌어 이 변경안을 그대로 적용할 수 없습니다. 다시 요청해 주세요.)`;
    const message = await updateMessage(userId, messageId, { status: "failed", data: { ...msg.data, error: reason } });
    return { message: message ?? claimed, result: null };
  }
}

export async function dismissGraphProposal(userId: string, messageId: string): Promise<ChatMessage> {
  await requireProposal(userId, messageId);
  const message = await updateMessage(userId, messageId, { status: "dismissed" }, { expectStatus: "proposed" });
  if (!message) throw new FeatureError("이미 처리된 변경안입니다.", 409);
  return message;
}

// ---------------------------------------------------------------------------
// 라우트 입력
// ---------------------------------------------------------------------------

const MAX_BODY_CHARS = 32_000;

/** 작은 JSON 본문만 받는다(메시지 4000자 + 여유). 형식이 틀리면 400 FeatureError. */
export async function readSmallJson(req: Request): Promise<unknown> {
  let text: string;
  try {
    // chunked 본문도 바이트를 세며 읽다가 한도(UTF-8 최대 4바이트/글자)를 넘으면 끊는다.
    text = new TextDecoder().decode(await readBodyLimited(req, MAX_BODY_CHARS * 4));
  } catch (err) {
    if (err instanceof BodyTooLargeError) throw new FeatureError("요청 본문이 너무 큽니다.", 413);
    throw new FeatureError("요청 형식이 올바르지 않습니다.", 400);
  }
  if (text.length > MAX_BODY_CHARS) throw new FeatureError("요청 본문이 너무 큽니다.", 413);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new FeatureError("요청 형식이 올바르지 않습니다.", 400);
  }
}
