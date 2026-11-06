import "server-only";
/**
 * 면접 연습 서비스. 이력서(+ 첨부 포트폴리오, + 연결 공고)로 근거 스냅숏을 만들고 LLM으로 예상 질문을 만든 뒤,
 * 답변마다 피드백·모범 답변 개요·꼬리 질문을 만든다. 저장은 ./store.ts, 근거 줄·인용 검증은 ./source.ts, 프롬프트는 ./prompts.ts.
 *
 * 흐름(그래프에 묻기·심사위원 채팅과 같은 after() 패턴):
 *   startInterviewSession → (라우트가 after(() => runInterviewGeneration(...)) 예약) → GET으로 상태 확인
 *   submitInterviewAnswer → (after(() => runInterviewFeedback(...))) → GET으로 상태 확인
 * 레이트 리밋: INTERVIEW_GENERATE_LIMIT(생성·다시 만들기), INTERVIEW_FEEDBACK_LIMIT + INTERVIEW_FEEDBACK_DAILY_LIMIT(답변·재시도).
 * 소유·입력 확인을 먼저 하고 레이트 리밋은 마지막에 센다(잘못된 요청이 한도를 깎지 않게).
 * LLM: generate({ task: 'interview-questions' | 'interview-feedback', ... }), 마감은 withLlmDeadline(INTERACTIVE_LLM_TIMEOUT_MS).
 */
import { FeatureError } from "@/lib/api/errors";
import {
  INTERVIEW_FEEDBACK_DAILY_LIMIT,
  INTERVIEW_FEEDBACK_LIMIT,
  INTERVIEW_GENERATE_LIMIT,
  hitDbLimit,
  type DbRateLimit,
} from "@/lib/auth/db-rate-limit";
import { prisma } from "@/lib/db/client";
import {
  estimateSpokenSeconds,
  INTERVIEW_CRITERIA,
  INTERVIEW_LIMITS,
  InterviewFeedbackOutputSchema,
  InterviewQuestionsOutputSchema,
  RECOMMENDED_ANSWER_SECONDS,
  type CreateInterviewSessionInput,
  type InterviewAnswerView,
  type InterviewFeedback,
  type InterviewFeedbackOutput,
  type InterviewQuestionCategory,
  type InterviewSessionSummary,
  type InterviewSourceLine,
  type InterviewSourceSnapshot,
  type SubmitInterviewAnswerInput,
} from "@/lib/domain/interview";
import { isProviderId, type ProviderId } from "@/lib/domain/providers";
import type { ResumeDocument } from "@/lib/domain/resumes";
import { createLlmClient, LlmPermanentError, modelNameFor, type LlmClient, type LlmUsageContext } from "@/lib/llm";
import { INTERACTIVE_LLM_TIMEOUT_MS, withLlmDeadline } from "@/lib/llm/deadline";
import { stageErrorMessage } from "@/lib/panel/runner";
import { getPosting } from "@/lib/postings/service";
import { listProviderOptions, resolveRequestedProvider } from "@/lib/providers/options";
import { getResumePortfolioText } from "@/lib/resumes/portfolio";
import { getResumeMeta, getVersionDocument } from "@/lib/resumes/service";
import { buildInterviewFeedbackPrompt, buildInterviewQuestionsPrompt, feedbackContextLines } from "./prompts";
import { normalizeGeneratedQuestions, resumeSourceLines, textSourceLines } from "./source";
import * as store from "./store";

export { buildInterviewFeedbackPrompt, buildInterviewQuestionsPrompt } from "./prompts";

export interface InterviewDeps {
  createClient?: (provider: ProviderId, usage: LlmUsageContext) => LlmClient;
  now?: () => number;
  /** LLM 대기 상한(기본 INTERACTIVE_LLM_TIMEOUT_MS). 테스트용. */
  timeoutMs?: number;
}

/** 질문 생성 호출 max_tokens(thinking 포함). 질문 40개 × 인용·꼬리 질문. */
export const QUESTIONS_MAX_TOKENS = 32_000;
export const FEEDBACK_MAX_TOKENS = 12_000;

