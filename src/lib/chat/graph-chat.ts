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
  MAX_STORY_TAGS,
  normalizeStoryTags,
  STORY_TAGS,
  type StoryTag,
  NODE_LABEL_META,
  NODE_TITLE_KEY,
  type NodeLabel,
  toGraphOps,
  edgeId,
} from "@/lib/domain/graph";
import {
  CHAT_TAGS,
  type ChatMessage,
  type ChatThread,
  type ChatThreadKind,
  type DocumentImportData,
  type GraphChatOutput,
  GraphChatOutputSchema,
  GraphImportOutputSchema,
  type GraphProposalData,
  GraphRepoImportOutputSchema,
  MAX_IMPORT_OPS,
  MAX_PROMPT_FOLLOWUPS,
  MAX_REPO_IMPORT_OPS,
  MAX_REPO_IMPORT_QUESTIONS,
  type RepoImportData,
} from "@/lib/domain/chat";
import { FeatureError } from "@/lib/api/errors";
import { type DbRateLimit, GITHUB_IMPORT_LIMIT, GRAPH_CHAT_LIMIT, GRAPH_IMPORT_LIMIT, hitDbLimit } from "@/lib/auth/db-rate-limit";
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
import { assertGraphOwner } from "@/lib/graph/owner";
import { planGraphOps } from "@/lib/graph/plan";
import { assessExperienceChecklist, checklistToPromptText } from "@/lib/graph/completeness";
import { assessProjectStructure, type ProjectStructure, projectFocusText, restrictToFocus } from "@/lib/graph/project-structure";
import { storyTagName } from "@/lib/domain/experience-categories";
import { type FollowupAnswerData, type FollowupStatus, type GraphFollowup, normalizeFollowupText } from "@/lib/domain/followups";
import { skillKey } from "@/lib/skills/dictionary";
import { GRAPH_CHAT_FOCUS_RULES } from "./graph-focus-rules";
import { buildRepoImportPrompt, repoBriefBlock } from "./graph-repo-import";
import type { GithubThreadRepo } from "@/lib/github/types";
import { includePrivateAllowed, type RepoSnapshot, snapshotByRepoId, snapshotForProject, threadRepoView, unlinkDeletedProjects } from "@/lib/github/snapshots";
import { modelGuide } from "./graph-guide";
import {
  buildGraphImportPrompt,
  companyKey,
  DOC_KIND_NAMES,
  dropDeletes,
  guardImportUpdates,
  importMessage,
  type ParsedImport,
  verifyAgainstDocument,
} from "./graph-import";
import {
  clipFollowupDetail,
  dedupeCandidates,
  type ExistingFollowup,
  type FollowupCandidate,
  guardFollowupQuestions,
  MAX_DROPPED_FOLLOWUPS_PER_PROPOSAL,
  questionsFromEvidenceGaps,
  questionsFromFormatErrors,
  questionsFromFollowUps,
} from "./followup-extract";
import {
  followupStatuses,
  getFollowup,
  listFollowups,
  markFollowupsAnswered,
  onProposalApplied,
  openFollowupsForPrompt,
  recentProjectFollowups,
  reconcileProjectFollowups,
  releasePendingRefs,
  saveProposalFollowups,
} from "./followups";
import { coverOf, FOLLOWUP_TOPIC_NAMES, filledTopics, followupTopicKeys, overlayGraphOps } from "./followup-topics";
import { createLlmClient, LlmPermanentError, type LlmClient, type LlmUsageContext } from "@/lib/llm";
import { STAGE_TASK_DELIMITER } from "@/lib/panel/prompts";
import { stageErrorMessage } from "@/lib/panel/runner";
import { kstToday } from "@/lib/time/kst";

/**
 * 답변 제한 시간. 요청 시작부터 센다(Vercel은 maxDuration을 요청 시작부터 재므로) — 라우트 maxDuration(300초)에서
 * 30초 여유를 둬, 플랫폼이 함수를 끊기 전에 실패 메시지를 저장한다.
 */
export const REPLY_TIMEOUT_MS = 270_000;
/** 마지막 사용자 메시지가 이보다 오래됐는데 답이 없으면 '응답 없음'으로 보고 다시 시도를 허용한다. */
export const STALE_AFTER_MS = 330_000;
/** 프로젝트 단위 대화에서 그 프로젝트가 그래프에서 지워졌을 때의 답. */
export const FOCUS_MISSING_REPLY = "구조화하던 프로젝트를 그래프에서 찾을 수 없습니다. 지워졌다면 새 대화를 시작하거나 다른 프로젝트를 골라 주세요.";
/** GitHub 저장소로 정리하는데 저장소 정보(snapshot)가 없을 때(연결 해제 등)의 답. */
export const REPO_MISSING_REPLY = "GitHub 저장소 정보를 찾을 수 없습니다. 연결 상태를 확인하고 다시 가져와 주세요.";
/** 새 스레드 기본 제목(첫 메시지로 바뀐다). */
export const DEFAULT_THREAD_TITLE = "새 대화";
/** 프롬프트에 넣는 그래프 요약 상한(글자). */
const GRAPH_TEXT_MAX_CHARS = 12_000;
/** 이후 대화 프롬프트에 다시 넣는 최근 문서 글자 수 상한. */
const FOLLOWUP_DOC_MAX_CHARS = 8000;


// ---------------------------------------------------------------------------
// 프롬프트 (순수)
// ---------------------------------------------------------------------------

export const GRAPH_CHAT_SYSTEM = `너는 한국어 경력 정리 도우미다. 사용자가 대화로 들려주는 경력·경험을 '경험 그래프'로 정리하는 변경안을 만든다.
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
11. Project·Experience는 자소서 소재 단위다. 사용자가 이야기한 경험은 situation(상황·목표), action(내 행동), result(결과), learned(배운 점), myRole(내 역할)로 나눠 넣는다. 사용자가 실제로 말한 내용이 뒷받침하는 categories(위 id, 쉼표로 구분, 최대 3개)만 단다. 기존 노드의 categories는 새로 달 태그만 보내면 기존 태그에 더해진다. 태그를 빼 달라고 하면 남길 태그 전체를 보내고(빼고 하나도 안 남으면 ""), 그 밖에는 기존 태그의 일부만 다시 보내지 않는다. 회사 안의 일화는 Role에 붙이지 않고 Project를 만들어 Role -WORKED_ON->으로 잇는다.
12. 성과 수치는 Achievement(value에 수치)로 만들고, 그 경험(Role·Project·Experience)에서 -ACHIEVED->로 잇는다.
13. <${CHAT_TAGS.experienceChecklist}>에 빠진 필수 항목이 있으면 followUpQuestions 중 하나 이상은 그 항목의 최소 정보를 묻는다. 한 번에 한 카테고리만 묻고, 사용자가 꺼낸 화제를 우선한다.
14. 최소 정보를 지어내지 않는다. 비어 있으면 묻는다.
15. <${CHAT_TAGS.resume}>·<${CHAT_TAGS.portfolio}>가 있으면 사용자가 이 대화에서 앞서 올린 문서다. 사용자가 그 문서의 내용을 넣어 달라고 하면 문서에 글자로 있는 사실만 쓴다.
16. <${CHAT_TAGS.openFollowups}>는 사용자에게 아직 열려 있는 후속 질문 목록(id. (프로젝트) 질문)이다. 사용자의 최근 메시지(<${CHAT_TAGS.latestMessage}>)가 그중 어떤 질문에 실제로 답했으면(질문이 묻는 정보를 전부 또는 충분히 줬으면) 그 id를 answeredFollowups에 넣는다. 이전 대화에서 답한 것, 그래프에 이미 있는 것, 추측으로는 넣지 않는다. "모르겠다"·"없다"·"나중에"처럼 정보를 주지 않은 답, 다른 프로젝트에 대한 답은 넣지 않는다. 목록에 없는 id는 쓰지 않는다. answeredFollowups에 넣은 질문은 followUpQuestions로 다시 묻지 않는다. 목록이 없거나 해당이 없으면 [].
17. followUpQuestions에는 아직 모르는 것만 묻는다. <${CHAT_TAGS.askedFollowups}>에 있는 것(이미 채운 항목, 확인 대기 중인 변경안이 채우는 항목, 이미 답한·건너뛴 질문)과 이전 대화에서 사용자가 이미 말한 것은 표현을 바꿔서도 다시 묻지 않는다. 확인 대기 중인 변경안에 들어 있는 내용은 이미 들은 것이다 — 그래프에 아직 없다고 다시 묻지 말고, 필요하면 그 변경안을 적용해 달라고 안내한다. followUpTopics에는 followUpQuestions 각각이 채우는 항목을 같은 순서로 쓴다(background, role, team, period, affiliation, tech, actions, result, metric-basis, learned, limitations, challenge, collaboration 중, 질문 하나에 문자열 하나, 여러 개면 쉼표).

${INJECTION_RULE}`;

/** 프로젝트 단위 대화(스레드에 focusNodeId가 있을 때) 시스템 프롬프트에 덧붙이는 규칙(graph-focus-rules.ts — 저장소 가져오기 프롬프트도 쓴다). */
export { GRAPH_CHAT_FOCUS_RULES };

/**
 * 일반 대화에서 사용자가 후속 질문에 답할 때의 안내. 시스템 프롬프트가 아니라 구분자 뒤 후속 질문 블록에 넣는다
 * (시스템 프롬프트를 매번 같게 두어 프롬프트 캐시를 깨지 않는다).
 */
