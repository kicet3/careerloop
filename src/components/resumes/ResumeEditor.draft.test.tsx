/** 편집 화면의 임시 저장 표시(정적 렌더): 작업본을 불러온 알림·충돌 알림·상태 배지·버튼. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import type { ResumeEditDraftView, ResumeMeta, ResumeVersionMeta } from "@/lib/resumes/types";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: () => {}, refresh: () => {} }) }));

const { ResumeEditor } = await import("./ResumeEditor");

const AT = Date.UTC(2026, 10, 7, 5, 3); // 14:03 KST
const resume: ResumeMeta = {
  id: "r1",
  kind: "company",
  company: "토스",
  roleTitle: "백엔드",
  jdText: null,
  templateId: "classic",
  title: "토스 백엔드",
  currentVersionId: "v2",
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
  { id: "v2", versionNo: 2, note: "AI로 다듬기 · 요약", source: "ai", createdAt: AT },
  { id: "v1", versionNo: 1, note: null, source: "manual", createdAt: AT },
];
function draft(baseVersionId: string): ResumeEditDraftView {
  const d = emptyResumeDocument();
  d.basics.name = "작업본 이름";
  return { baseVersionId, templateId: null, document: d, updatedAt: AT };
}
const render = (initialDraft: ResumeEditDraftView | null) =>
  renderToStaticMarkup(
    <ResumeEditor resume={resume} versions={versions} initialDocument={emptyResumeDocument()} currentVersionId="v2" initialDraft={initialDraft} />,
  );

describe("ResumeEditor 임시 저장", () => {
  it("작업본이 없으면 알림 없이 '임시 저장'·'저장(새 버전)' 버튼만", () => {
    const html = render(null);
    expect(html).toContain("임시 저장</button>");
    expect(html).toContain("저장(새 버전)");
    expect(html).not.toContain("임시 저장본을 불러왔습니다");
    expect(html).not.toContain("임시 저장 버리기");
  });

  it("현재 버전을 바탕으로 한 작업본은 그 내용으로 열고 '불러왔습니다 (HH:MM)' 알림과 상태 배지를 보인다", () => {
    const html = render(draft("v2"));
    expect(html).toContain("임시 저장본을 불러왔습니다 (14:03)");
    expect(html).toContain("버리고 저장된 버전 보기");
    expect(html).toContain("임시 저장됨 · 14:03");
    expect(html).toContain("임시 저장 버리기");
    expect(html).toContain("작업본 이름");
    expect(html).not.toContain("임시 저장본 이후에 새 버전이 저장됐습니다");
  });

  it("작업본의 기준 버전이 현재가 아니면 충돌 알림(유지·버리기)을 보이고 새 버전 저장을 막는다", () => {
    const html = render(draft("v1"));
    expect(html).toContain("임시 저장본 이후에 새 버전이 저장됐습니다");
    expect(html).toContain("v1을(를) 바탕으로 했는데, 그 뒤에 v2이(가) 저장됐습니다");
    expect(html).toContain("임시 저장본 유지");
    expect(html).toContain("임시 저장본 버리고 최신 버전 보기");
    expect(html).not.toContain("임시 저장본을 불러왔습니다");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*title="임시 저장본을 어떻게 할지 먼저 골라 주세요"/);
  });
});