/** 레이트 리밋 초과(라우트가 429 + Retry-After로 바꾼다). */
export class InterviewRateLimitError extends FeatureError {
  constructor(readonly retryAfterSec: number) {
    const wait = retryAfterSec >= 3600 ? `${Math.ceil(retryAfterSec / 3600)}시간` : `${Math.max(1, Math.ceil(retryAfterSec / 60))}분`;
    super(`요청을 너무 자주 보냈습니다. ${wait} 뒤 다시 시도해 주세요.`, 429);
    this.name = "InterviewRateLimitError";
  }
}

async function assertLimits(userId: string, ...rules: DbRateLimit[]): Promise<void> {
  for (const rule of rules) {
    const hit = await hitDbLimit(rule, userId);
    if (!hit.ok) throw new InterviewRateLimitError(hit.retryAfterSec);
  }
}

// ---------------------------------------------------------------------------
// 스냅숏 (순수)
// ---------------------------------------------------------------------------

/** 스냅숏 만들기 입력(순수). */
export interface BuildSnapshotInput {
  resume: InterviewSourceSnapshot["resume"];
  document: ResumeDocument;
  posting: (InterviewSourceSnapshot["posting"] & { jdText: string }) | null;
  /** 보관 공고가 없을 때 이력서에 붙여 둔 JD(있으면 공고 줄 j…로 넣는다). */
  fallbackJdText?: string | null;
  /** 포함하지 않으면 null. */
  portfolio: { kind: "file" | "url"; fileName: string | null; url: string | null; text: string | null } | null;
  now: number;
}

/** 이력서·포트폴리오·JD → 스냅숏(순수). resumeSourceLines + textSourceLines('portfolio'·'posting')를 이어 붙인다. */
export function buildSourceSnapshot(input: BuildSnapshotInput): InterviewSourceSnapshot {
  const lines: InterviewSourceLine[] = [...resumeSourceLines(input.document)];
  let portfolioTruncated = false;
  if (input.portfolio?.text?.trim()) {
    const p = textSourceLines("portfolio", input.portfolio.text);
    lines.push(...p.lines);
    portfolioTruncated = p.truncated;
  }
  const jd = input.posting?.jdText?.trim() || input.fallbackJdText?.trim() || "";
  if (jd) lines.push(...textSourceLines("posting", jd).lines);
  return {
    version: 1,
    resume: input.resume,
    posting: input.posting ? { id: input.posting.id, company: input.posting.company, roleTitle: input.posting.roleTitle, url: input.posting.url } : null,
    portfolio: input.portfolio
      ? { kind: input.portfolio.kind, fileName: input.portfolio.fileName, url: input.portfolio.url, truncated: portfolioTruncated }
      : null,
    lines: lines.slice(0, 1500),
    createdAt: input.now,
  };
}

// ---------------------------------------------------------------------------
// 엔진
// ---------------------------------------------------------------------------

/** 세션을 만든 엔진을 우선, 지금 쓸 수 없으면 사용 가능한 기본 엔진. */
async function pickSessionProvider(saved: string | null): Promise<ProviderId> {
  if (saved && isProviderId(saved)) {
    const options = await listProviderOptions();
    if (options.some((o) => o.id === saved && o.ready)) return saved;
  }
  return resolveRequestedProvider(null);
}

async function sessionProviderOf(userId: string, sessionId: string): Promise<string | null> {
  const row = await prisma.interviewSession.findFirst({ select: { provider: true }, where: { id: sessionId, userId } });
  return row?.provider ?? null;
}

/**
 * LLM 결과 저장은 한 번 더 시도한다(연결 풀 일시 오류·트랜잭션 시작 시간 초과로 이미 비용을 낸 결과를 잃지 않게).
 * 저장 함수가 runId·'pending' 조건으로 중복 쓰기를 막으므로 다시 불러도 안전하다.
 */
async function saveOnce<T>(save: () => Promise<T>): Promise<T> {
  try {
    return await save();
  } catch (err) {
    console.warn("[interview] 결과 저장 재시도", (err as Error).message?.slice(0, 200));
    await new Promise((r) => setTimeout(r, 1000));
    return save();
  }
}

/** 사용자에게 보여도 되는 실패 문구. */
export function interviewErrorMessage(err: unknown, what: "질문" | "피드백"): string {
  if (err instanceof FeatureError) return err.message;
  if (err instanceof LlmPermanentError) return `${what}을 만들지 못했습니다. ${stageErrorMessage(err).replace("이 단계의 ", "")}`;
  if (err instanceof Error && (err.name === "TimeoutError" || err.name === "AbortError")) {
    return `${what}을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요.`;
  }
  return `${what}을 만들지 못했습니다. 잠시 후 다시 시도해 주세요.`;
}

