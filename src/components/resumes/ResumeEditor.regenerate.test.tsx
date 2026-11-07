/** 편집 화면의 '다시 생성'(정적 렌더): 버튼·진행 중 안내·완료 배너(이전 버전 비교·되돌리기)·버전 배지, 대화 상자 본문. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import type { ResumeMeta, ResumeVersionMeta } from "@/lib/resumes/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {} }) }));

const { ResumeEditor } = await import("./ResumeEditor");
const { regenerateRequestBody } = await import("./RegenerateDialog");

const AT = Date.UTC(2026, 10, 7, 5, 3);
const resume: ResumeMeta = {
  id: "r1",
  kind: "company",
  company: "토스",
  roleTitle: "백엔드",
  jdText: "Kotlin",
  templateId: "classic",
  title: "토스 백엔드",
  currentVersionId: "v3",
  postingId: null,
  sourceResumeId: null,
  applyStatus: "draft",
  applyStatusChangedAt: null,
  submittedApplicationId: null,
  portfolio: null,
  includePhoto: true,
  createdAt: AT,
  updatedAt: AT,
};
const versions: ResumeVersionMeta[] = [
  { id: "v3", versionNo: 3, note: "AI 다시 생성 (에이전트)", source: "ai", createdAt: AT },
  { id: "v2", versionNo: 2, note: null, source: "manual", createdAt: AT },
  { id: "v1", versionNo: 1, note: "경험 그래프로 만든 AI 초안", source: "ai", createdAt: AT },
];
const render = (props: Partial<Parameters<typeof ResumeEditor>[0]> = {}) =>
  renderToStaticMarkup(<ResumeEditor resume={resume} versions={versions} initialDocument={emptyResumeDocument()} currentVersionId="v3" {...props} />);

describe("ResumeEditor 다시 생성", () => {
  it("경험 그래프를 쓸 수 있으면 머리글에 '다시 생성' 버튼, 없으면 숨긴다", () => {
    expect(render({ regenerate: { agentAvailable: true, runningHref: null } })).toContain(">다시 생성</button>");
    expect(render({ regenerate: null })).not.toContain(">다시 생성</button>");
  });

  it("진행 중이면 버튼이 '다시 생성 중…'이고 진행 화면 링크를 보인다", () => {
    const html = render({ regenerate: { agentAvailable: true, runningHref: "/app/resumes/agent/j1" } });
    expect(html).toContain("다시 생성 중…");
    expect(html).toContain("이 이력서를 다시 생성하고 있습니다");
    expect(html).toContain('href="/app/resumes/agent/j1"');
  });

  it("?regenerated=1이고 현재 버전이 다시 생성 버전이면 배너(이전 버전과 비교·바로 앞 버전으로 되돌리기)", () => {
    const html = render({ regenerate: { agentAvailable: true, runningHref: null }, regenerated: true });
    expect(html).toContain("AI가 이력서를 다시 생성해 v3로 저장했습니다");
    expect(html).toContain("이전 버전과 비교");
    expect(html).toContain("이전 버전(v2)으로 되돌리기");
    expect(html).toContain("AI 다시 생성</span>");
  });

  it("현재 버전이 다시 생성 버전이 아니면 배너를 보이지 않는다", () => {
    const html = render({ regenerated: true, currentVersionId: "v2" });
    expect(html).not.toContain("이전 버전과 비교");
  });
});

describe("regenerateRequestBody", () => {
  const base = { mode: "agent" as const, kind: "company" as const, editJd: false, jdText: "새 JD", templateId: "classic" as const, currentTemplateId: "classic" as const, note: "  강조  " };
  it("JD는 고쳐 쓰기를 골랐을 때만, 양식은 바꿨을 때만 보낸다", () => {
    expect(regenerateRequestBody(base)).toEqual({ mode: "agent", note: "강조" });
    expect(regenerateRequestBody({ ...base, editJd: true, templateId: "modern" })).toEqual({ mode: "agent", jdText: "새 JD", templateId: "modern", note: "강조" });
    expect(regenerateRequestBody({ ...base, kind: "general", editJd: true })).toEqual({ mode: "agent", note: "강조" });
  });
});

describe("완료 뒤 여는 경로", () => {
  it("다시 생성이면 ?regenerated=1(에이전트는 리포트도 펼침), 새로 만들기는 그대로", async () => {
    const { completedResumeHref } = await import("@/lib/resumes/draft-job-types");
    const { agentCompletedHref } = await import("@/lib/resume-agent/job-types");
    expect(completedResumeHref({ resumeId: "r1", regenerate: true })).toBe("/app/resumes/r1?regenerated=1");
    expect(completedResumeHref({ resumeId: "r1" })).toBe("/app/resumes/r1");
    expect(agentCompletedHref({ resumeId: "r1", regenerate: true })).toBe("/app/resumes/r1?report=1&regenerated=1");
    expect(agentCompletedHref({ resumeId: "r1" })).toBe("/app/resumes/r1?report=1");
    expect(completedResumeHref({ resumeId: null })).toBeNull();
  });
});
