import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { InterviewFeedback, InterviewSourceSnapshot } from "@/lib/domain/interview";
import { createTestDb, type TestDb } from "@/test/db";
import type { NewInterviewQuestion } from "./source";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-interview-"));
let store: typeof import("./store");
let storage: typeof import("@/lib/storage");
let tdb: TestDb;

const snapshot = (): InterviewSourceSnapshot => ({
  version: 1,
  resume: { id: "r1", title: "토스 백엔드", kind: "company", company: "토스", roleTitle: "백엔드", versionId: "v1", versionNo: 1 },
  posting: null,
  portfolio: null,
  lines: [{ id: "r1", doc: "resume", label: "경력 · 기여 1", path: "experience.0.bullets.0", text: "정산 배치 재작성" }],
  createdAt: 0,
});

const q = (question: string, category: NewInterviewQuestion["category"] = "line"): NewInterviewQuestion => ({
  category,
  facet: null,
  question,
  intent: "의도",
  citations: [{ ref: "r1", doc: "resume", quote: "정산 배치", verified: true }],
  followUps: ["꼬리"],
});

const feedback = (overall: number): InterviewFeedback => ({
  overall,
  criteria: {
    evidence: { score: 3, comment: "" },
    numbers: { score: 3, comment: "" },
    ownership: { score: 3, comment: "" },
    length: { score: 3, comment: "" },
    structure: { score: 3, comment: "" },
  },
  strengths: [],
  improvements: [],
  unsupportedClaims: [],
  modelAnswer: { conclusion: "결론", points: [{ text: "근거", ref: "r1" }], limitation: "" },
  followUp: "다음",
  answerChars: 10,
  estimatedSeconds: 2,
  recommendedSeconds: { min: 30, max: 90 },
});