// ---------------------------------------------------------------------------
// 세션 시작·다시 만들기
// ---------------------------------------------------------------------------

/**
 * 세션 시작: 이력서·버전·공고 소유 확인 → 포트폴리오 텍스트 읽기 → 스냅숏 → 레이트 리밋(INTERVIEW_GENERATE_LIMIT) → 세션 행('generating') + 스냅숏 저장.
 * 반환한 runId로 라우트가 after(() => runInterviewGeneration(userId, session.id, runId, provider))를 예약한다.
 * 이력서가 없으면 FeatureError(404), 버전이 없거나 내용이 비었으면 409, 레이트 리밋이면 InterviewRateLimitError(429).
 */
export async function startInterviewSession(
  userId: string,
  input: CreateInterviewSessionInput,
  deps: Pick<InterviewDeps, "now"> = {},
): Promise<{ session: InterviewSessionSummary; runId: string; provider: ProviderId }> {
  const meta = await getResumeMeta(userId, input.resumeId);
  if (!meta) throw new FeatureError("이력서를 찾을 수 없습니다.", 404);
  const ver = await getVersionDocument(userId, input.resumeId, input.versionId ?? null);
  if (!ver) throw new FeatureError("이력서 버전을 찾을 수 없습니다. 이력서를 한 번 저장한 뒤 다시 시도해 주세요.", 409);

  // 공고: 생략하면 이력서의 연결 공고(지워졌으면 없이), null이면 없이, 값이면 내 보관 공고(없으면 404).
  let posting: BuildSnapshotInput["posting"] = null;
  const wantedPosting = input.postingId === undefined ? meta.postingId : input.postingId;
  if (wantedPosting) {
    const p = await getPosting(userId, wantedPosting);
    if (!p && input.postingId) throw new FeatureError("공고를 찾을 수 없습니다.", 404);
    if (p) posting = { id: p.id, company: p.company, roleTitle: p.roleTitle, url: p.url, jdText: p.jdText };
  }
  const fallbackJdText = input.postingId === null || posting ? null : meta.jdText;

  let portfolio: BuildSnapshotInput["portfolio"] = null;
  if (input.includePortfolio && meta.portfolio) {
    const got = await getResumePortfolioText(userId, input.resumeId);
    if (got?.info) {
      // 사용자가 적은 역할·결과 메모를 본문 앞에 둔다(링크만 있는 포트폴리오도 메모가 있으면 근거로 쓴다).
      const text = [got.info.description?.trim(), got.text?.trim()].filter(Boolean).join("\n\n") || null;
      portfolio = { kind: got.info.kind, fileName: got.info.fileName, url: got.info.url, text };
    }
  }

  const now = deps.now?.() ?? Date.now();
  const snapshot = buildSourceSnapshot({
    resume: {
      id: meta.id,
      title: meta.title,
      kind: meta.kind,
      company: meta.company,
      roleTitle: meta.roleTitle,
      versionId: ver.version.id,
      versionNo: ver.version.versionNo,
    },
    document: ver.document,
    posting,
    fallbackJdText,
    portfolio,
    now,
  });
  if (!snapshot.lines.some((l) => l.doc === "resume")) {
    throw new FeatureError("이력서에 질문의 근거로 쓸 내용이 없습니다. 경력·프로젝트를 먼저 채워 주세요.", 409);
  }

  const provider = await resolveRequestedProvider(input.provider ?? null);
  await assertLimits(userId, INTERVIEW_GENERATE_LIMIT);

  const company = posting?.company || meta.company;
  const role = posting?.roleTitle || meta.roleTitle;
  const targetLabel = company || role ? [company, role].filter(Boolean).join(" · ") : null;
  const { id, runId } = await store.createSessionRow(userId, {
    resumeId: meta.id,
    resumeVersionId: ver.version.id,
    postingId: posting?.id ?? null,
    title: input.title?.trim() || `${meta.title} 면접 연습`,
    resumeLabel: `${meta.title} · v${ver.version.versionNo}`,
    targetLabel,
    // 링크만 첨부한 포트폴리오는 내용을 읽지 않아 근거 줄이 없다. 근거로 들어간 줄이 있을 때만 '포트폴리오'로 표시한다.
    hasPortfolio: snapshot.lines.some((l) => l.doc === "portfolio"),
    hasPosting: snapshot.lines.some((l) => l.doc === "posting"),
    provider,
    model: modelNameFor(provider),
  });
  try {
    await store.saveSourceSnapshot(userId, id, snapshot);
  } catch (err) {
    console.error("[interview] 스냅숏 저장 실패", id, err);
    await store.failGeneration(id, runId, "근거 자료를 저장하지 못했습니다. 다시 만들어 주세요.");
    throw new FeatureError("근거 자료를 저장하지 못했습니다. 잠시 후 다시 시도해 주세요.", 503);
  }
  const session = await store.getSessionSummary(userId, id);
  if (!session) throw new FeatureError(store.INTERVIEW_SESSION_NOT_FOUND, 404);
  return { session, runId, provider };
}

