import "server-only";
/**
 * 면접 연습 저장소(PostgreSQL interview_* + 저장소 스냅숏). LLM 호출·프롬프트는 service.ts가 하고, 여기는 행 읽기·쓰기만 한다.
 *
 * - 모든 사용자 진입 함수는 userId 소유권을 확인한다. 남의 세션·질문·답변은 null/false(라우트에서 404).
 * - 생성 결과 쓰기(completeGeneration·failGeneration)는 세션의 runId가 같고 status='generating'일 때만 한다
 *   (다시 만들기·삭제와 겹친 늦은 결과를 버린다). 피드백 쓰기(completeAnswer·failAnswer)는 답변이 'pending'일 때만 한다.
 * - 스냅숏: users/<userId>/interview/<sessionId>/source.json(InterviewSourceSnapshot). 세션을 지우면 접두사째 지운다.
 */
import { customAlphabet } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { stripNul, stripNulDeep } from "@/lib/db/errors";
import type { InterviewAnswerRow, InterviewQuestionRow, InterviewSessionRow, UsageTotals } from "@/lib/db/types";
import {
  INTERVIEW_LIMITS,
  InterviewSourceSnapshotSchema,
  type InterviewAnswerView,
  type InterviewCitation,
  type InterviewFeedback,
  type InterviewQuestionView,
  type InterviewSessionDetail,
  type InterviewSessionSummary,
  type InterviewSourceSnapshot,
  type UpdateInterviewQuestionInput,
} from "@/lib/domain/interview";
import type { ProviderId } from "@/lib/domain/providers";
import { deleteObject, getJson, listByPrefix, putJson, userKey, userPrefix } from "@/lib/storage";
import type { NewInterviewQuestion } from "./source";

// 저장소 키 조각은 영문·숫자로 시작해야 하므로 '-'·'_' 없는 알파벳을 쓴다.
const newId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

export const INTERVIEW_SESSION_NOT_FOUND = "면접 연습을 찾을 수 없습니다.";
export const INTERVIEW_QUESTION_NOT_FOUND = "질문을 찾을 수 없습니다.";

/** 생성이 이 시간보다 오래 'generating'이면 멈춘 것으로 보고 다시 만들기를 허용한다. */
export const INTERVIEW_GENERATION_STALE_MS = 6 * 60_000;
/** 피드백이 이 시간보다 오래 'pending'이면 멈춘 것으로 본다. */
export const INTERVIEW_FEEDBACK_STALE_MS = 5 * 60_000;

export function interviewSourceKey(userId: string, sessionId: string): string {
  return userKey(userId, "interview", sessionId, "source.json");
}

// ---------------------------------------------------------------------------
// 변환
// ---------------------------------------------------------------------------

const ms = (d: Date | null | undefined) => (d ? d.getTime() : null);
const strings = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);
const citations = (v: unknown): InterviewCitation[] =>
  Array.isArray(v)
    ? v.filter(
        (c): c is InterviewCitation =>
          !!c && typeof c === "object" && typeof (c as InterviewCitation).ref === "string" && typeof (c as InterviewCitation).quote === "string",
      )
    : [];

export const INTERVIEW_GENERATION_STALLED = "질문 만들기가 멈췄습니다. 다시 만들어 주세요.";
export const INTERVIEW_FEEDBACK_STALLED = "피드백 만들기가 멈췄습니다. 다시 받아 주세요.";

/**
 * 백그라운드 작업(after())이 죽어 'generating'·'pending'에 멈춘 행은 화면에 'failed'로 보낸다(다시 만들기·다시 받기 버튼이 보이고 폴링이 멈춘다).
 * DB 값은 그대로 두며, 재시도 쪽(restartGeneration·resetAnswerForRetry)이 같은 기준으로 멈춘 행을 받아 준다.
 */
function sessionStalled(row: Pick<InterviewSessionRow, "status" | "updatedAt">, now: number): boolean {
  return row.status === "generating" && now - row.updatedAt.getTime() > INTERVIEW_GENERATION_STALE_MS;
}
function answerStalled(row: Pick<InterviewAnswerRow, "status" | "createdAt">, now: number): boolean {
  return row.status === "pending" && now - row.createdAt.getTime() > INTERVIEW_FEEDBACK_STALE_MS;
}

