import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { INTERVIEW_GENERATE_LIMIT } from "@/lib/auth/db-rate-limit";
import type { InterviewFeedbackOutput } from "@/lib/domain/interview";
import { EMPTY_RESUME_ITEM, emptyResumeDocument } from "@/lib/domain/resumes";
import { LlmPermanentError, type LlmClient } from "@/lib/llm";
import { createTestDb, type TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/providers/options", () => ({
  listProviderOptions: async () => [{ id: "anthropic", ready: true }],
  resolveRequestedProvider: async () => "anthropic",
}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-interview-svc-"));
let svc: typeof import("./service");
let store: typeof import("./store");
let resumes: typeof import("@/lib/resumes/service");
let portfolio: typeof import("@/lib/resumes/portfolio");
let portfolios: typeof import("@/lib/portfolios/service");
let tdb: TestDb;
let companyId: string;
let generalId: string;
const fake = { createClient: () => new FakeLlmClient() as LlmClient };

function doc() {
  const d = emptyResumeDocument();
  d.basics.headline = "결제 백엔드 개발자";
  d.experience = [
    {
      ...EMPTY_RESUME_ITEM.experience(),
      company: "토스",
      title: "백엔드",
      startDate: "2021.03",
      endDate: "현재",
      scope: "정산 시스템 설계와 운영",
      bullets: ["정산 배치를 재작성해 처리 시간을 50분에서 35분으로 줄임", "장애 대응 절차를 문서화해 팀에 공유"],
    },
  ];
  return d;
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub", "uc"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  svc = await import("./service");
  store = await import("./store");
  resumes = await import("@/lib/resumes/service");
  portfolio = await import("@/lib/resumes/portfolio");
  portfolios = await import("@/lib/portfolios/service");
  await tdb.prisma.jobPosting.create({
    data: { id: "jp1", userId: "ua", company: "토스", roleTitle: "백엔드", url: "https://toss.im/career/1", jdText: "주요 업무: 결제 정산 시스템 개발과 운영\n자격 요건: Kotlin 3년 이상" },
  });
  const base = { templateId: "classic" as const, document: doc(), source: "manual" as const };
  companyId = (await resumes.createResume("ua", { ...base, company: "토스", roleTitle: "백엔드", postingId: "jp1" })).resume.id;
  generalId = (await resumes.createResume("ua", { ...base, kind: "general", company: "", roleTitle: "" })).resume.id;
  const pf = await portfolios.createPortfolioFromFile("ua", {
    fileName: "포트폴리오.pdf",
    text: "정산 개편 프로젝트의 배경과 목표, 측정 지표를 정리한 문서입니다.\n월말 정산 지연 건수를 3개월 동안 추적했습니다.",
  });
  expect((await portfolio.attachPortfolio("ua", companyId, pf.portfolio.id)).ok).toBe(true);
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("근거 스냅숏(순수)", () => {
  it("이력서 → 포트폴리오 → 공고 순으로 줄을 잇고, 보관 공고가 없으면 이력서 JD를 쓴다", () => {
    const resume = { id: "r", title: "t", kind: "company" as const, company: "c", roleTitle: "r", versionId: "v", versionNo: 1 };
    const s = svc.buildSourceSnapshot({
      resume,
      document: doc(),
      posting: null,
      fallbackJdText: "자격 요건: SQL 능숙자. 우대 사항: 결제 도메인 경험",
      portfolio: { kind: "file", fileName: "a.pdf", url: null, text: "포트폴리오 첫 문단입니다. 충분히 긴 문장으로 씁니다." },
      now: 5,
    });
    expect(s.lines.map((l) => l.id[0]).join("")).toMatch(/^r+p+j+$/);
    expect(s.posting).toBeNull();
    expect(s.portfolio).toEqual({ kind: "file", fileName: "a.pdf", url: null, truncated: false });
    const noJd = svc.buildSourceSnapshot({ resume, document: doc(), posting: null, portfolio: null, now: 0 });
    expect(noJd.lines.every((l) => l.doc === "resume")).toBe(true);
  });
});

describe("피드백 정리(순수)", () => {
  const out = (over: Partial<InterviewFeedbackOutput> = {}): InterviewFeedbackOutput => ({
    overall: 140,
    criteria: {
      evidence: { score: 9, comment: " 근거 " },
      numbers: { score: 0, comment: "" },
      ownership: { score: 3, comment: "" },
      length: { score: 1, comment: "LLM 평" },
      structure: { score: 3, comment: "" },
    },
    strengths: ["a", " ", "b"],
    improvements: [],
    unsupportedClaims: [],
    modelAnswer: { conclusion: "결론", points: [{ text: "근거", ref: "r1" }, { text: "없는 줄", ref: "r99" }, { text: "[ADD: 기간]", ref: null }], limitation: "" },
    followUp: "“다음?”",
    ...over,
  });

  it("점수 범위 보정, 길이 점수는 서버가 잰 시간으로, 모르는 ref는 null", () => {
    const answer = "가".repeat(250); // 약 50초
    const f = svc.toInterviewFeedback(out(), answer, "line", [{ id: "r1", doc: "resume", label: "l", path: null, text: "t" }]);
    expect(f.overall).toBe(100);
    expect(f.criteria.evidence.score).toBe(5);
    expect(f.criteria.numbers.score).toBe(1);
    expect(f.criteria.length).toEqual({ score: 5, comment: "약 50초 분량(권장 30~90초). LLM 평" });
    expect(f.modelAnswer.points.map((p) => p.ref)).toEqual(["r1", null, null]);
    expect(f.strengths).toEqual(["a", "b"]);
    expect(f.followUp).toBe("다음?");
    // LLM 평이 시간을 이미 말하면 그대로 둔다.
    const g = svc.toInterviewFeedback(out({ criteria: { ...out().criteria, length: { score: 2, comment: "약 50초로 적당합니다." } } }), answer, "line");
    expect(g.criteria.length).toEqual({ score: 5, comment: "약 50초로 적당합니다." });
    expect(f).toMatchObject({ answerChars: 250, estimatedSeconds: 50, recommendedSeconds: { min: 30, max: 90 } });
  });

  it("lengthScore: 권장 범위 밖이면 벗어난 정도만큼 낮다", () => {
    const r = { min: 30, max: 90 };
    expect(svc.lengthScore(60, r)).toBe(5);
    expect(svc.lengthScore(25, r)).toBe(4);
    expect(svc.lengthScore(10, r)).toBe(2);
    expect(svc.lengthScore(200, r)).toBe(2);
    expect(svc.lengthScore(0, r)).toBe(1);
  });
});

describe("면접 연습 흐름", () => {
  it("세션 시작(연결 공고·포트폴리오 포함) → 생성 → 답변 → 피드백 → 진행률", async () => {
    const { session, runId, provider } = await svc.startInterviewSession("ua", { resumeId: companyId, includePortfolio: true });
    expect(session).toMatchObject({ status: "generating", hasPortfolio: true, hasPosting: true, postingId: "jp1", targetLabel: "토스 · 백엔드" });
    await svc.runInterviewGeneration("ua", session.id, runId, provider, fake);

    const detail = (await store.getSessionDetail("ua", session.id))!;
    expect(detail.session.status).toBe("ready");
    expect(detail.questions.length).toBeGreaterThan(2);
    const docs = new Set(detail.sourceLines.map((l) => l.doc));
    expect(docs).toEqual(new Set(["resume", "portfolio", "posting"]));
    const line = detail.questions.find((q) => q.category === "line")!;
    expect(line.citations[0]).toMatchObject({ verified: true });
    expect(detail.sourceLines.some((l) => l.id === line.citations[0]!.ref)).toBe(true);

    const sub = (await svc.submitInterviewAnswer("ua", session.id, line.id, { answer: "제가 직접 배치 로그로 쟀고 3개월 평균 50분에서 35분이 됐습니다.", durationSec: 30 }))!;
    expect(sub.answer.status).toBe("pending");
    await svc.runInterviewFeedback("ua", sub.answer.id, sub.provider, fake);
    const done = (await store.getAnswer("ua", sub.answer.id))!;
    expect(done.status).toBe("done");
    expect(done.feedback!.estimatedSeconds).toBeGreaterThan(0);
    expect(done.feedback!.followUp).toBeTruthy();
    const after = (await store.getSessionDetail("ua", session.id))!;
    expect(after.session.answeredCount).toBe(1);
    expect(after.questions.find((q) => q.id === line.id)).toMatchObject({ attemptCount: 1, status: "practiced" });

    // 남의 세션·질문은 null
    expect(await svc.submitInterviewAnswer("ub", session.id, line.id, { answer: "x" })).toBeNull();
    expect(await svc.retryInterviewFeedback("ub", sub.answer.id)).toBeNull();
    // 끝난 답변은 재시도할 수 없다.
    await expect(svc.retryInterviewFeedback("ua", sub.answer.id)).rejects.toMatchObject({ status: 409 });
  });

  it("공고 없이(postingId: null) 공용 이력서로: 공고 줄 없음, 직무 일반으로 표시", async () => {
    const a = await svc.startInterviewSession("ua", { resumeId: companyId, postingId: null, includePortfolio: false });
    expect(a.session).toMatchObject({ hasPosting: false, hasPortfolio: false, postingId: null });
    const snap = (await store.loadSourceSnapshot("ua", a.session.id))!;
    expect(snap.lines.every((l) => l.doc === "resume")).toBe(true);

    const g = await svc.startInterviewSession("ua", { resumeId: generalId, includePortfolio: true });
    expect(g.session).toMatchObject({ hasPosting: false, targetLabel: null });
  });

  it("링크 포트폴리오: 설명이 있으면 설명을 근거로 쓰고, 없으면 포트폴리오 줄이 없다", async () => {
    const link = await portfolios.createPortfolioFromUrl("ua", { url: "https://me.dev/pay" });
    expect((await portfolio.attachPortfolio("ua", generalId, link.id)).ok).toBe(true);
    const bare = await svc.startInterviewSession("ua", { resumeId: generalId, includePortfolio: true });
    expect(bare.session.hasPortfolio).toBe(false);

    await portfolios.updatePortfolio("ua", link.id, { description: "결제 대시보드를 혼자 설계하고 만들었습니다. 정산 문의가 절반으로 줄었습니다." });
    const withNote = await svc.startInterviewSession("ua", { resumeId: generalId, includePortfolio: true });
    expect(withNote.session.hasPortfolio).toBe(true);
    const snap = (await store.loadSourceSnapshot("ua", withNote.session.id))!;
    expect(snap.lines.filter((l) => l.doc === "portfolio").map((l) => l.text).join(" ")).toContain("정산 문의가 절반으로");
    await portfolio.detachPortfolio("ua", generalId);
  });

  it("소유·입력 확인: 남의 이력서 404, 남의 공고 404, 빈 이력서 409", async () => {
    await expect(svc.startInterviewSession("ub", { resumeId: companyId, includePortfolio: true })).rejects.toMatchObject({ status: 404 });
    await expect(svc.startInterviewSession("ua", { resumeId: companyId, postingId: "nope", includePortfolio: true })).rejects.toMatchObject({ status: 404 });
    const empty = await resumes.createResume("ua", { templateId: "classic", document: emptyResumeDocument(), source: "manual", company: "a", roleTitle: "b" });
    await expect(svc.startInterviewSession("ua", { resumeId: empty.resume.id, includePortfolio: true })).rejects.toMatchObject({ status: 409 });
  });

  it("LLM 실패는 세션 실패로 남고, 다시 만들기로 회복한다", async () => {
    const { session, runId, provider } = await svc.startInterviewSession("ua", { resumeId: companyId, includePortfolio: true });
    const failing: LlmClient = { name: "x", generate: async () => { throw new LlmPermanentError("거절", "refusal"); } };
    await svc.runInterviewGeneration("ua", session.id, runId, provider, { createClient: () => failing });
    const failed = (await store.getSessionSummary("ua", session.id))!;
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain("질문을 만들지 못했습니다");

    const re = (await svc.restartInterviewGeneration("ua", session.id))!;
    expect(re.session.status).toBe("generating");
    await expect(svc.restartInterviewGeneration("ua", session.id)).rejects.toMatchObject({ status: 409 });
    await svc.runInterviewGeneration("ua", session.id, re.runId, re.provider, fake);
    expect((await store.getSessionSummary("ua", session.id))!.status).toBe("ready");
    expect(await svc.restartInterviewGeneration("ub", session.id)).toBeNull();
  });

  it("레이트 리밋: 하루 생성 한도를 넘으면 429 + retryAfterSec", async () => {
    const base = { templateId: "classic" as const, document: doc(), source: "manual" as const };
    const rid = (await resumes.createResume("uc", { ...base, company: "x", roleTitle: "y" })).resume.id;
    for (let i = 0; i < INTERVIEW_GENERATE_LIMIT.limit; i++) await svc.startInterviewSession("uc", { resumeId: rid, includePortfolio: false });
    const err = await svc.startInterviewSession("uc", { resumeId: rid, includePortfolio: false }).catch((e) => e);
    expect(err).toBeInstanceOf(svc.InterviewRateLimitError);
    expect(err.status).toBe(429);
    expect(err.retryAfterSec).toBeGreaterThan(0);
  });
});

describe("라우트 오류 응답", () => {
  it("레이트 리밋은 429 + Retry-After, 기능 오류는 상태 그대로", async () => {
    const http = await import("./http");
    const { FeatureError } = await import("@/lib/api/errors");
    const res = http.interviewErrorResponse(new svc.InterviewRateLimitError(120), "t");
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("120");
    expect(((await res.json()) as { error: string }).error).toContain("2분");
    expect(http.interviewErrorResponse(new FeatureError("없음", 404), "t").status).toBe(404);
  });
});