/** 다시 만들기(같은 스냅숏으로): 소유 확인 → 레이트 리밋 → store.restartGeneration. 남의 세션이면 null. */
export async function restartInterviewGeneration(
  userId: string,
  sessionId: string,
): Promise<{ session: InterviewSessionSummary; runId: string; provider: ProviderId } | null> {
  const cur = await store.getSessionSummary(userId, sessionId);
  if (!cur) return null;
  if (cur.status === "generating" && Date.now() - cur.updatedAt <= store.INTERVIEW_GENERATION_STALE_MS) {
    throw new FeatureError("질문을 만드는 중입니다. 잠시 후 다시 확인해 주세요.", 409);
  }
  const provider = await pickSessionProvider(await sessionProviderOf(userId, sessionId));
  await assertLimits(userId, INTERVIEW_GENERATE_LIMIT);
  const restarted = await store.restartGeneration(userId, sessionId);
  if (!restarted) return null;
  const session = await store.getSessionSummary(userId, sessionId);
  if (!session) return null;
  return { session, runId: restarted.runId, provider };
}

/** 백그라운드 생성(after()): 스냅숏 읽기 → LLM → normalizeGeneratedQuestions → store.completeGeneration / failGeneration. 던지지 않는다. */
export async function runInterviewGeneration(
  userId: string,
  sessionId: string,
  runId: string,
  provider: ProviderId,
  deps: InterviewDeps = {},
): Promise<void> {
  try {
    const snapshot = await store.loadSourceSnapshot(userId, sessionId);
    if (!snapshot) {
      await store.failGeneration(sessionId, runId, "근거 자료를 찾지 못했습니다. 새 연습을 만들어 주세요.");
      return;
    }
    const client = (deps.createClient ?? createLlmClient)(provider, { userId, referenceId: sessionId });
    const prompt = buildInterviewQuestionsPrompt(snapshot);
    const res = await withLlmDeadline(
      undefined,
      (signal) =>
        client.generate({
          task: "interview-questions",
          system: prompt.system,
          user: prompt.user,
          schema: InterviewQuestionsOutputSchema,
          effort: "medium",
          maxTokens: QUESTIONS_MAX_TOKENS,
          cacheUser: false,
          signal,
        }),
      { timeoutMs: deps.timeoutMs ?? INTERACTIVE_LLM_TIMEOUT_MS, message: "질문을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 만들어 주세요." },
    );
    const questions = normalizeGeneratedQuestions(res.output, snapshot.lines);
    if (questions.length === 0) {
      await store.failGeneration(sessionId, runId, "서류에서 근거를 확인할 수 있는 질문을 만들지 못했습니다. 다시 만들어 주세요.");
      return;
    }
    const saved = await saveOnce(() => store.completeGeneration(sessionId, runId, questions, { usage: res.usage, model: res.model }));
    if (!saved) console.warn(`[interview] ${sessionId} 생성 결과를 버림(다른 실행·삭제와 겹침)`);
  } catch (err) {
    if (!(err instanceof LlmPermanentError) && !(err instanceof FeatureError)) console.error("[interview generate]", sessionId, err);
    await store.failGeneration(sessionId, runId, interviewErrorMessage(err, "질문")).catch(() => false);
  }
}

// ---------------------------------------------------------------------------
// 답변·피드백
// ---------------------------------------------------------------------------