export function toSessionSummary(row: InterviewSessionRow, now: number = Date.now()): InterviewSessionSummary {
  const stalled = sessionStalled(row, now);
  return {
    id: row.id,
    title: row.title,
    resumeId: row.resumeId,
    resumeVersionId: row.resumeVersionId,
    postingId: row.postingId,
    resumeLabel: row.resumeLabel,
    targetLabel: row.targetLabel,
    hasPortfolio: row.hasPortfolio,
    hasPosting: row.hasPosting,
    status: stalled ? "failed" : row.status,
    error: stalled ? INTERVIEW_GENERATION_STALLED : row.error,
    questionCount: row.questionCount,
    answeredCount: row.answeredCount,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
    generatedAt: ms(row.generatedAt),
  };
}

export function toQuestionView(row: InterviewQuestionRow): InterviewQuestionView {
  return {
    id: row.id,
    ord: row.ord,
    category: row.category,
    facet: row.facet,
    question: row.question,
    intent: row.intent,
    citations: citations(row.citations),
    followUps: strings(row.followUps),
    status: row.status,
    starred: row.starred,
    attemptCount: row.attemptCount,
    bestScore: row.bestScore,
    lastAnsweredAt: ms(row.lastAnsweredAt),
  };
}

export function toAnswerView(row: InterviewAnswerRow, now: number = Date.now()): InterviewAnswerView {
  const stalled = answerStalled(row, now);
  return {
    id: row.id,
    questionId: row.questionId,
    answer: row.answer,
    durationSec: row.durationSec,
    status: stalled ? "failed" : row.status,
    feedback: row.status === "done" && row.feedback && typeof row.feedback === "object" ? (row.feedback as InterviewFeedback) : null,
    score: row.score,
    error: stalled ? INTERVIEW_FEEDBACK_STALLED : row.error,
    createdAt: row.createdAt.getTime(),
    completedAt: ms(row.completedAt),
  };
}

export { computeProgress } from "./source";

async function ownedSession(userId: string, sessionId: string): Promise<InterviewSessionRow | null> {
  return ((await prisma.interviewSession.findFirst({ where: { id: sessionId, userId } })) as InterviewSessionRow | null) ?? null;
}

// ---------------------------------------------------------------------------
// 세션
// ---------------------------------------------------------------------------

export interface CreateSessionRowParams {
  resumeId: string;
  resumeVersionId: string | null;
  postingId: string | null;
  title: string;
  resumeLabel: string;
  targetLabel: string | null;
  hasPortfolio: boolean;
  hasPosting: boolean;
  provider: ProviderId | null;
  model: string | null;
}

/** 세션 행을 'generating'으로 만든다(호출자가 이력서·공고 소유를 확인한 뒤). 상한을 넘으면 FeatureError(409). */
export async function createSessionRow(userId: string, p: CreateSessionRowParams): Promise<{ id: string; runId: string }> {
  const n = await prisma.interviewSession.count({ where: { userId } });
  if (n >= INTERVIEW_LIMITS.sessionsPerUser) {
    throw new FeatureError(`면접 연습은 ${INTERVIEW_LIMITS.sessionsPerUser}개까지 둘 수 있습니다. 끝난 연습을 지워 주세요.`, 409);
  }
  const id = newId();
  const runId = newId();
  const now = new Date();
  await prisma.interviewSession.create({
    data: {
      id,
      userId,
      resumeId: p.resumeId,
      resumeVersionId: p.resumeVersionId,
      postingId: p.postingId,
      title: stripNul(p.title.slice(0, INTERVIEW_LIMITS.titleChars)),
      resumeLabel: stripNul(p.resumeLabel.slice(0, 200)),
      targetLabel: stripNul(p.targetLabel?.slice(0, 200) ?? null),
      hasPortfolio: p.hasPortfolio,
      hasPosting: p.hasPosting,
      status: "generating",
      runId,
      provider: p.provider,
      model: p.model,
      createdAt: now,
      updatedAt: now,
    },
  });
  return { id, runId };
}

/** 스냅숏을 저장하고 세션에 키를 적는다. */
export async function saveSourceSnapshot(userId: string, sessionId: string, snapshot: InterviewSourceSnapshot): Promise<string> {
  const key = interviewSourceKey(userId, sessionId);
  await putJson(key, stripNulDeep(snapshot));
  await prisma.interviewSession.updateMany({ where: { id: sessionId, userId }, data: { sourceKey: key } });
  return key;
}

