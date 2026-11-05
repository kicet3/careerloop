/**
 * 면접 연습 브라우저용 호출 도우미(/api/interview/**). 서버 오류 문구({ error })를 그대로 InterviewApiError로 던진다.
 */
import type {
  CreateInterviewSessionInput,
  InterviewAnswerView,
  InterviewQuestionView,
  InterviewSessionDetail,
  InterviewSessionSummary,
  UpdateInterviewQuestionInput,
} from "@/lib/domain/interview";

export class InterviewApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "InterviewApiError";
  }
}

async function call<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const { json, ...rest } = init ?? {};
  const res = await fetch(url, {
    cache: "no-store",
    ...rest,
    ...(json !== undefined ? { body: JSON.stringify(json), headers: { "Content-Type": "application/json", ...(rest.headers ?? {}) } } : {}),
  });
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    let message = typeof body?.error === "string" ? body.error : `요청이 실패했습니다 (${res.status}).`;
    if (res.status === 429 && typeof body?.error !== "string") message = "요청을 너무 자주 보냈습니다. 잠시 후 다시 시도해 주세요.";
    throw new InterviewApiError(message, res.status);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const createSession = (input: Partial<CreateInterviewSessionInput> & { resumeId: string }) =>
  call<{ session: InterviewSessionSummary }>("/api/interview/sessions", { method: "POST", json: input });

export const fetchSession = (id: string, signal?: AbortSignal) =>
  call<InterviewSessionDetail>(`/api/interview/sessions/${encodeURIComponent(id)}`, { signal });

export const renameSession = (id: string, title: string) =>
  call<{ session: InterviewSessionSummary }>(`/api/interview/sessions/${encodeURIComponent(id)}`, { method: "PATCH", json: { title } });

export const deleteSession = (id: string) => call<void>(`/api/interview/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });

export const regenerateSession = (id: string) =>
  call<{ session: InterviewSessionSummary }>(`/api/interview/sessions/${encodeURIComponent(id)}/regenerate`, { method: "POST" });

export const patchQuestion = (sessionId: string, qid: string, patch: UpdateInterviewQuestionInput) =>
  call<{ question: InterviewQuestionView }>(`/api/interview/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(qid)}`, {
    method: "PATCH",
    json: patch,
  });

export const listAnswers = (sessionId: string, qid: string) =>
  call<{ answers: InterviewAnswerView[] }>(
    `/api/interview/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(qid)}/answers`,
  );

export const submitAnswer = (sessionId: string, qid: string, answer: string, durationSec: number | null) =>
  call<{ answer: InterviewAnswerView }>(
    `/api/interview/sessions/${encodeURIComponent(sessionId)}/questions/${encodeURIComponent(qid)}/answers`,
    { method: "POST", json: { answer, durationSec } },
  );

export const fetchAnswer = (aid: string, signal?: AbortSignal) =>
  call<{ answer: InterviewAnswerView }>(`/api/interview/answers/${encodeURIComponent(aid)}`, { signal });

export const retryAnswer = (aid: string) => call<{ answer: InterviewAnswerView }>(`/api/interview/answers/${encodeURIComponent(aid)}/retry`, { method: "POST" });

/** 피드백·생성 폴링 간격(ms). */
export const POLL_MS = 2500;
