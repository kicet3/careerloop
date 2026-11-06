import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { draftStepStates, formatElapsed, type ResumeDraftJobView } from "@/lib/resumes/draft-job-types";
import { anyJobFinished, DraftJobsStrip } from "./DraftJobsStrip";
import { DRAFT_POLL_MAX_MS, DRAFT_POLL_MS, draftHeading, DraftProgress, nextDraftPollMs } from "./DraftProgress";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/app/resumes" }));

const job = (over: Partial<ResumeDraftJobView> = {}): ResumeDraftJobView => ({
  id: "j1",
  status: "running",
  stage: "writing",
  label: "토스 · 백엔드",
  error: null,
  resumeId: null,
  notes: [],
  missingInfo: [],
  canRetry: false,
  attempts: 1,
  startedAt: 1000,
  createdAt: 1000,
  updatedAt: 1000,
  completedAt: null,
  ...over,
});

describe("초안 진행 단계", () => {
  it("draftStepStates: 진행 중·실패·완료", () => {
    expect(draftStepStates({ status: "running", stage: "material" })).toEqual(["active", "todo", "todo", "todo"]);
    expect(draftStepStates({ status: "running", stage: "writing" })).toEqual(["done", "active", "todo", "todo"]);
    expect(draftStepStates({ status: "failed", stage: "writing" })).toEqual(["done", "failed", "todo", "todo"]);
    expect(draftStepStates({ status: "completed", stage: "saving" })).toEqual(["done", "done", "done", "done"]);
  });

  it("formatElapsed", () => {
    expect(formatElapsed(42_400)).toBe("42초");
    expect(formatElapsed(65_000)).toBe("1분 05초");
    expect(formatElapsed(-5)).toBe("0초");
  });
});

describe("DraftProgress", () => {
  it("제목(h1)은 컴포넌트가 지금 상태로 그린다", () => {
    expect(renderToStaticMarkup(<DraftProgress initialJob={job()} />)).toContain(`<h1 class="mt-3 text-2xl font-bold tracking-tight text-slate-900">${draftHeading("running")}</h1>`);
    expect(renderToStaticMarkup(<DraftProgress initialJob={job({ status: "failed", error: "x" })} />)).toContain(draftHeading("failed"));
    expect(new Set(["running", "failed", "completed"].map((s) => draftHeading(s as ResumeDraftJobView["status"]))).size).toBe(3);
  });

  it("폴링 간격: 성공하면 기본, 연속 실패하면 두 배씩 늘려 상한까지", () => {
    expect(nextDraftPollMs(0)).toBe(DRAFT_POLL_MS);
    expect(nextDraftPollMs(1)).toBe(DRAFT_POLL_MS * 2);
    expect(nextDraftPollMs(2)).toBe(DRAFT_POLL_MS * 4);
    expect(nextDraftPollMs(50)).toBe(DRAFT_POLL_MAX_MS);
  });

  it("진행 중: 단계 4개와 '떠나도 계속' 안내, 지금 단계 표시", () => {
    const html = renderToStaticMarkup(<DraftProgress initialJob={job()} />);
    for (const label of ["자료 모음", "AI가 초안 쓰는 중", "저장 중", "완료"]) expect(html).toContain(label);
    expect(html).toContain('aria-current="step"');
    expect(html).toContain("이 화면을 떠나도");
    expect(html).not.toContain("다시 시도");
  });

  it("실패: 문구와 '다시 시도'(입력이 남아 있을 때만)", () => {
    const html = renderToStaticMarkup(<DraftProgress initialJob={job({ status: "failed", error: "AI 응답 거절", canRetry: true })} />);
    expect(html).toContain("AI 응답 거절");
    expect(html).toContain("다시 시도");
    const noRetry = renderToStaticMarkup(<DraftProgress initialJob={job({ status: "failed", error: "x", canRetry: false })} />);
    expect(noRetry).not.toContain(">다시 시도<");
  });

  it("완료: 이력서 열기 링크", () => {
    const html = renderToStaticMarkup(<DraftProgress initialJob={job({ status: "completed", stage: "saving", resumeId: "r9", completedAt: 5000 })} />);
    expect(html).toContain('href="/app/resumes/r9"');
    expect(html).toContain("4초");
  });
});

describe("DraftJobsStrip", () => {
  it("진행 중·실패 카드가 진행 화면으로 이어진다", () => {
    const html = renderToStaticMarkup(<DraftJobsStrip initialJobs={[job(), job({ id: "j2", status: "failed", label: "당근 · iOS" })]} />);
    expect(html).toContain('href="/app/resumes/drafts/j1"');
    expect(html).toContain("AI가 초안 쓰는 중");
    expect(html).toContain("다시 시도");
    expect(renderToStaticMarkup(<DraftJobsStrip initialJobs={[]} />)).toBe("");
  });

  it("anyJobFinished: 진행 중이던 작업이 끝났거나 사라졌으면 true", () => {
    expect(anyJobFinished([job()], [job()])).toBe(false);
    expect(anyJobFinished([job()], [job({ status: "failed" })])).toBe(true);
    expect(anyJobFinished([job()], [])).toBe(true);
    expect(anyJobFinished([job({ status: "failed" })], [])).toBe(false);
  });
});