export const GRAPH_CHAT_FOLLOWUP_RULE = `사용자의 최근 메시지는 아래 '지금 답하는 질문'에 대한 답이다. 그 답을 그 질문이 가리키는 항목에 정리한다.`;

/** 프롬프트용 대화 이력: 답변 실패 메시지와 그 직전 사용자 메시지(다시 보낸 것), 그리고 이번 메시지는 뺀다. */
export function conversationForPrompt(messages: readonly ChatMessage[]): Pick<ChatMessage, "role" | "content">[] {
  const out: Pick<ChatMessage, "role" | "content">[] = [];
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (isReplyError(m)) continue;
    if (m.role === "user" && messages[i + 1] && isReplyError(messages[i + 1]!)) continue;
    if (m.role === "user" && m.data?.kind === "document-import") {
      // 문서 본문은 대화가 아니라 <resume>/<portfolio>로 따로 넣는다(buildGraphChatPrompt).
      const tag = m.data.docKind === "portfolio" ? CHAT_TAGS.portfolio : CHAT_TAGS.resume;
      out.push({
        role: "user",
        content: `(자료: ${DOC_KIND_NAMES[m.data.docKind]} ${m.data.fileName ?? "붙여넣은 글"}, ${m.data.chars.toLocaleString()}자 — 원문은 <${tag}>에)`,
      });
      continue;
    }
    if (m.role === "user" && m.data?.kind === "repo-import") {
      // 저장소 정보는 대화가 아니라 <github_repo>로 따로 넣는다(buildGraphChatPrompt repoBrief).
      out.push({ role: "user", content: `(자료: GitHub 저장소 ${m.data.fullName} — 정보는 <${CHAT_TAGS.githubRepo}>에)` });
      continue;
    }
    if (m.role === "user" && m.data?.kind === "followup-answer") {
      // 질문은 짧게 잘라 붙인다(메시지 글자 수 상한에 답의 끝이 잘리지 않게).
      const q = m.data.question.length > 80 ? `${m.data.question.slice(0, 79)}…` : m.data.question;
      out.push({ role: "user", content: `(후속 질문 “${q}”에 대한 답) ${m.content}` });
      continue;
    }
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

/** 스레드에서 가장 최근에 올린 문서(있으면): "아까 이력서의 X도 넣어줘" 같은 후속 요청이 되게 프롬프트에 함께 넣는다. */
function latestDocumentBlock(messages: readonly ChatMessage[]): string[] {
  const doc = [...messages].reverse().find((m) => m.role === "user" && m.data?.kind === "document-import")?.data as
    | DocumentImportData
    | undefined;
  if (!doc?.text) return [];
  const tag = doc.docKind === "portfolio" ? CHAT_TAGS.portfolio : CHAT_TAGS.resume;
  const body = doc.text.length > FOLLOWUP_DOC_MAX_CHARS ? `${doc.text.slice(0, FOLLOWUP_DOC_MAX_CHARS)}\n…(생략)` : doc.text;
  return ["", `이 대화에서 올린 ${DOC_KIND_NAMES[doc.docKind]}(${doc.fileName ?? "붙여넣은 글"}):`, wrapData(tag, body)];
}

export function buildGraphChatPrompt(input: {
  graph: CareerGraph;
  messages: readonly ChatMessage[];
  latestMessage: string;
  today?: Date;
  /** 프로젝트 단위 대화: 구조화할 Project 노드 id(그래프에 있어야 한다 — 없으면 일반 대화처럼 만든다). */
  focusProjectId?: string | null;
  /** 후속 질문: 이번 메시지가 답하는 질문(current)과 그 프로젝트의 남은 열린 질문(rest, 프로젝트 대화만). */
  followups?: { current: string | null; rest: readonly string[] } | null;
  /** 프로젝트 대화: 이 프로젝트에 이은 GitHub 저장소 요약(github_repo_snapshots.brief). 구분자 앞(캐시 접두사)에 넣는다. */
  repoBrief?: string | null;
  /** 열린 후속 질문(짧은 id → 질문). 최근 메시지가 답한 것을 LLM이 answeredFollowups로 표시한다(openFollowupsBlock). */
  openFollowups?: readonly PromptFollowup[];
  /** 이미 정리했거나 이미 물은 것(프로젝트별) — 다시 묻지 않는다(askedFollowupsBlock, 규칙 17). */
  asked?: readonly AskedSummary[];
}): { system: string; user: string } {
  // 날짜는 한국 시간 기준(UTC로 자르면 KST 00:00~09:00에 하루 전 날짜가 들어간다).
  const today = kstToday(input.today ?? Date.now());
  const focusText = input.focusProjectId ? projectFocusText(input.graph, input.focusProjectId) : null;
  // 그래프가 바뀌지 않는 동안 같은 앞부분(본인 이름·그래프)을 캐시 접두사로 두고, 날짜·대화·최근 메시지는 구분자 뒤에 둔다.
  const user = [
    field("본인 이름", input.graph.person.name ?? "(모름)"),
    "",
    "현재 경험 그래프([id]로 기존 노드를 가리킨다):",
    wrapData(CHAT_TAGS.careerGraph, graphToText(input.graph, { maxChars: GRAPH_TEXT_MAX_CHARS })),
    "",
    "경험 체크리스트(빠진 필수 항목부터):",
    wrapData(CHAT_TAGS.experienceChecklist, checklistToPromptText(assessExperienceChecklist(input.graph))),
    ...(focusText ? ["", "이 대화에서 구조화할 프로젝트(모든 변경안은 이 프로젝트에 붙인다):", wrapData(CHAT_TAGS.focusProject, focusText)] : []),
    ...(focusText && input.repoBrief ? repoBriefBlock(input.repoBrief) : []),
    ...latestDocumentBlock(input.messages),
    STAGE_TASK_DELIMITER,
    field("오늘 날짜", today),
    "",
    "이전 대화:",
    wrapData(CHAT_TAGS.conversation, historyToPrompt(conversationForPrompt(input.messages))),
    "",
    ...followupBlock(input.followups ?? null, Boolean(focusText)),
    ...openFollowupsBlock(input.openFollowups ?? []),
    ...askedFollowupsBlock(input.asked ?? []),
    "사용자의 최근 메시지(이것을 바탕으로 답하고 변경안을 만든다):",
    wrapData(CHAT_TAGS.latestMessage, input.latestMessage),
  ].join("\n");
  return { system: focusText ? `${GRAPH_CHAT_SYSTEM}\n\n${GRAPH_CHAT_FOCUS_RULES}` : GRAPH_CHAT_SYSTEM, user };
}

/** 대화에서 사용자가 답으로 보낸 후속 질문 id(followup-answer 메시지). 화면(GraphChatPanel)도 같은 규칙으로 현재 질문을 고른다. */
export function followupIdsAnsweredIn(messages: readonly Pick<ChatMessage, "role" | "data">[]): Set<string> {
  const out = new Set<string>();
  for (const m of messages) if (m.role === "user" && m.data?.kind === "followup-answer") out.add(m.data.followupId);
  return out;
}

/** 프롬프트에 넣는 남은 후속 질문 수. */
const FOLLOWUP_PROMPT_REST = 5;

/** 후속 질문 블록(구분자 뒤 — 매번 바뀐다). 남은 질문은 프로젝트 대화에서만 넣는다. 넣을 것이 없으면 []. */
function followupBlock(f: { current: string | null; rest: readonly string[] } | null, focused: boolean): string[] {
  if (!f) return [];
  const rest = focused ? f.rest.slice(0, FOLLOWUP_PROMPT_REST) : [];
  if (!f.current && rest.length === 0) return [];
  const lines = [
    ...(f.current ? [`지금 답하는 질문: ${f.current}`] : []),
    ...(rest.length ? ["남은 후속 질문(앞의 것부터 묻는다):", ...rest.map((q, i) => `${i + 1}. ${q}`)] : []),
  ];
  // 일반 대화의 안내는 여기(구분자 뒤)에 둔다. 프로젝트 대화는 시스템 프롬프트의 P6이 같은 일을 한다.
  return [...(focused ? [] : [GRAPH_CHAT_FOLLOWUP_RULE]), "후속 질문 목록:", wrapData(CHAT_TAGS.followupQuestions, lines.join("\n")), ""];
}

/** 프롬프트용 열린 후속 질문: key는 짧은 id(f1, f2, …) — 실제 id와의 대응은 서버만 갖는다. */
export interface PromptFollowup {
  key: string;
  id: string;
  text: string;
  /** 프로젝트 이름(미지정이면 null). */
  project: string | null;
}

/** 열린 후속 질문에 짧은 id(f1…)와 프로젝트 이름을 붙인다. */
export function toPromptFollowups(items: readonly GraphFollowup[], graph: CareerGraph | null): PromptFollowup[] {
  const names = new Map((graph?.nodes ?? []).filter((n) => n.label === "Project").map((n) => [n.id, nodeTitle(n)]));
  return items.map((f, i) => ({
    key: `f${i + 1}`,
    id: f.id,
    text: f.text,
    project: f.projectNodeId ? (names.get(f.projectNodeId) ?? "(이름 모름)") : null,
  }));
}

/** 열린 후속 질문 블록(구분자 뒤). 없으면 []. 질문 글은 사용자 데이터라 wrapData로 감싼다. */
function openFollowupsBlock(items: readonly PromptFollowup[]): string[] {
  if (items.length === 0) return [];
  const lines = items.map((f) => `${f.key}. (${f.project ?? "프로젝트 미지정"}) ${f.text.replace(/\s*\n\s*/g, " ")}`);
  return [
    "열린 후속 질문(최근 메시지가 실제로 답한 질문만 그 id를 answeredFollowups에 넣는다 — 규칙 16):",
    wrapData(CHAT_TAGS.openFollowups, lines.join("\n")),
    "",
  ];
}

/** 프로젝트 하나에 대해 이미 정리했거나 이미 물은 것(프롬프트용). */
export interface AskedSummary {
  project: string;
  /** 그래프에 이미 값이 있는 주제 이름. */
  filled: string[];
  /** 확인 대기 중인 변경안이 채우는 주제 이름(그래프에는 아직 없다). */
  pending: string[];
  /** 이미 답한 질문(최근 것). */
  answered: string[];
  /** 건너뛴 질문(최근 것). */
  skipped: string[];
}

/** 프롬프트에 넣는 답한·건너뛴 질문 수(프로젝트마다 최근 것). */
const ASKED_PROMPT_LIMIT = 10;

/**
 * 프로젝트의 "이미 아는 것" 요약: graph(적용된 그래프)에 채운 주제, pendingGraph(확인 대기 변경안을 얹은 그래프)에서만 채운 주제,
 * 최근 답한·건너뛴 질문. 프로젝트가 없으면 null.
 */
export function askedSummary(
  graph: CareerGraph,
  pendingGraph: CareerGraph,
  projectId: string,
  history: readonly ExistingFollowup[],
): AskedSummary | null {
  const structure = assessProjectStructure(graph, projectId);
  if (!structure) return null;
  const filled = filledTopics(graph, projectId);
  const pending = [...filledTopics(pendingGraph, projectId)].filter((t) => !filled.has(t));
  const mine = history.filter((h) => h.projectNodeId === projectId && h.kind === "question");
  const recent = (status: "answered" | "skipped") =>
    mine
      .filter((h) => h.status === status)
      .slice(-ASKED_PROMPT_LIMIT)
      .map((h) => h.text);
  return {
    project: structure.projectName,
    filled: [...filled].map((t) => FOLLOWUP_TOPIC_NAMES[t]),
    pending: pending.map((t) => FOLLOWUP_TOPIC_NAMES[t]),
    answered: recent("answered"),
    skipped: recent("skipped"),
  };
}

/** 이미 정리했거나 이미 물은 것 블록(구분자 뒤). 질문 글·프로젝트 이름은 사용자 데이터라 wrapData로 감싼다. 넣을 것이 없으면 []. */
function askedFollowupsBlock(items: readonly AskedSummary[]): string[] {
  const lines: string[] = [];
  const oneLine = (t: string) => (t.length > 160 ? `${t.slice(0, 159)}…` : t).replace(/\s*\n\s*/g, " ");
  for (const a of items) {
    if (!a.filled.length && !a.pending.length && !a.answered.length && !a.skipped.length) continue;
    lines.push(`[${a.project}]`);
    if (a.filled.length) lines.push(`- 이미 채운 항목: ${a.filled.join(", ")}`);
    if (a.pending.length) lines.push(`- 확인 대기 중인 변경안이 채우는 항목(이미 들었다): ${a.pending.join(", ")}`);
    if (a.answered.length) lines.push("- 이미 답한 질문:", ...a.answered.map((t) => `  · ${oneLine(t)}`));
    if (a.skipped.length) lines.push("- 건너뛴 질문:", ...a.skipped.map((t) => `  · ${oneLine(t)}`));
  }
  if (lines.length === 0) return [];
  return [
    "이미 정리했거나 이미 물은 것(표현을 바꿔서도 다시 묻지 않는다 — 규칙 17):",
    wrapData(CHAT_TAGS.askedFollowups, lines.join("\n")),
    "",
  ];
}

/** 이 대화에서 확인을 기다리는 변경안(아직 적용하지 않은 것)을 그래프 복사본에 얹는다 — "이미 들은 것" 판정용. */
export function withPendingProposals(graph: CareerGraph, messages: readonly ChatMessage[]): CareerGraph {
  let out = graph;
  for (const m of messages) {
    if (m.role !== "assistant" || m.status !== "proposed" || m.data?.kind !== "graph-proposal" || m.data.ops.length === 0) continue;
    out = overlayGraphOps(out, m.data.ops, `${m.id}:`);
  }
  return out;
}

/**
 * LLM이 낸 answeredFollowups(짧은 id)를 실제 질문으로. 프롬프트에 넣은 목록에 없는 id는 버린다(지어낸 id·다른 사용자의 id 방어).
 * "f2", "[f2]", "F2" 정도의 표기 차이는 받아 준다.
 */
export function resolveAnsweredKeys(keys: readonly string[] | undefined, items: readonly PromptFollowup[]): PromptFollowup[] {
  const byKey = new Map(items.map((f) => [f.key, f]));
  const out = new Map<string, PromptFollowup>();
  for (const k of keys ?? []) {
    const f = byKey.get(k.trim().replace(/^\[|\]$/g, "").toLowerCase());
    if (f) out.set(f.id, f);
  }
  return [...out.values()];
}

/** 최근 메시지에서 이름이 나온 Project 노드 id(정규화한 이름이 2글자 이상일 때만, 메시지에 나온 순서). */
export function mentionedProjectIds(graph: CareerGraph, text: string): string[] {
  const hay = normalizeFollowupText(text);
  if (!hay) return [];
  const hits: { id: string; at: number }[] = [];
  for (const n of graph.nodes) {
    if (n.label !== "Project") continue;
    const key = normalizeFollowupText(titleOf(n.label, n.props as Record<string, unknown>));
    if (key.length < 2) continue;
    const at = hay.indexOf(key);
    if (at >= 0) hits.push({ id: n.id, at });
  }
  return hits.sort((a, b) => a.at - b.at).map((h) => h.id);
}

// ---------------------------------------------------------------------------
// 변경안 정리 (순수)
// ---------------------------------------------------------------------------

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/]+/g, "");