const params = {
  resumeId: "r1",
  resumeVersionId: "v1",
  postingId: null,
  title: "토스 백엔드 면접",
  resumeLabel: "토스 백엔드 · v1",
  targetLabel: "토스 · 백엔드",
  hasPortfolio: false,
  hasPosting: false,
  provider: "anthropic" as const,
  model: "m",
};

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  await tdb.prisma.companyResume.create({ data: { id: "r1", userId: "ua", company: "토스", roleTitle: "백엔드", templateId: "classic", title: "토스 백엔드" } });
  store = await import("./store");
  storage = await import("@/lib/storage");
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("면접 연습 저장소", () => {
  it("세션 생성 → 스냅숏 → 생성 결과(runId 조건) → 상세", async () => {
    const { id, runId } = await store.createSessionRow("ua", params);
    expect((await store.getSessionSummary("ua", id))!.status).toBe("generating");
    expect(await store.getSessionSummary("ub", id)).toBeNull();

    const key = await store.saveSourceSnapshot("ua", id, snapshot());
    expect(key).toBe(`users/ua/interview/${id}/source.json`);
    expect((await store.loadSourceSnapshot("ua", id))!.lines).toHaveLength(1);
    expect(await store.loadSourceSnapshot("ub", id)).toBeNull();

    expect(await store.completeGeneration(id, "wrong-run", [q("가")])).toBe(false);
    expect(await store.completeGeneration(id, runId, [])).toBe(false);
    const usage = { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 };
    expect(await store.completeGeneration(id, runId, [q("왜 했나요?"), q("동기는?", "motivation")], { usage })).toBe(true);
    // 이미 끝났으면 늦은 결과를 버린다.
    expect(await store.completeGeneration(id, runId, [q("늦은 결과")])).toBe(false);

    const detail = (await store.getSessionDetail("ua", id))!;
    expect(detail.session).toMatchObject({ status: "ready", questionCount: 2, answeredCount: 0 });
    expect(detail.questions.map((x) => [x.ord, x.question, x.category])).toEqual([
      [0, "왜 했나요?", "line"],
      [1, "동기는?", "motivation"],
    ]);
    expect(detail.questions[0]!.citations[0]).toMatchObject({ ref: "r1", verified: true });
    expect(detail.sourceLines.map((l) => l.id)).toEqual(["r1"]);
    expect(detail.latestAnswers).toEqual({});
    expect(await store.getSessionDetail("ub", id)).toBeNull();
  });

  it("답변 → 피드백 → 진행률·최고 점수, 실패·재시도", async () => {
    const { id, runId } = await store.createSessionRow("ua", params);
    // 준비 전에는 답변할 수 없다.
    await store.completeGeneration(id, runId, [q("질문 1"), q("질문 2", "pivot")]);
    const [q1, q2] = (await store.getSessionDetail("ua", id))!.questions;

    expect(await store.createAnswer("ub", id, q1!.id, { answer: "남의 것" })).toBeNull();
    const a1 = (await store.createAnswer("ua", id, q1!.id, { answer: "첫 답변", durationSec: 40 }))!;
    expect(a1.status).toBe("pending");
    expect(await store.completeAnswer(a1.id, feedback(60))).toBe(true);
    expect(await store.completeAnswer(a1.id, feedback(99))).toBe(false); // 이미 done

    const a2 = (await store.createAnswer("ua", id, q1!.id, { answer: "둘째 답변" }))!;
    await store.completeAnswer(a2.id, feedback(45));
    const a3 = (await store.createAnswer("ua", id, q2!.id, { answer: "실패할 답변" }))!;
    expect(await store.failAnswer(a3.id, "엔진 오류")).toBe(true);

    let detail = (await store.getSessionDetail("ua", id))!;
    const v1 = detail.questions.find((x) => x.id === q1!.id)!;
    expect(v1).toMatchObject({ attemptCount: 2, bestScore: 60, status: "practiced" });
    expect(detail.session.answeredCount).toBe(1);
    expect(detail.latestAnswers[q1!.id]!.id).toBe(a2.id);
    expect(detail.latestAnswers[q1!.id]!.feedback!.overall).toBe(45);
    expect(detail.latestAnswers[q2!.id]).toMatchObject({ status: "failed", error: "엔진 오류", feedback: null });
    expect(store.computeProgress(detail.questions)).toMatchObject({ total: 2, practiced: 1, averageBestScore: 60 });

    // 실패한 답변만 재시도할 수 있다.
    await expect(store.resetAnswerForRetry("ua", a2.id)).rejects.toMatchObject({ status: 409 });
    expect(await store.resetAnswerForRetry("ub", a3.id)).toBeNull();
    expect((await store.resetAnswerForRetry("ua", a3.id))!.status).toBe("pending");
    await store.completeAnswer(a3.id, feedback(80));
    detail = (await store.getSessionDetail("ua", id))!;
    expect(detail.session.answeredCount).toBe(2);

    expect((await store.listAnswers("ua", id, q1!.id))!.map((a) => a.id)).toEqual([a2.id, a1.id]);
    expect(await store.listAnswers("ub", id, q1!.id)).toBeNull();
    expect(await store.updateQuestion("ua", id, q2!.id, { starred: true, status: "skipped" })).toMatchObject({ starred: true, status: "skipped" });
    expect(await store.updateQuestion("ub", id, q2!.id, { starred: false })).toBeNull();
  });

  it("다시 만들기: 진행 중이면 409, 멈췄거나 끝났으면 새 runId", async () => {
    const { id, runId } = await store.createSessionRow("ua", params);
    await expect(store.restartGeneration("ua", id)).rejects.toMatchObject({ status: 409 });
    const later = Date.now() + store.INTERVIEW_GENERATION_STALE_MS + 1000;
    const restarted = (await store.restartGeneration("ua", id, later))!;
    expect(restarted.runId).not.toBe(runId);
    expect(await store.failGeneration(id, runId, "옛 실행")).toBe(false);
    expect(await store.failGeneration(id, restarted.runId, "실패")).toBe(true);
    expect((await store.getSessionSummary("ua", id))!).toMatchObject({ status: "failed", error: "실패" });
    expect((await store.restartGeneration("ua", id))!.runId).toBeTruthy();
    expect(await store.restartGeneration("ub", id)).toBeNull();
  });

  it("멈춘 생성·피드백은 화면에 실패로 보이고, 다시 받으면 대기 시각을 새로 센다", async () => {
    const { id, runId } = await store.createSessionRow("ua", params);
    expect((await store.getSessionSummary("ua", id))!.status).toBe("generating");
    const old = new Date(Date.now() - store.INTERVIEW_GENERATION_STALE_MS - 1000);
    await tdb.prisma.interviewSession.update({ where: { id }, data: { updatedAt: old } });
    expect((await store.getSessionSummary("ua", id))!).toMatchObject({ status: "failed", error: store.INTERVIEW_GENERATION_STALLED });
    expect((await store.getSessionDetail("ua", id))!.session.status).toBe("failed");
    expect((await store.listSessions("ua")).find((x) => x.id === id)!.status).toBe("failed");
    // DB 값은 그대로라 다시 만들기가 받아 준다.
    expect((await store.restartGeneration("ua", id))!.runId).not.toBe(runId);
    expect((await store.getSessionSummary("ua", id))!.status).toBe("generating");

    const s2 = await store.createSessionRow("ua", params);
    await store.completeGeneration(s2.id, s2.runId, [q("멈출 질문")]);
    const [qq] = (await store.getSessionDetail("ua", s2.id))!.questions;
    const a = (await store.createAnswer("ua", s2.id, qq!.id, { answer: "답" }))!;
    await tdb.prisma.interviewAnswer.update({ where: { id: a.id }, data: { createdAt: new Date(Date.now() - store.INTERVIEW_FEEDBACK_STALE_MS - 1000) } });
    expect((await store.getAnswer("ua", a.id))!).toMatchObject({ status: "failed", error: store.INTERVIEW_FEEDBACK_STALLED });
    expect((await store.getSessionDetail("ua", s2.id))!.latestAnswers[qq!.id]!.status).toBe("failed");
    const retried = (await store.resetAnswerForRetry("ua", a.id))!;
    expect(retried.status).toBe("pending");
    // 재시도 직후에는 멈춤이 아니다(두 번째 재시도는 409).
    await expect(store.resetAnswerForRetry("ua", a.id)).rejects.toMatchObject({ status: 409 });
  });

  it("삭제하면 질문·답변·스냅숏이 함께 지워지고, 이력서를 지워도 세션은 남는다", async () => {
    const { id, runId } = await store.createSessionRow("ua", params);
    await store.saveSourceSnapshot("ua", id, snapshot());
    await store.completeGeneration(id, runId, [q("질문")]);
    expect(await store.deleteSession("ub", id)).toBe(false);
    expect(await store.deleteSession("ua", id)).toBe(true);
    expect(await tdb.prisma.interviewQuestion.count({ where: { sessionId: id } })).toBe(0);
    expect(await storage.getObject(store.interviewSourceKey("ua", id))).toBeNull();

    const kept = await store.createSessionRow("ua", params);
    await tdb.prisma.companyResume.delete({ where: { id: "r1" } });
    expect((await store.getSessionSummary("ua", kept.id))!.resumeId).toBeNull();
    expect((await store.listSessions("ua")).length).toBeGreaterThan(0);
    expect(await store.listSessions("ub")).toEqual([]);
  });
});