/** 답변 제출: 소유·상태 확인 → 레이트 리밋(10분·하루) → store.createAnswer('pending'). 라우트가 after(() => runInterviewFeedback(...))를 예약한다. */
export async function submitInterviewAnswer(
  userId: string,
  sessionId: string,
  questionId: string,
  input: SubmitInterviewAnswerInput,
): Promise<{ answer: InterviewAnswerView; provider: ProviderId } | null> {
  const q = await store.getQuestion(userId, sessionId, questionId);
  if (!q) return null;
  const s = await store.getSessionSummary(userId, sessionId);
  if (!s) return null;
  if (s.status !== "ready") throw new FeatureError("질문이 준비된 뒤에 답변할 수 있습니다.", 409);
  if (q.attemptCount >= INTERVIEW_LIMITS.answersPerQuestion) {
    throw new FeatureError(`한 질문에는 답변을 ${INTERVIEW_LIMITS.answersPerQuestion}번까지 남길 수 있습니다.`, 409);
  }
  const pending = await prisma.interviewAnswer.count({
    where: { userId, status: "pending", createdAt: { gt: new Date(Date.now() - store.INTERVIEW_FEEDBACK_STALE_MS) } },
  });
  if (pending >= 3) throw new FeatureError("앞서 보낸 답변의 피드백을 기다리는 중입니다. 잠시 후 다시 보내 주세요.", 409);
  const provider = await pickSessionProvider(await sessionProviderOf(userId, sessionId));
  await assertLimits(userId, INTERVIEW_FEEDBACK_LIMIT, INTERVIEW_FEEDBACK_DAILY_LIMIT);
  const answer = await store.createAnswer(userId, sessionId, questionId, { answer: input.answer, durationSec: input.durationSec ?? null });
  if (!answer) return null;
  return { answer, provider };
}

/** 피드백 재시도: 소유 확인 → 레이트 리밋 → store.resetAnswerForRetry. */
export async function retryInterviewFeedback(userId: string, answerId: string): Promise<{ answer: InterviewAnswerView; provider: ProviderId } | null> {
  const a = await prisma.interviewAnswer.findFirst({ select: { id: true, sessionId: true, status: true, createdAt: true }, where: { id: answerId, userId } });
  if (!a) return null;
  const stale = a.status === "pending" && Date.now() - a.createdAt.getTime() > store.INTERVIEW_FEEDBACK_STALE_MS;
  if (a.status !== "failed" && !stale) throw new FeatureError("이 답변은 다시 받을 피드백이 없습니다.", 409);
  const provider = await pickSessionProvider(await sessionProviderOf(userId, a.sessionId));
  await assertLimits(userId, INTERVIEW_FEEDBACK_LIMIT, INTERVIEW_FEEDBACK_DAILY_LIMIT);
  const answer = await store.resetAnswerForRetry(userId, answerId);
  if (!answer) return null;
  return { answer, provider };
}

/** 백그라운드 피드백(after()): LLM → InterviewFeedback(길이 추정 포함) → store.completeAnswer / failAnswer. 던지지 않는다. */
export async function runInterviewFeedback(userId: string, answerId: string, provider: ProviderId, deps: InterviewDeps = {}): Promise<void> {
  try {
    const row = await prisma.interviewAnswer.findFirst({ where: { id: answerId, userId } });
    if (!row || row.status !== "pending") return;
    const question = await store.getQuestion(userId, row.sessionId, row.questionId);
    if (!question) {
      await store.failAnswer(answerId, "질문을 찾을 수 없습니다.");
      return;
    }
    const snapshot = await store.loadSourceSnapshot(userId, row.sessionId);
    const lines = snapshot ? feedbackContextLines(question, snapshot.lines) : [];
    const client = (deps.createClient ?? createLlmClient)(provider, { userId, referenceId: row.sessionId });
    const prompt = buildInterviewFeedbackPrompt({ question, answer: row.answer, durationSec: row.durationSec, lines });
    const res = await withLlmDeadline(
      undefined,
      (signal) =>
        client.generate({
          task: "interview-feedback",
          system: prompt.system,
          user: prompt.user,
          schema: InterviewFeedbackOutputSchema,
          effort: "low",
          maxTokens: FEEDBACK_MAX_TOKENS,
          cacheUser: false,
          signal,
        }),
      { timeoutMs: deps.timeoutMs ?? INTERACTIVE_LLM_TIMEOUT_MS, message: "피드백을 만드는 데 시간이 너무 오래 걸려 중단했습니다. 다시 시도해 주세요." },
    );
    const feedback = toInterviewFeedback(res.output, row.answer, question.category, snapshot?.lines ?? []);
    await saveOnce(() => store.completeAnswer(answerId, feedback, { provider, model: res.model, usage: res.usage }));
  } catch (err) {
    if (!(err instanceof LlmPermanentError) && !(err instanceof FeatureError)) console.error("[interview feedback]", answerId, err);
    await store.failAnswer(answerId, interviewErrorMessage(err, "피드백")).catch(() => false);
  }
}