/** 중복 판정 키: 기술은 사전 정식 명칭("리액트" = "React"), 회사는 "(주)"·"주식회사"를 뗀 이름, 나머지는 정규화한 대표 이름. */
function dedupeKey(label: NodeLabel, props: Record<string, unknown>): string {
  const title = titleOf(label, props);
  if (!norm(title)) return "";
  if (label === "Skill") return `${label}:${norm(skillKey(title))}`;
  if (label === "Company") return `${label}:${companyKey(title) || norm(title)}`;
  return `${label}:${norm(title)}`;
}

function titleOf(label: NodeLabel, props: Record<string, unknown>): string {
  const v = props[NODE_TITLE_KEY[label]];
  return typeof v === "string" ? v : "";
}

/**
 * LLM이 이미 있는 노드를 다시 addNode하면 기존 노드를 가리키도록 바꾼다(같은 라벨·같은 대표 이름).
 * 비어 있던 속성만 updateNode로 보강하고, 같은 변경안 뒤 연산의 ref는 기존 id로 바꾼다. 이미 있는 관계 추가는 버린다.
 */
export function dedupeAgainstGraph(
  ops: readonly GraphOp[],
  graph: CareerGraph,
): { ops: GraphOp[]; merged: string[]; remap: Record<string, string> } {
  const byKey = new Map<string, CareerGraph["nodes"][number]>();
  for (const n of graph.nodes) {
    const key = dedupeKey(n.label, n.props as Record<string, unknown>);
    if (key && !byKey.has(key)) byKey.set(key, n);
  }
  const remap = new Map<string, string>();
  const merged: string[] = [];
  const out: GraphOp[] = [];
  const edges = new Set(graph.edges.map((e) => e.id));
  const seenEdges = new Set<string>();

  for (const op of ops) {
    if (op.op === "addNode") {
      const key = dedupeKey(op.label, op.props as Record<string, unknown>);
      const existing = key ? byKey.get(key) : undefined;
      if (existing) {
        remap.set(op.ref, existing.id);
        merged.push(`${NODE_LABEL_META[op.label].name} '${titleOf(op.label, op.props as Record<string, unknown>)}'은(는) 이미 있어 기존 항목에 합쳤습니다`);
        const cur = existing.props as Record<string, unknown>;
        const fill: Record<string, unknown> = Object.fromEntries(
          Object.entries(op.props as Record<string, unknown>).filter(([k, v]) => k !== NODE_TITLE_KEY[op.label] && v !== undefined && (cur[k] === undefined || cur[k] === "")),
        );
        // 소재 분류는 비어 있지 않아도 합친다(기존 태그 + 새 태그).
        const next = (op.props as Record<string, unknown>).categories;
        if (Array.isArray(next) && Array.isArray(cur.categories)) {
          const { tags, overflow } = unionStoryTags(cur.categories, next);
          if (!sameTags(tags, cur.categories)) fill.categories = tags;
          if (overflow.length > 0) merged.push(overflowNote(existing, overflow));
        }
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
  return { ops: out, merged, remap: Object.fromEntries(remap) };
}

const knownTags = (xs: readonly unknown[]) => normalizeStoryTags(xs.filter((t): t is StoryTag => (STORY_TAGS as readonly unknown[]).includes(t)));

/**
 * 기존 태그 + 새 태그(STORY_TAGS 순서). 상한(MAX_STORY_TAGS)을 넘으면 기존 태그를 지키고, 넣지 못한 새 태그는 overflow로 돌려준다
 * (호출자가 사용자에게 알린다 — 기존 태그를 말없이 지우지 않는다).
 */
function unionStoryTags(current: readonly unknown[], next: readonly unknown[]): { tags: StoryTag[]; overflow: StoryTag[] } {
  const cur = knownTags(current);
  const added = knownTags(next).filter((t) => !cur.includes(t));
  const room = Math.max(0, MAX_STORY_TAGS - cur.length);
  return { tags: normalizeStoryTags([...cur, ...added.slice(0, room)]), overflow: added.slice(room) };
}

const sameTags = (a: readonly unknown[], b: readonly unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

const nodeTitle = (n: CareerGraph["nodes"][number]) => titleOf(n.label, n.props as Record<string, unknown>) || n.id;

function overflowNote(node: CareerGraph["nodes"][number], overflow: readonly StoryTag[]): string {
  return `'${nodeTitle(node)}'의 소재 분류는 최대 ${MAX_STORY_TAGS}개라 ${overflow.map(storyTagName).join(", ")}은(는) 넣지 않았습니다(기존 분류를 먼저 빼 주세요)`;
}

/**
 * LLM의 updateNode categories를 기존 태그에 맞춘다. 직접 편집(NodeForm)에는 쓰지 않는다.
 * - 보낸 태그가 기존 태그의 진부분집합이면 교체한다("리더십 태그 빼줘" → 남길 태그만 보냄). 변경안을 사용자가 확인하므로 드러난다.
 * - 그 밖에는 기존 태그와 합친다(LLM이 기존 태그를 빠뜨려도 지워지지 않게). 상한을 넘는 새 태그는 넣지 않고 notes에 남긴다.
 * - 결과가 기존과 같으면 그 속성을 빼고, 남은 속성이 없으면 연산째 빼며 notes에 남긴다. 삭제(null)는 그대로 둔다.
 * 같은 변경안에서 같은 노드를 여러 번 고치면 앞 연산의 결과를 기준으로 본다.
 */
export function mergeCategoryUpdates(ops: readonly GraphOp[], graph: CareerGraph): { ops: GraphOp[]; notes: string[] } {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const working = new Map<string, StoryTag[]>();
  const out: GraphOp[] = [];
  const notes: string[] = [];
  for (const op of ops) {
    if (op.op === "deleteNode") working.delete(op.id);
    if (op.op !== "updateNode") {
      out.push(op);
      continue;
    }
    const props = op.props as Record<string, unknown>;
    const node = byId.get(op.id);
    const stored = (node?.props as Record<string, unknown> | undefined)?.categories;
    const cur = working.get(op.id) ?? (Array.isArray(stored) ? knownTags(stored) : null);
    if (props.categories === null) working.set(op.id, []);
    if (!Array.isArray(props.categories) || !node || !cur || cur.length === 0) {
      if (Array.isArray(props.categories)) working.set(op.id, knownTags(props.categories));
      out.push(op);
      continue;
    }
    const sent = knownTags(props.categories);
    const isRemoval = sent.length > 0 && sent.length < cur.length && sent.every((t) => cur.includes(t));
    const notesBefore = notes.length;
    let next: StoryTag[];
    if (isRemoval) next = sent;
    else {
      const { tags, overflow } = unionStoryTags(cur, sent);
      next = tags;
      if (overflow.length > 0) notes.push(overflowNote(node, overflow));
    }
    working.set(op.id, next);
    const nextProps: Record<string, unknown> = { ...props, categories: next };
    if (sameTags(next, cur)) delete nextProps.categories;
    if (Object.keys(nextProps).length === 0) {
      if (notes.length === notesBefore) notes.push(`'${nodeTitle(node)}'의 소재 분류는 이미 그대로라 바꿀 것이 없습니다`);
      continue;
    }
    out.push({ ...op, props: nextProps } as GraphOp);
  }
  return { ops: out, notes };
}

/**
 * 현재 그래프 기준으로 연산을 하나씩 검사해(plan.ts — 적용 때와 같은 규칙) 통과하는 것만 남긴다.
 * 앞의 연산이 빠지면 그것을 참조하는 뒤 연산도 함께 빠진다. 버린 연산은 사유를 남긴다.
 */
export function validateAgainstGraph(
  ops: readonly GraphOp[],
  graph: CareerGraph,
  opts: { maxOps?: number } = {},
): { ops: GraphOp[]; dropped: string[] } {
  const existing = new Map<string, NodeLabel>(graph.nodes.map((n) => [n.id, n.label]));
  const kept: GraphOp[] = [];
  const dropped: string[] = [];
  let seq = 0;
  for (const op of ops) {
    try {
      planGraphOps(existing, [...kept, op], () => `__check${seq++}`, opts);
      kept.push(op);
    } catch (err) {
      if (!(err instanceof GraphOpError)) throw err;
      const reason = err.message.replace(/^변경 #\d+: /, "");
      dropped.push(`${describeGraphOp(op, graph, kept)} — ${reason}`);
    }
  }
  return { ops: kept, dropped };
}

export interface ProposalOptions {
  /** 연산 수 상한(기본 MAX_OPS_PER_BATCH, 문서 가져오기는 MAX_IMPORT_OPS). */
  maxOps?: number;
  /** 문서 가져오기: 문서 원문. 주면 삭제 연산을 빼고 문서에 없는 항목을 거른다(verifyAgainstDocument). */
  sourceText?: string;
  /** 프로젝트 단위 대화: 이 Project에 붙는 연산만 남긴다(restrictToFocus). */
  focusNodeId?: string | null;
  /** 남길 후속 질문 수(기본: 프로젝트 대화 1개, 그 밖 3개). GitHub 저장소 가져오기는 5개. */
  maxQuestions?: number;
  /** sourceText가 있을 때 data.source(기본 "document-import"). */
  sourceKind?: "document-import" | "repo-import";
}

/**
 * LLM 출력 → assistant 메시지(내용·data·상태)와 후속 질문 후보(followups — 저장은 호출자). 남은 연산이 없으면 상태 null(일반 답변).
 * 뺀 항목 중 질문으로 바꾼 것은 data.droppedFollowups(droppedOps 번호)로 표시한다.
 */
export function proposalFromOutput(
  output: GraphChatOutput,
  graph: CareerGraph,
  opts: ProposalOptions = {},
): { content: string; data: GraphProposalData; status: "proposed" | null; followups: FollowupCandidate[] } {
  const maxOps = opts.maxOps ?? MAX_OPS_PER_BATCH;
  const imported = opts.sourceText !== undefined;
  const converted = toGraphOps(output.ops, { max: maxOps });
  const noDeletes = imported ? dropDeletes(converted.ops, graph) : { ops: converted.ops, dropped: [] };
  const verified = imported ? verifyAgainstDocument(noDeletes.ops, opts.sourceText!) : { ops: noDeletes.ops, dropped: [], gaps: [] };
  const deduped = dedupeAgainstGraph(verified.ops, graph);
  // 가져오기는 기존 값을 지우거나 덮어쓰지 않는다(비어 있던 속성만 보강, 소재 분류는 합친다).
  const guarded = imported ? guardImportUpdates(deduped.ops, graph) : { ops: deduped.ops, dropped: [] };
  const merged = mergeCategoryUpdates(guarded.ops, graph);
  const focused = opts.focusNodeId ? restrictToFocus(merged.ops, graph, opts.focusNodeId) : { ops: merged.ops, dropped: [] };
  const validated = validateAgainstGraph(focused.ops.slice(0, maxOps), graph, { maxOps });
  const droppedOps = [
    ...noDeletes.dropped,
    ...verified.dropped,
    ...guarded.dropped,
    ...converted.errors,
    ...merged.notes,
    ...focused.dropped,
    ...validated.dropped,
  ];
  // 프로젝트 단위 대화는 한 번에 한 질문만(P2) — 서버에서도 자른다.
  const asked = output.followUpQuestions
    .map((q, i) => ({ q: q.trim(), topics: output.followUpTopics?.[i] ?? "" }))
    .filter((x) => x.q)
    .slice(0, opts.maxQuestions ?? (opts.focusNodeId ? 1 : 3));
  const followUpQuestions = asked.map((x) => x.q);
  const allDropped = droppedOps.length > 0 || deduped.merged.length > 0 ? [...deduped.merged, ...droppedOps].slice(0, imported ? 40 : 20) : [];

  // 후속 질문 후보: 뺀 항목 중 사용자가 채울 수 있는 것(근거·기간·수치) + 변경안의 후속 질문.
  const focus = opts.focusNodeId ?? null;
  const before = { graph, batch: converted.ops };
  const newProjectRefs = new Set(validated.ops.flatMap((o) => (o.op === "addNode" && o.label === "Project" ? [o.ref] : [])));
  // 새 Project ref는 최종 변경안에 남았을 때만 귀속에 쓴다(적용할 때 id로 바뀐다).
  const keepRef = (c: FollowupCandidate): FollowupCandidate => (c.projectRef && !newProjectRefs.has(c.projectRef) ? { ...c, projectRef: null, targetItem: null } : c);
  const shown = new Set(allDropped.map(clipFollowupDetail));
  const droppedCands = dedupeCandidates([
    ...(imported ? questionsFromEvidenceGaps(verified.gaps, before, focus) : []),
    ...questionsFromFormatErrors(converted.errors, output.ops, before, focus),
  ])
    // 화면에 보이는 뺀 항목만(상한으로 잘린 줄은 질문으로도 만들지 않는다).
    .filter((c) => c.detail !== null && shown.has(c.detail))
    .slice(0, MAX_DROPPED_FOLLOWUPS_PER_PROPOSAL)
    .map(keepRef);
  const questionCands = questionsFromFollowUps(
    followUpQuestions,
    validated.ops,
    { graph, batch: validated.ops },
    focus,
    asked.map((x) => x.topics),
  );
  const followups = dedupeCandidates([...questionCands, ...droppedCands]);
  const droppedAsked = new Set(droppedCands.map((c) => c.detail));
  const droppedFollowups = allDropped.flatMap((d, i) => (droppedAsked.has(clipFollowupDetail(d)) ? [i] : []));

  const data: GraphProposalData = {
    kind: "graph-proposal",
    ...(imported ? { source: opts.sourceKind ?? ("document-import" as const) } : {}),
    ops: validated.ops,
    summary: validated.ops.length > 0 ? output.summary.trim().slice(0, 300) || `${validated.ops.length}개 변경` : "",
    followUpQuestions,
    ...(allDropped.length > 0 ? { droppedOps: allDropped } : {}),
    ...(droppedFollowups.length > 0 ? { droppedFollowups } : {}),
  };
  const emptyReply = !imported
    ? "알겠습니다."
    : opts.sourceKind === "repo-import"
      ? "저장소에서 그래프에 넣을 항목을 찾지 못했습니다."
      : "문서에서 그래프에 넣을 항목을 찾지 못했습니다.";
  const content = output.reply.trim() || (validated.ops.length > 0 ? "말씀하신 내용으로 변경안을 만들었어요. 확인 후 적용해 주세요." : emptyReply);
  return { content: content.slice(0, 8000), data, status: validated.ops.length > 0 ? "proposed" : null, followups };
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
  applyOps(userId: string, ops: GraphOp[], opts?: { maxOps?: number }): Promise<ApplyGraphOpsResult>;
  /** usage: 토큰 사용량을 매길 사용자(llm_usage_events). */
  createClient(provider: ProviderId, usage: LlmUsageContext): LlmClient;
  now(): number;
}

export const defaultGraphChatDeps: GraphChatDeps = {
  getGraph: (userId, personName) => getCareerGraph(userId, { personName }),
  applyOps: (userId, ops, opts) => applyGraphOps(userId, ops, opts),
  createClient: (provider, usage) => createLlmClient(provider, usage),
  now: () => Date.now(),
};

function assertGraphEnabled(): void {
  if (!graphEnabled()) throw new GraphUnavailableError();
}

/** 내 스레드이고 종류가 맞아야 한다(아니면 404). 그래프에 묻기(graph-qa.ts)도 쓴다. */
export async function requireThread(userId: string, threadId: string, kind: ChatThreadKind): Promise<ChatThread> {
  const thread = await getThread(userId, threadId);
  if (!thread || thread.kind !== kind) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  return thread;
}

function requireGraphThread(userId: string, threadId: string): Promise<ChatThread> {
  return requireThread(userId, threadId, "graph");
}

export function listGraphThreads(userId: string): Promise<ChatThread[]> {
  return listThreads(userId, { kind: "graph" });
}

export function createGraphThread(userId: string, title?: string | null): Promise<ChatThread> {
  const t = title?.replace(/\s+/g, " ").trim().slice(0, 80);
  return createThread({ userId, kind: "graph", title: t || DEFAULT_THREAD_TITLE });
}

/** 프로젝트 단위 대화 새 스레드: 그 Project가 내 그래프에 있어야 한다(없으면 404). 제목은 프로젝트 이름. */
export async function createFocusedGraphThread(
  userId: string,
  projectId: string,
  deps: Pick<GraphChatDeps, "getGraph"> = defaultGraphChatDeps,
): Promise<ChatThread> {
  assertGraphEnabled();
  const graph = await deps.getGraph(userId, null);
  const structure = assessProjectStructure(graph, projectId);
  if (!structure) throw new FeatureError("프로젝트를 찾을 수 없습니다. 그래프를 새로 고친 뒤 다시 시도해 주세요.", 404);
  const title = structure.projectName.replace(/\s+/g, " ").trim().slice(0, 80) || DEFAULT_THREAD_TITLE;
  return createThread({ userId, kind: "graph", title, focusNodeId: projectId });
}

/**
 * 프로젝트 단위 대화 열기: 그 프로젝트의 가장 최근 대화가 있으면 그것을, 없으면 새로 만든다. 목록(최근 50개)에 없는 오래된 대화도
 * 서버에서 찾으므로 같은 프로젝트 대화가 겹쳐 생기지 않는다. 프로젝트가 그래프에 없으면 404.
 */
export async function openFocusedGraphThread(
  userId: string,
  projectId: string,
  deps: Pick<GraphChatDeps, "getGraph"> = defaultGraphChatDeps,
  /** preferThreadId: 이 사용자의 그 프로젝트 대화면 그 대화를 쓴다(지금 보고 있는 대화에 이어 쓰기). 아니면 가장 최근 대화. */
  opts: { preferThreadId?: string | null } = {},
): Promise<{ thread: ChatThread; created: boolean }> {
  assertGraphEnabled();
  const graph = await deps.getGraph(userId, null);
  if (!assessProjectStructure(graph, projectId)) {
    throw new FeatureError("프로젝트를 찾을 수 없습니다. 그래프를 새로 고친 뒤 다시 시도해 주세요.", 404);
  }
  if (opts.preferThreadId) {
    const preferred = await getThread(userId, opts.preferThreadId);
    if (preferred && preferred.kind === "graph" && preferred.focusNodeId === projectId) return { thread: preferred, created: false };
  }
  const [latest] = await listThreads(userId, { kind: "graph", focusNodeId: projectId, limit: 1 });
  if (latest) return { thread: latest, created: false };
  return { thread: await createFocusedGraphThread(userId, projectId, { getGraph: async () => graph }), created: true };
}

export async function renameGraphThread(userId: string, threadId: string, title: string): Promise<ChatThread> {
  await requireGraphThread(userId, threadId);
  const t = title.replace(/\s+/g, " ").trim().slice(0, 80);
  if (!t) throw new FeatureError("대화 제목을 입력해 주세요.", 400);
  await renameThread(userId, threadId, t);
  return requireGraphThread(userId, threadId);
}

/**
 * 화면용 메시지: 변경안 연산을 사람이 읽을 줄로 함께 내려 준다.
 * stillAnswered: data.resolvedFollowups 중 이 답변이 answered로 바꾼 상태 그대로인 질문 id(되돌리기 대상) — 처리 시각이 답변 저장 직후인 것만
 *   (나중에 다른 변경안·체크리스트로 다시 answered가 된 질문은 되돌리지 않는다). reopened: 그중 지금 열린 질문 id. 표시가 있을 때만.
 */
export type GraphChatMessageView = ChatMessage & { opLines?: string[]; stillAnswered?: string[]; reopened?: string[] };

/** 답변 저장 시각 기준으로 이 답변이 정리한 것으로 보는 처리 시각 범위(ms). 답변 저장 직후 바로 answered로 바꾼다. */
const REPLY_RESOLVE_WINDOW = { before: 5_000, after: 60_000 } as const;

/** 프로젝트 단위 대화의 프로젝트 상태. 그래프를 읽지 못하면 exists=null(알 수 없음), 지워졌으면 false. */
export interface GraphThreadFocus {
  nodeId: string;
  exists: boolean | null;
  structure: ProjectStructure | null;
}

export interface GraphThreadView extends ThreadReplyState {
  thread: ChatThread;
  messages: GraphChatMessageView[];
  /** 프로젝트 단위 대화일 때만. */
  focus?: GraphThreadFocus;
  /** 프로젝트 대화이고 그 프로젝트에 GitHub 저장소를 이었을 때만. */
  repo?: GithubThreadRepo;
  /**
   * 후속 질문: 프로젝트 대화면 그 프로젝트의 열린·건너뛴 질문, 일반 대화면 프로젝트 미지정의 열린 질문(오래된 것부터).
   * 읽지 못하면 빈 목록(대화는 보여 준다).
   */
  followups: GraphFollowup[];
}

/** 화면에 내려 주는 후속 질문 수 상한. */
const VIEW_FOLLOWUPS_LIMIT = 100;

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
  if ((withOps.length > 0 || thread.focusNodeId) && graphEnabled()) {
    // 노드 이름·구조화 진행도 표시용일 뿐이라 그래프를 못 읽어도 대화는 보여 준다.
    graph = await deps.getGraph(userId, personName).catch(() => null);
  }
  // 답변이 바로 답함으로 정리한 후속 질문의 지금 상태(되돌리기 링크용). 읽지 못하면 되돌리기를 숨긴다.
  const resolvedIds = messages.flatMap((m) => (m.data?.kind === "graph-proposal" ? (m.data.resolvedFollowups?.items.map((f) => f.id) ?? []) : []));
  const statuses: Map<string, { status: FollowupStatus; resolvedAt: number | null }> = await followupStatuses(userId, resolvedIds).catch(
    () => new Map(),
  );
  const view: GraphChatMessageView[] = messages.map((m) => {
    // 읽어 낸 문서 글은 폴링마다 내려보내지 않는다(파일 이름·글자 수만).
    if (m.data?.kind === "document-import") return { ...m, data: { ...m.data, text: "" } };
    if (m.data?.kind !== "graph-proposal") return m;
    const note = m.data.resolvedFollowups;
    const byThisReply = (id: string) => {
      const st = statuses.get(id);
      return (
        st?.status === "answered" &&
        st.resolvedAt !== null &&
        st.resolvedAt >= m.createdAt - REPLY_RESOLVE_WINDOW.before &&
        st.resolvedAt <= m.createdAt + REPLY_RESOLVE_WINDOW.after
      );
    };
    const stillAnswered = note
      ? {
          stillAnswered: note.items.filter((f) => byThisReply(f.id)).map((f) => f.id),
          reopened: note.items.filter((f) => statuses.get(f.id)?.status === "open").map((f) => f.id),
        }
      : {};
    if (m.data.ops.length === 0) return { ...m, ...stillAnswered };
    const ops = m.data.ops;
    return { ...m, ...stillAnswered, opLines: ops.map((op) => describeGraphOp(op, graph, ops)) };
  });
  let focus: GraphThreadFocus | undefined;
  if (thread.focusNodeId) {
    const structure = graph ? assessProjectStructure(graph, thread.focusNodeId) : null;
    focus = { nodeId: thread.focusNodeId, exists: graph ? structure !== null : null, structure };
  }
  const snapshot = thread.focusNodeId
    ? await snapshotForProject(userId, thread.focusNodeId).catch((err) => {
        console.error("[graph-chat github]", threadId, err);
        return null;
      })
    : null;
  const includePrivateOk = snapshot?.private ? await includePrivateAllowed(userId).catch(() => false) : false;
  if (thread.focusNodeId && graph) {
    // 이미 채운 것·이미 답한 것을 바꿔 묻는 열린 질문을 정리한 뒤 보여 준다(예전에 쌓인 중복도 여기서 사라진다).
    const g = graph;
    await Promise.resolve()
      .then(() => reconcileProjectFollowups(userId, assertGraphOwner(g, userId), [thread.focusNodeId!]))
      .catch((err) => console.error("[graph-chat followups]", threadId, err));
  }
  const followups = await listFollowups(
    userId,
    thread.focusNodeId
      ? { projectNodeId: thread.focusNodeId, statuses: ["open", "skipped"], limit: VIEW_FOLLOWUPS_LIMIT }
      : { projectNodeId: null, statuses: ["open"], limit: VIEW_FOLLOWUPS_LIMIT },
  ).catch((err) => {
    console.error("[graph-chat followups]", threadId, err);
    return [];
  });
  return {
    thread,
    messages: view,
    ...replyState(messages, deps.now()),
    ...(focus ? { focus } : {}),
    ...(snapshot ? { repo: threadRepoView(snapshot, deps.now(), includePrivateOk) } : {}),
    followups,
  };
}

/**
 * 사용자 메시지를 저장한다(답변은 runGraphChatReply). 답을 기다리는 중이면 409.
 * followupId를 주면 그 후속 질문에 대한 답으로 저장한다(data.kind='followup-answer') — 열린 내 질문이어야 하고(없으면 404, 이미 답했거나
 * 건너뛰었으면 409), 프로젝트 대화에서는 그 프로젝트의 질문이거나 미지정 질문이어야 한다(400).
 */
export async function startGraphChatMessage(
  userId: string,
  threadId: string,
  text: string,
  deps: Pick<GraphChatDeps, "now"> = defaultGraphChatDeps,
  opts: { followupId?: string | null } = {},
): Promise<ChatMessage> {
  assertGraphEnabled();
  let data: FollowupAnswerData | null = null;
  if (opts.followupId) {
    const thread = await requireGraphThread(userId, threadId);
    const item = await getFollowup(userId, opts.followupId);
    if (!item) throw new FeatureError("후속 질문을 찾을 수 없습니다.", 404);
    if (item.status !== "open") throw new FeatureError("이미 답했거나 건너뛴 후속 질문입니다. 다시 열고 답해 주세요.", 409);
    if (thread.focusNodeId && item.projectNodeId && item.projectNodeId !== thread.focusNodeId) {
      throw new FeatureError("다른 프로젝트의 후속 질문입니다. 그 프로젝트 대화에서 답해 주세요.", 400);
    }
    data = { kind: "followup-answer", followupId: item.id, question: item.text };
  }
  return startUserMessage(userId, threadId, { content: text, data, title: text, kind: "graph", limit: GRAPH_CHAT_LIMIT }, deps);
}

/**
 * 이력서·포트폴리오 가져오기: 읽어 낸 글을 사용자 메시지(data.kind='document-import')로 저장한다(답변은 runGraphChatReply).
 * 원본 파일은 저장하지 않는다. 답을 기다리는 중이면 409, 하루 상한(GRAPH_IMPORT_LIMIT)을 넘으면 429.
 */
export async function startGraphImportMessage(
  userId: string,
  threadId: string,
  doc: ParsedImport,
  deps: Pick<GraphChatDeps, "now"> = defaultGraphChatDeps,
): Promise<ChatMessage> {
  assertGraphEnabled();
  const thread = await requireGraphThread(userId, threadId);
  if (thread.focusNodeId) throw new FeatureError("프로젝트 대화에서는 이력서·포트폴리오를 가져올 수 없습니다. 일반 대화에서 가져와 주세요.", 400);
  const { content, data } = importMessage(doc);
  const title = `자료 가져오기: ${doc.fileName ?? DOC_KIND_NAMES[doc.docKind]}`;
  return startUserMessage(userId, threadId, { content, data, title, kind: "graph", limit: GRAPH_IMPORT_LIMIT }, deps);
}

/**
 * 사용자 메시지 저장 공통: 스레드 확인 → 대기 중이면 409 → 레이트 리밋(429) → 마지막 메시지가 그대로일 때만 삽입(동시 전송 409)
 * → 기본 제목이면 바꾼다. 그래프에 묻기(graph-qa.ts)도 쓴다.
 */
export async function startUserMessage(
  userId: string,
  threadId: string,
  input: {
    content: string;
    data: DocumentImportData | FollowupAnswerData | RepoImportData | null;
    title: string;
    kind: ChatThreadKind;
    limit: DbRateLimit;
    defaultTitle?: string;
  },
  deps: Pick<GraphChatDeps, "now">,
): Promise<ChatMessage> {
  const thread = await requireThread(userId, threadId, input.kind);
  const recent = (await listMessages(userId, threadId, { limit: 1 })) ?? [];
  if (replyState(recent, deps.now()).pending) {
    throw new FeatureError("이전 메시지의 답변을 만드는 중입니다. 잠시 후 다시 보내 주세요.", 409);
  }
  // 사용자당 전송 상한(DB 원장 — 인스턴스 사이에 공유된다).
  await assertWithinLimit(input.limit, userId);
  // 대기 검사와 삽입을 한 문장으로: 읽은 뒤 다른 요청(다른 탭·두 번 클릭)이 먼저 메시지를 넣었으면 409.
  const msg = await addMessage(
    userId,
    { threadId, role: "user", content: input.content, data: input.data },
    { expectLastId: recent.at(-1)?.id ?? null },
  ).catch(rethrowConcurrent);
  if (!msg) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  if (thread.title === (input.defaultTitle ?? DEFAULT_THREAD_TITLE)) {
    await renameThread(userId, threadId, input.title.replace(/\s+/g, " ").trim().slice(0, 40));
  }
  return msg;
}

/** DB 레이트 리밋을 한 번 센다. 넘으면 429. */
export async function assertWithinLimit(rule: DbRateLimit, userId: string): Promise<void> {
  const limit = await hitDbLimit(rule, userId);
  if (!limit.ok) {
    const wait = limit.retryAfterSec >= 3600 ? `${Math.ceil(limit.retryAfterSec / 3600)}시간` : `${Math.ceil(limit.retryAfterSec / 60)}분`;
    throw new FeatureError(`요청을 너무 자주 보냈습니다. ${wait} 뒤 다시 시도해 주세요.`, 429);
  }
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
  // 사용자당 전송 상한(DB 원장 — 인스턴스 사이에 공유된다). 문서 가져오기 재시도는 가져오기 하루 상한도 센다.
  if (lastUser.data?.kind === "document-import") await assertWithinLimit(GRAPH_IMPORT_LIMIT, userId);
  if (lastUser.data?.kind === "repo-import") await assertWithinLimit(GITHUB_IMPORT_LIMIT, userId);
  await assertWithinLimit(GRAPH_CHAT_LIMIT, userId);
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
  // 문서·저장소 가져오기 메시지는 data까지, 후속 질문에 대한 답은 그 질문 연결까지 다시 보낸다.
  const data =
    lastUser.data?.kind === "document-import" || lastUser.data?.kind === "followup-answer" || lastUser.data?.kind === "repo-import"
      ? lastUser.data
      : null;
  const msg = await addMessage(userId, { threadId, role: "user", content: lastUser.content, data }, { expectLastId: lastId }).catch(
    rethrowConcurrent,
  );
  if (!msg) throw new FeatureError("대화를 찾을 수 없습니다.", 404);
  return msg;
}

export function rethrowConcurrent(err: unknown): never {
  if (err instanceof ConcurrentMessageError) {
    throw new FeatureError("이전 메시지의 답변을 만드는 중입니다. 잠시 후 다시 보내 주세요.", 409);
  }
  throw err;
}

/** 사용자에게 보일 답변 실패 사유. */
export function replyErrorMessage(err: unknown, opts: { timedOut?: boolean; documentImport?: boolean } = {}): string {
  if (err instanceof LlmPermanentError) return `답변을 만들지 못했습니다. ${stageErrorMessage(err).replace("이 단계의 ", "")}`;
  if (err instanceof GraphUnavailableError) return `답변을 만들지 못했습니다. ${err.message}`;
  // Anthropic SDK는 중단을 APIUserAbortError(name은 'Error')로 던진다 — 이름 대신 클래스·넘긴 signal 상태로 판정한다.
  if (
    opts.timedOut ||
    err instanceof Anthropic.APIUserAbortError ||
    (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError"))
  ) {
    return opts.documentImport
      ? "문서를 정리하는 데 시간이 너무 오래 걸려 중단했습니다. 문서를 나눠 붙여넣어 주세요."
      : "답변 시간이 너무 오래 걸려 중단했습니다. 메시지를 짧게 나눠 다시 보내 주세요.";
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
  opts: { startedAt?: number } = {},
): Promise<ChatMessage | null> {
  const messages = await listMessages(userId, threadId, { limit: 40 });
  const latest = messages?.at(-1);
  if (!messages || !latest || latest.role !== "user") return null;
  // 요청 시작 시각(라우트 핸들러 진입)부터 REPLY_TIMEOUT_MS. 없으면 지금부터.
  const deadlineAt = (opts.startedAt ?? Date.now()) + REPLY_TIMEOUT_MS;
  const deadline = AbortSignal.timeout(Math.max(0, deadlineAt - Date.now()));
  const doc = latest.data?.kind === "document-import" ? latest.data : null;
  const repoImport = latest.data?.kind === "repo-import" ? latest.data : null;
  try {
    deadline.throwIfAborted();
    const focusNodeId = (await getThread(userId, threadId))?.focusNodeId ?? null;
    // 프롬프트에 넣을 그래프는 이 사용자 것이어야 한다(다른 사용자 표시면 LLM을 부르지 않고 실패로 남긴다).
    const graph = assertGraphOwner(await untilAborted(deps.getGraph(userId, personName), deadline), userId);
    if ((focusNodeId && !doc && !assessProjectStructure(graph, focusNodeId)) || (repoImport && !focusNodeId)) {
      // 구조화하던 프로젝트가 지워졌다: LLM을 부르지 않고 안내만 남긴다.
      return await addMessage(
        userId,
        { threadId, role: "assistant", content: FOCUS_MISSING_REPLY, data: null, status: null },
        { expectLastId: latest.id },
      );
    }
    // 후속 질문에 대한 답이면: 그 질문(아직 열려 있을 때만)과, 프로젝트 대화면 그 프로젝트의 남은 열린 질문을 프롬프트에 넣는다.
    const answering = latest.data?.kind === "followup-answer" ? await getFollowup(userId, latest.data.followupId).catch(() => null) : null;
    // 이 대화 범위의 프로젝트: 프로젝트 대화면 그 프로젝트, 일반 대화면 답하는 질문의 프로젝트 + 최근 메시지에서 이름이 나온 프로젝트.
    const scopeProjects = focusNodeId
      ? [focusNodeId]
      : [...new Set([...(answering?.projectNodeId ? [answering.projectNodeId] : []), ...mentionedProjectIds(graph, latest.content)])];
    // 이미 채운 것·이미 답한 것을 바꿔 묻는 열린 질문을 먼저 정리한다(적용된 그래프 기준 — 확인 대기 변경안으로는 상태를 바꾸지 않는다).
    if (!doc && !repoImport) {
      await reconcileProjectFollowups(userId, graph, scopeProjects).catch((err) => console.error("[graph-chat followups]", threadId, err));
    }
    const currentRow = answering ? await getFollowup(userId, answering.id).catch(() => null) : null;
    const current = currentRow?.status === "open" ? currentRow : null;
    // 확인 대기 중인 변경안까지 얹은 그래프: 이미 들은 것(아직 적용 전)도 다시 묻지 않게 판정할 때만 쓴다.
    const pendingGraph = withPendingProposals(graph, messages);
    // 이 대화에서 이미 답한 질문(변경안을 아직 적용하지 않았거나 "모르겠어요"로 끝난 것)은 다시 묻지 않는다(P2) — 사용자가 목록에서 골라 답할 수 있다.
    const answeredHere = followupIdsAnsweredIn(messages);
    const pendingFilled = focusNodeId ? filledTopics(pendingGraph, focusNodeId) : new Set<never>();
    const rest = focusNodeId
      ? (await listFollowups(userId, { projectNodeId: focusNodeId, statuses: ["open"], limit: 20 }).catch(() => []))
          .filter((f) => f.id !== current?.id && !answeredHere.has(f.id))
          // 확인 대기 변경안이 이미 채우는 것을 묻는 질문은 넣지 않는다(상태는 그대로 — 거절하면 다시 묻는다).
          .filter((f) => f.kind !== "question" || coverOf(f.text, followupTopicKeys(f.text), pendingFilled, []).kind === "new")
          .map((f) => f.text)
      : [];
    const history = scopeProjects.length > 0 ? await recentProjectFollowups(userId, scopeProjects).catch(() => []) : [];
    // GitHub 저장소: 가져오기 메시지면 그 저장소, 이후 대화면 이 프로젝트에 이은 저장소(비공개는 지금도 허용한 경우만).
    let repo: RepoSnapshot | null = null;
    if (repoImport) {
      repo = await loadAllowedSnapshot(userId, () => snapshotByRepoId(userId, repoImport.repoId));
      if (!repo) {
        return await addMessage(
          userId,
          { threadId, role: "assistant", content: REPO_MISSING_REPLY, data: null, status: "failed" },
          { expectLastId: latest.id },
        );
      }
    } else if (focusNodeId && !doc) {
      repo = await loadAllowedSnapshot(userId, () => snapshotForProject(userId, focusNodeId));
    }
    const client = deps.createClient(provider, { userId, referenceId: threadId });
    let proposal: ReturnType<typeof proposalFromOutput>;
    let promptFollowups: PromptFollowup[] = [];
    let answered: PromptFollowup[] = [];
    let usage;
    if (repoImport && repo && focusNodeId) {
      // GitHub 저장소로 이 프로젝트 정리: 저장소 요약만 근거로(문서 가져오기와 같은 검증), 연산 40개·질문 5개까지.
      const prompt = buildRepoImportPrompt({ graph, focusProjectId: focusNodeId, brief: repo.brief, today: new Date(deps.now()) });
      const res = await client.generate({
        task: "graph-repo-import",
        system: prompt.system,
        user: prompt.user,
        schema: GraphRepoImportOutputSchema,
        effort: "medium",
        signal: deadline,
      });
      usage = res.usage;
      proposal = proposalFromOutput(res.output, graph, {
        maxOps: MAX_REPO_IMPORT_OPS,
        sourceText: repo.brief,
        focusNodeId,
        maxQuestions: MAX_REPO_IMPORT_QUESTIONS,
        sourceKind: "repo-import",
      });
    } else if (doc) {
      // 이력서·포트폴리오 가져오기: 문서 원문만 근거로, 연산 상한 MAX_IMPORT_OPS.
      const prompt = buildGraphImportPrompt({ graph, doc, today: new Date(deps.now()) });
      const res = await client.generate({
        task: "graph-import",
        system: prompt.system,
        user: prompt.user,
        schema: GraphImportOutputSchema,
        effort: "medium",
        signal: deadline,
      });
      usage = res.usage;
      proposal = proposalFromOutput(res.output, graph, { maxOps: MAX_IMPORT_OPS, sourceText: doc.text });
    } else {
      // 열린 후속 질문(이 대화 범위)을 짧은 id로 넣는다 — 최근 메시지가 답한 것은 LLM이 answeredFollowups로 표시한다. 읽지 못하면 넣지 않는다.
      promptFollowups = toPromptFollowups(
        await openFollowupsForPrompt(
          userId,
          {
            focusProjectId: focusNodeId,
            mentionedProjectIds: focusNodeId ? [] : mentionedProjectIds(graph, latest.content),
            currentId: current?.id ?? null,
          },
          MAX_PROMPT_FOLLOWUPS,
        ).catch((err) => {
          console.error("[graph-chat followups]", threadId, err);
          return [];
        }),
        graph,
      );
      const prompt = buildGraphChatPrompt({
        graph,
        messages,
        latestMessage: latest.content,
        today: new Date(deps.now()),
        focusProjectId: focusNodeId,
        followups: { current: current?.text ?? null, rest },
        repoBrief: repo?.brief ?? null,
        openFollowups: promptFollowups,
        asked: scopeProjects.flatMap((pid) => askedSummary(graph, pendingGraph, pid, history) ?? []),
      });
      const res = await client.generate({
        task: "graph-chat",
        system: prompt.system,
        user: prompt.user,
        schema: GraphChatOutputSchema,
        effort: "medium",
        signal: deadline,
      });
      usage = res.usage;
      proposal = proposalFromOutput(res.output, graph, { focusNodeId });
      answered = resolveAnsweredKeys(res.output.answeredFollowups, promptFollowups);
    }
    // 새 후속 질문 가리기: 이 답변의 변경안까지 얹은 그래프에 이미 있는 것, 이미 답한·건너뛴 질문, 열린 질문과 같은 것을 바꿔 묻는 질문은
    // 쌓지도 보이지도 않는다(열린 질문과 같으면 그 질문으로 바꿔 묻는다). 지금 답하는 질문·이 답변이 답했다고 표시한 질문은 답한 것으로 본다.
    const afterGraph = overlayGraphOps(pendingGraph, proposal.data.ops, "reply:");
    const guardProjects = [
      ...new Set([...scopeProjects, ...proposal.followups.flatMap((c) => (!c.projectRef && c.projectNodeId ? [c.projectNodeId] : []))]),
    ];
    const extra = guardProjects.filter((pid) => !scopeProjects.includes(pid));
    const resolvedNow = new Set([...(current ? [current.id] : []), ...answered.map((f) => f.id)]);
    const existing = [...history, ...(extra.length > 0 ? await recentProjectFollowups(userId, extra).catch(() => []) : [])].map((e) =>
      resolvedNow.has(e.id) ? { ...e, status: "answered" as const } : e,
    );
    const guarded = guardFollowupQuestions({
      questions: proposal.data.followUpQuestions,
      candidates: proposal.followups,
      graph: afterGraph,
      existing,
      focusProjectId: doc ? null : focusNodeId,
      skipIds: answeredHere,
    });
    proposal.data.followUpQuestions = guarded.questions;
    proposal.followups = guarded.candidates;
    // 변경안이 있으면 답한 후속 질문을 단다(적용하면 answered).
    const data: GraphProposalData = current && proposal.status === "proposed" ? { ...proposal.data, followupId: current.id } : proposal.data;
    if (answered.length > 0) {
      data.resolvedFollowups = { messageId: latest.id, items: answered.map((f) => ({ id: f.id, text: f.text })) };
    }
    // 저장 직전에도 마지막 메시지가 여전히 이 사용자 메시지일 때만 답을 단다(중복 실행·그 사이 새 메시지면 버린다).
    const saved = await addMessage(
      userId,
      { threadId, role: "assistant", content: proposal.content, data, status: proposal.status, usage },
      { expectLastId: latest.id },
    );
    if (saved && data.resolvedFollowups) await resolveAnsweredInReply(userId, saved, data);
    // 방금 답함으로 정리한 질문과 같은 글의 후보는 다시 쌓지 않는다(열린 질문하고만 중복을 보므로 그대로 두면 같은 질문이 다시 열린다).
    const justAnswered = new Set(
      (saved?.data?.kind === "graph-proposal" ? (saved.data.resolvedFollowups?.items ?? []) : []).map((f) => normalizeFollowupText(f.text)),
    );
    const candidates = proposal.followups.filter((c) => !justAnswered.has(normalizeFollowupText(c.text)));
    if (saved && candidates.length > 0) {
      // 후속 질문 목록에 쌓는다. 실패해도 답변은 그대로 둔다.
      await saveProposalFollowups(userId, { threadId, messageId: saved.id, candidates, graph: afterGraph }).catch((err) =>
        console.error("[graph-chat followups]", threadId, err),
      );
    }
    return saved;
  } catch (err) {
    if (err instanceof ConcurrentMessageError) return null;
    if (!(err instanceof LlmPermanentError)) console.error("[graph-chat reply]", threadId, err);
    else console.warn(`[graph-chat reply] ${threadId} LLM 실패: ${err.reason}`);
    return addMessage(
      userId,
      {
        threadId,
        role: "assistant",
        content: replyErrorMessage(err, { timedOut: deadline.aborted, documentImport: doc !== null }),
        status: "failed",
        data: null,
      },
      { expectLastId: latest.id },
    ).catch(() => null);
  }
}

/**
 * 답변에서 LLM이 답했다고 표시한 후속 질문을 바로 answered로 바꾼다(변경안 적용과 무관). 그 사이 이미 처리된 질문은 빼고,
 * 바꾼 것이 줄었으면 메시지의 표시(resolvedFollowups)도 맞춘다. 실패해도 답변은 그대로 둔다(표시만 지운다).
 */
async function resolveAnsweredInReply(userId: string, saved: ChatMessage, data: GraphProposalData): Promise<void> {
  const note = data.resolvedFollowups!;
  let done: string[] = [];
  try {
    done = await markFollowupsAnswered(userId, note.items.map((f) => f.id));
  } catch (err) {
    console.error("[graph-chat followups]", saved.id, err);
  }
  if (done.length === note.items.length) return;
  const items = note.items.filter((f) => done.includes(f.id));
  const next: GraphProposalData = { ...data, resolvedFollowups: { ...note, items } };
  if (items.length === 0) delete next.resolvedFollowups;
  const updated = await updateMessage(userId, saved.id, { data: next }).catch(() => null);
  if (updated) Object.assign(saved, { data: updated.data });
}

/** 저장소 정보를 읽는다. 비공개 저장소는 지금도 비공개 허용을 켠 경우만. 읽지 못하면 null(대화는 저장소 없이 이어간다). */
async function loadAllowedSnapshot(userId: string, load: () => Promise<RepoSnapshot | null>): Promise<RepoSnapshot | null> {
  try {
    const snap = await load();
    if (!snap) return null;
    if (snap.private && !(await includePrivateAllowed(userId))) return null;
    return snap;
  } catch (err) {
    console.error("[graph-chat github]", err);
    return null;
  }
}

/** promise가 끝나거나 signal이 중단될 때까지 기다린다(중단되면 signal.reason으로 거부 — 원래 작업은 취소하지 못한다). */
export function untilAborted<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/**
 * 응답을 보낸 뒤 답변을 만든다(라우트 핸들러 안에서만 부른다). 실행 시간은 라우트 maxDuration을 따른다 —
 * startedAt(핸들러 진입 시각)을 넘기면 답변 마감을 그때부터 센다.
 */
export function scheduleGraphChatReply(
  userId: string,
  threadId: string,
  provider: ProviderId,
  personName: string | null,
  startedAt?: number,
): void {
  after(async () => {
    await runGraphChatReply(userId, threadId, provider, personName, defaultGraphChatDeps, { startedAt });
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
    const maxOps = msg.data.source === "document-import" ? MAX_IMPORT_OPS : msg.data.source === "repo-import" ? MAX_REPO_IMPORT_OPS : undefined;
    const result = await deps.applyOps(userId, deduped.ops, maxOps ? { maxOps } : undefined);
    const data: GraphProposalData = { ...msg.data, created: result.created };
    if (deduped.merged.length > 0) {
      const max = maxOps ? 40 : 20;
      data.ops = deduped.ops;
      data.droppedOps = [...deduped.merged, ...(msg.data.droppedOps ?? [])].slice(0, max);
      // 앞에 합친 줄이 끼어드니 '후속 질문에 추가' 번호도 그만큼 민다(잘린 줄은 버린다).
      const shifted = (msg.data.droppedFollowups ?? []).map((i) => i + deduped.merged.length).filter((i) => i < max);
      if (shifted.length > 0) data.droppedFollowups = shifted;
      else delete data.droppedFollowups;
    }
    const message = await updateMessage(userId, messageId, { data });
    // 지운 Project에 이어 둔 GitHub 저장소 연결을 푼다(Neo4j id라 FK가 없다).
    const deletedIds = deduped.ops.flatMap((o) => (o.op === "deleteNode" ? [o.id] : []));
    await unlinkDeletedProjects(userId, deletedIds).catch((err) => console.error("[graph-chat github]", messageId, err));
    await resolveFollowupsAfterApply(userId, messageId, deduped, result.created, msg.data.followupId ?? null, deps).catch((err) =>
      console.error("[graph-chat followups]", messageId, err),
    );
    return { message: message ?? claimed, result };
  } catch (err) {
    if (!(err instanceof GraphOpError)) {
      // 저장소 연결 문제 등: 그래프는 바뀌지 않았으므로 다시 적용할 수 있게 되돌리고 오류를 알린다.
      await updateMessage(userId, messageId, { status: "proposed" }).catch(() => null);
      throw err;
    }
    const reason = `${err.message} (그래프가 바뀌어 이 변경안을 그대로 적용할 수 없습니다. 다시 요청해 주세요.)`;
    const message = await updateMessage(userId, messageId, { status: "failed", data: { ...msg.data, error: reason } });
    // 만들지 못한 새 Project에 귀속한 질문은 미지정으로 돌린다(보이고 건너뛸 수 있게).
    await releasePendingRefs(userId, messageId).catch((e) => console.error("[graph-chat followups]", messageId, e));
    return { message: message ?? claimed, result: null };
  }
}

/**
 * 적용 뒤 후속 질문 정리: 새 Project ref → id(기존 Project로 합쳐졌으면 그 id), 답한 질문 answered, 이 변경안이 건드린 Project의
 * 목표 구조화 항목이 완료된 열린 질문 answered, 지운 Project의 질문은 미지정으로. 구조화 항목을 볼 질문이 있을 때만 그래프를 다시 읽는다.
 */
function resolveFollowupsAfterApply(
  userId: string,
  messageId: string,
  applied: { ops: readonly GraphOp[]; remap: Record<string, string> },
  created: Record<string, string>,
  followupId: string | null,
  deps: Pick<GraphChatDeps, "getGraph">,
): Promise<string[]> {
  const ids = { ...applied.remap, ...created };
  const resolve = (x: string) => ids[x] ?? x;
  const touched = new Set<string>();
  const deleted: string[] = [];
  for (const op of applied.ops) {
    if (op.op === "addNode") touched.add(resolve(op.ref));
    else if (op.op === "updateNode") touched.add(resolve(op.id));
    else if (op.op === "deleteNode") deleted.push(op.id);
    else {
      touched.add(resolve(op.from));
      touched.add(resolve(op.to));
    }
  }
  return onProposalApplied(userId, {
    messageId,
    created: ids,
    followupId,
    touchedNodeIds: [...touched],
    deletedNodeIds: deleted,
    loadGraph: () => deps.getGraph(userId, null),
  });
}

export async function dismissGraphProposal(userId: string, messageId: string): Promise<ChatMessage> {
  await requireProposal(userId, messageId);
  const message = await updateMessage(userId, messageId, { status: "dismissed" }, { expectStatus: "proposed" });
  if (!message) throw new FeatureError("이미 처리된 변경안입니다.", 409);
  // 거절한 변경안의 새 Project에 귀속한 질문은 미지정으로 돌린다(그 밖의 질문은 열린 채로 남는다).
  await releasePendingRefs(userId, messageId).catch((err) => console.error("[graph-chat followups]", messageId, err));
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