/** 저장된 스냅숏. 세션이 남의 것이거나 스냅숏이 없거나 형식이 틀리면 null. */
export async function loadSourceSnapshot(userId: string, sessionId: string): Promise<InterviewSourceSnapshot | null> {
  const row = await ownedSession(userId, sessionId);
  if (!row?.sourceKey) return null;
  const raw = await getJson(row.sourceKey);
  const parsed = InterviewSourceSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

const addUsage = (a: UsageTotals | null, b: UsageTotals | null | undefined): UsageTotals | null =>
  b
    ? {
        inputTokens: (a?.inputTokens ?? 0) + b.inputTokens,
        outputTokens: (a?.outputTokens ?? 0) + b.outputTokens,
        cacheReadTokens: (a?.cacheReadTokens ?? 0) + b.cacheReadTokens,
        cacheWriteTokens: (a?.cacheWriteTokens ?? 0) + b.cacheWriteTokens,
      }
    : a;

/**
 * 생성 결과 저장: 기존 질문(다시 만들기)을 지우고 새 질문을 넣은 뒤 세션을 'ready'로. runId가 다르거나 이미 끝났으면 false(버린다).
 * 질문이 0개면 저장하지 않고 false — 호출자가 failGeneration으로 알린다.
 */
export async function completeGeneration(
  sessionId: string,
  runId: string,
  questions: readonly NewInterviewQuestion[],
  meta: { usage?: UsageTotals | null; model?: string | null } = {},
): Promise<boolean> {
  if (questions.length === 0) return false;
  const now = new Date();
  return prisma.$transaction(async (tx) => {
    const cur = (await tx.interviewSession.findFirst({ where: { id: sessionId, runId, status: "generating" } })) as InterviewSessionRow | null;
    if (!cur) return false;
    const { count } = await tx.interviewSession.updateMany({
      where: { id: sessionId, runId, status: "generating" },
      data: {
        status: "ready",
        error: null,
        questionCount: questions.length,
        answeredCount: 0,
        generatedAt: now,
        updatedAt: now,
        usage: (addUsage(cur.usage, meta.usage) ?? undefined) as Prisma.InputJsonValue | undefined,
        ...(meta.model ? { model: meta.model } : {}),
      },
    });
    if (count === 0) return false;
    await tx.interviewQuestion.deleteMany({ where: { sessionId } });
    await tx.interviewQuestion.createMany({
      data: questions.slice(0, INTERVIEW_LIMITS.questionsPerSession).map((q, ord) => ({
        id: newId(),
        sessionId,
        ord,
        category: q.category,
        facet: q.facet,
        question: stripNul(q.question),
        intent: stripNul(q.intent),
        citations: stripNulDeep(q.citations) as unknown as Prisma.InputJsonValue,
        followUps: stripNulDeep(q.followUps) as unknown as Prisma.InputJsonValue,
        createdAt: now,
      })),
    });
    return true;
  });
}

/** 생성 실패 기록(사용자에게 보여도 되는 문구). runId가 다르면 false. */
export async function failGeneration(sessionId: string, runId: string, error: string): Promise<boolean> {
  const { count } = await prisma.interviewSession.updateMany({
    where: { id: sessionId, runId, status: "generating" },
    data: { status: "failed", error: stripNul(error.slice(0, 500)), updatedAt: new Date() },
  });
  return count > 0;
}

/**
 * 다시 만들기: 실패했거나 준비된 세션, 또는 멈춘(오래된) 생성 세션을 새 runId로 'generating'에 둔다. 그 밖(진행 중)이면 FeatureError(409).
 * 남의 세션이면 null. 기존 질문·답변은 completeGeneration이 성공할 때 바뀐다(실패하면 남는다).
 */
export async function restartGeneration(userId: string, sessionId: string, now: number = Date.now()): Promise<{ runId: string } | null> {
  const row = await ownedSession(userId, sessionId);
  if (!row) return null;
  const stale = sessionStalled(row, now);
  if (row.status === "generating" && !stale) throw new FeatureError("질문을 만드는 중입니다. 잠시 후 다시 확인해 주세요.", 409);
  const runId = newId();
  const { count } = await prisma.interviewSession.updateMany({
    where: { id: sessionId, userId, status: row.status, updatedAt: row.updatedAt },
    data: { status: "generating", runId, error: null, updatedAt: new Date(now) },
  });
  if (count === 0) throw new FeatureError("다른 요청과 겹쳤습니다. 다시 시도해 주세요.", 409);
  return { runId };
}

export async function listSessions(userId: string): Promise<InterviewSessionSummary[]> {
  const rows = (await prisma.interviewSession.findMany({
    where: { userId },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: INTERVIEW_LIMITS.sessionsPerUser,
  })) as InterviewSessionRow[];
  return rows.map((r) => toSessionSummary(r));
}

export async function getSessionSummary(userId: string, sessionId: string): Promise<InterviewSessionSummary | null> {
  const row = await ownedSession(userId, sessionId);
  return row ? toSessionSummary(row) : null;
}

/** 세션 + 질문 + 질문별 최근 답변 + 스냅숏 줄. 남의 세션이면 null. */
export async function getSessionDetail(userId: string, sessionId: string): Promise<InterviewSessionDetail | null> {
  const row = await ownedSession(userId, sessionId);
  if (!row) return null;
  const qs = ((await prisma.interviewQuestion.findMany({ where: { sessionId }, orderBy: { ord: "asc" } })) as InterviewQuestionRow[]).map(
    toQuestionView,
  );
  const answers = (await prisma.interviewAnswer.findMany({
    where: { sessionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    distinct: ["questionId"],
  })) as InterviewAnswerRow[];
  let sourceLines: InterviewSessionDetail["sourceLines"] = [];
  if (row.sourceKey && row.status === "ready") {
    const parsed = InterviewSourceSnapshotSchema.safeParse(await getJson(row.sourceKey).catch(() => null));
    if (parsed.success) sourceLines = parsed.data.lines;
  }
  return {
    session: toSessionSummary(row),
    questions: qs,
    sourceLines,
    latestAnswers: Object.fromEntries(answers.map((a) => [a.questionId, toAnswerView(a)])),
  };
}

export async function renameSession(userId: string, sessionId: string, title: string): Promise<InterviewSessionSummary | null> {
  const [row] = await prisma.interviewSession.updateManyAndReturn({
    where: { id: sessionId, userId },
    data: { title: stripNul(title.trim().slice(0, INTERVIEW_LIMITS.titleChars)), updatedAt: new Date() },
  });
  return row ? toSessionSummary(row as InterviewSessionRow) : null;
}

/** 세션 삭제(질문·답변은 FK CASCADE) + 스냅숏 정리. */
export async function deleteSession(userId: string, sessionId: string): Promise<boolean> {
  const { count } = await prisma.interviewSession.deleteMany({ where: { id: sessionId, userId } });
  if (count === 0) return false;
  try {
    for (const k of await listByPrefix(userPrefix(userId, "interview", sessionId))) await deleteObject(k);
  } catch (err) {
    console.error("[interview] 스냅숏 삭제 실패", sessionId, err);
  }
  return true;
}

// ---------------------------------------------------------------------------
// 질문·답변
// ---------------------------------------------------------------------------

async function ownedQuestion(userId: string, sessionId: string, questionId: string): Promise<InterviewQuestionRow | null> {
  const q = await prisma.interviewQuestion.findFirst({ where: { id: questionId, sessionId, session: { userId } } });
  return (q as InterviewQuestionRow | null) ?? null;
}

export async function getQuestion(userId: string, sessionId: string, questionId: string): Promise<InterviewQuestionView | null> {
  const q = await ownedQuestion(userId, sessionId, questionId);
  return q ? toQuestionView(q) : null;
}

export async function updateQuestion(
  userId: string,
  sessionId: string,
  questionId: string,
  patch: UpdateInterviewQuestionInput,
): Promise<InterviewQuestionView | null> {
  const q = await ownedQuestion(userId, sessionId, questionId);
  if (!q) return null;
  const [row] = await prisma.interviewQuestion.updateManyAndReturn({
    where: { id: questionId, sessionId },
    data: { ...(patch.status !== undefined ? { status: patch.status } : {}), ...(patch.starred !== undefined ? { starred: patch.starred } : {}) },
  });
  return row ? toQuestionView(row as InterviewQuestionRow) : null;
}

/** 답변을 'pending'으로 남긴다(피드백은 service가 after()로). 세션이 준비되지 않았거나 답변 상한이면 FeatureError(409). */
export async function createAnswer(
  userId: string,
  sessionId: string,
  questionId: string,
  input: { answer: string; durationSec?: number | null },
): Promise<InterviewAnswerView | null> {
  const q = await ownedQuestion(userId, sessionId, questionId);
  if (!q) return null;
  const s = await ownedSession(userId, sessionId);
  if (!s || s.status !== "ready") throw new FeatureError("질문이 준비된 뒤에 답변할 수 있습니다.", 409);
  const n = await prisma.interviewAnswer.count({ where: { questionId } });
  if (n >= INTERVIEW_LIMITS.answersPerQuestion) {
    throw new FeatureError(`한 질문에는 답변을 ${INTERVIEW_LIMITS.answersPerQuestion}번까지 남길 수 있습니다.`, 409);
  }
  const row = await prisma.interviewAnswer.create({
    data: {
      id: newId(),
      questionId,
      sessionId,
      userId,
      answer: stripNul(input.answer.slice(0, INTERVIEW_LIMITS.answerChars)),
      durationSec: input.durationSec ?? null,
      status: "pending",
    },
  });
  return toAnswerView(row as InterviewAnswerRow);
}

/** 피드백 재시도: 실패했거나 멈춘 답변을 다시 'pending'으로. 남의 답변이면 null, 그 밖 상태면 FeatureError(409). */
export async function resetAnswerForRetry(userId: string, answerId: string, now: number = Date.now()): Promise<InterviewAnswerView | null> {
  const a = (await prisma.interviewAnswer.findFirst({ where: { id: answerId, userId } })) as InterviewAnswerRow | null;
  if (!a) return null;
  const stale = answerStalled(a, now);
  if (a.status !== "failed" && !stale) throw new FeatureError("이 답변은 다시 받을 피드백이 없습니다.", 409);
  const [row] = await prisma.interviewAnswer.updateManyAndReturn({
    where: { id: answerId, userId, status: a.status, createdAt: a.createdAt },
    // createdAt을 지금으로 옮겨 '멈춤' 판정(answerStalled)과 동시 대기 수 세기가 이 재시도 시점부터 다시 센다.
    data: { status: "pending", error: null, createdAt: new Date(now) },
  });
  if (!row) throw new FeatureError("다른 요청과 겹쳤습니다. 다시 시도해 주세요.", 409);
  return toAnswerView(row as InterviewAnswerRow);
}

/**
 * 피드백 저장: 답변을 'done'으로, 질문의 시도 수·최고 점수·마지막 답변 시각·상태(new → practiced)와 세션의 진행 수·사용량을 갱신한다.
 * 답변이 'pending'이 아니면(삭제·중복) false.
 */
export async function completeAnswer(
  answerId: string,
  feedback: InterviewFeedback,
  meta: { provider?: ProviderId | null; model?: string | null; usage?: UsageTotals | null } = {},
): Promise<boolean> {
  const now = new Date();
  const score = Math.max(0, Math.min(100, Math.round(feedback.overall)));
  return prisma.$transaction(async (tx) => {
    const [a] = (await tx.interviewAnswer.updateManyAndReturn({
      where: { id: answerId, status: "pending" },
      data: {
        status: "done",
        feedback: stripNulDeep(feedback) as unknown as Prisma.InputJsonValue,
        score,
        error: null,
        provider: meta.provider ?? null,
        model: meta.model ?? null,
        usage: (meta.usage ?? undefined) as Prisma.InputJsonValue | undefined,
        completedAt: now,
      },
    })) as InterviewAnswerRow[];
    if (!a) return false;
    const q = (await tx.interviewQuestion.findUnique({ where: { id: a.questionId } })) as InterviewQuestionRow | null;
    if (q) {
      await tx.interviewQuestion.update({
        where: { id: q.id },
        data: {
          attemptCount: { increment: 1 },
          bestScore: q.bestScore == null ? score : Math.max(q.bestScore, score),
          lastAnsweredAt: now,
          ...(q.status === "new" ? { status: "practiced" } : {}),
        },
      });
    }
    const answered = await tx.interviewQuestion.count({ where: { sessionId: a.sessionId, attemptCount: { gt: 0 } } });
    const s = (await tx.interviewSession.findUnique({ where: { id: a.sessionId } })) as InterviewSessionRow | null;
    await tx.interviewSession.update({
      where: { id: a.sessionId },
      data: {
        answeredCount: answered,
        updatedAt: now,
        usage: (addUsage(s?.usage ?? null, meta.usage) ?? undefined) as Prisma.InputJsonValue | undefined,
      },
    });
    return true;
  });
}

/** 피드백 실패 기록. 'pending'이 아니면 false. */
export async function failAnswer(answerId: string, error: string): Promise<boolean> {
  const { count } = await prisma.interviewAnswer.updateMany({
    where: { id: answerId, status: "pending" },
    data: { status: "failed", error: stripNul(error.slice(0, 500)), completedAt: new Date() },
  });
  return count > 0;
}

export async function getAnswer(userId: string, answerId: string): Promise<InterviewAnswerView | null> {
  const a = await prisma.interviewAnswer.findFirst({ where: { id: answerId, userId } });
  return a ? toAnswerView(a as InterviewAnswerRow) : null;
}

/** 한 질문의 답변 이력(최신부터). 남의 질문이면 null. */
export async function listAnswers(userId: string, sessionId: string, questionId: string): Promise<InterviewAnswerView[] | null> {
  const q = await ownedQuestion(userId, sessionId, questionId);
  if (!q) return null;
  const rows = (await prisma.interviewAnswer.findMany({
    where: { questionId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: INTERVIEW_LIMITS.answersPerQuestion,
  })) as InterviewAnswerRow[];
  return rows.map((r) => toAnswerView(r));
}