// ---------------------------------------------------------------------------
// 피드백 정리 (순수)
// ---------------------------------------------------------------------------

const clean = (s: string, max: number) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
const list = (xs: readonly string[], n: number, max = 300) => xs.map((x) => clean(x, max)).filter(Boolean).slice(0, n);

/** 서버가 잰 말하기 길이 → 1~5점(권장 범위 안이면 5, 벗어난 정도만큼 깎는다). */
export function lengthScore(seconds: number, range: { min: number; max: number }): number {
  if (seconds >= range.min && seconds <= range.max) return 5;
  const ratio = seconds < range.min ? seconds / range.min : range.max / seconds;
  if (ratio >= 0.75) return 4;
  if (ratio >= 0.5) return 3;
  if (ratio >= 0.25) return 2;
  return 1;
}

/**
 * LLM 출력 + 서버가 잰 길이 → 저장 형태(순수).
 * - 길이 점수는 서버가 추정한 말하기 시간으로 정한다(LLM 평가 문장은 덧붙인다).
 * - 모범 답변 근거의 ref가 스냅숏에 없는 줄이면 null(서류 근거 없음)로 바꾼다. lines를 주지 않으면 ref를 그대로 둔다.
 */
export function toInterviewFeedback(
  output: InterviewFeedbackOutput,
  answer: string,
  category: InterviewQuestionCategory,
  lines?: readonly InterviewSourceLine[],
): InterviewFeedback {
  const estimatedSeconds = estimateSpokenSeconds(answer);
  const recommendedSeconds = RECOMMENDED_ANSWER_SECONDS[category];
  const known = lines ? new Set(lines.map((l) => l.id)) : null;
  const criteria = Object.fromEntries(
    INTERVIEW_CRITERIA.map((k) => {
      const c = output.criteria[k];
      return [k, { score: Math.max(1, Math.min(5, Math.round(c.score))), comment: clean(c.comment, 400) }];
    }),
  ) as InterviewFeedbackOutput["criteria"];
  const lenNote = `약 ${estimatedSeconds}초 분량(권장 ${recommendedSeconds.min}~${recommendedSeconds.max}초).`;
  const llmLen = criteria.length.comment;
  criteria.length = {
    score: lengthScore(estimatedSeconds, recommendedSeconds),
    // LLM 평이 이미 시간을 말하면 그대로, 아니면 서버가 잰 길이를 앞에 붙인다.
    comment: clean(!llmLen ? lenNote : /\d+\s*초/.test(llmLen) ? llmLen : `${lenNote} ${llmLen}`, 400),
  };
  return {
    overall: Math.max(0, Math.min(100, Math.round(output.overall))),
    criteria,
    strengths: list(output.strengths, 3),
    improvements: list(output.improvements, 4),
    unsupportedClaims: list(output.unsupportedClaims, 3),
    modelAnswer: {
      conclusion: clean(output.modelAnswer.conclusion, 400),
      points: output.modelAnswer.points
        .map((p) => {
          const ref = p.ref?.trim().replace(/^\[|\]$/g, "") || null;
          return { text: clean(p.text, 400), ref: ref && (!known || known.has(ref)) ? ref : null };
        })
        .filter((p) => p.text)
        .slice(0, 4),
      limitation: clean(output.modelAnswer.limitation, 400),
    },
    followUp: clean(output.followUp, INTERVIEW_LIMITS.followUpChars).replace(/^["“'‘]+|["”'’]+$/g, ""),
    answerChars: answer.replace(/\s+/g, "").length,
    estimatedSeconds,
    recommendedSeconds,
  };
}
