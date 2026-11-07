import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { emptyResumeDocument, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES } from "@/lib/domain/resumes";
import type { ResumeMeta } from "@/lib/resumes/types";
import { centeredScrollLeft, TemplatePicker, templateForKey } from "./TemplatePicker";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("templateForKey — 라디오 그룹 방향키", () => {
  const ids = RESUME_TEMPLATE_IDS;
  it("다음·이전은 끝에서 처음으로 돈다", () => {
    expect(templateForKey("ArrowRight", ids[0])).toBe(ids[1]);
    expect(templateForKey("ArrowDown", ids[0])).toBe(ids[1]);
    expect(templateForKey("ArrowRight", ids[ids.length - 1]!)).toBe(ids[0]);
    expect(templateForKey("ArrowLeft", ids[0])).toBe(ids[ids.length - 1]);
    expect(templateForKey("ArrowUp", ids[2]!)).toBe(ids[1]);
  });
  it("Home·End, 그 밖의 키는 null", () => {
    expect(templateForKey("Home", ids[3]!)).toBe(ids[0]);
    expect(templateForKey("End", ids[0])).toBe(ids[ids.length - 1]);
    expect(templateForKey("Enter", ids[0])).toBeNull();
    expect(templateForKey("a", ids[0])).toBeNull();
    expect(templateForKey("ArrowRight", ids[0], [])).toBeNull();
  });
});

describe("centeredScrollLeft", () => {
  it("카드를 가운데로, 양 끝은 범위 안으로 자른다", () => {
    expect(centeredScrollLeft(500, 160, 360, 1200)).toBe(400);
    expect(centeredScrollLeft(10, 160, 360, 1200)).toBe(0);
    expect(centeredScrollLeft(1040, 160, 360, 1200)).toBe(840);
    expect(centeredScrollLeft(100, 160, 1200, 1000)).toBe(0); // 스크롤할 게 없음
  });
});

describe("TemplatePicker", () => {
  it("모든 양식을 라디오 카드(축소 그림·이름·설명)로 보이고 고른 카드만 선택·탭 대상", () => {
    const html = renderToStaticMarkup(<TemplatePicker value="modern" onChange={() => {}} />);
    expect(html).toContain('role="radiogroup"');
    expect(html).toContain("overflow-x-auto");
    expect(html).toContain("snap-x");
    for (const id of RESUME_TEMPLATE_IDS) {
      expect(html).toContain(`data-template-option="${id}"`);
      expect(html).toContain(`data-thumbnail="${id}"`);
      expect(html).toContain(RESUME_TEMPLATES[id].name);
    }
    const checked = [...html.matchAll(/data-template-option="([a-z-]+)"/g)].map((m) => m[1]);
    expect(checked).toEqual([...RESUME_TEMPLATE_IDS]);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-checked="true" tabindex="0"[^>]*data-template-option="modern"/);
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain("ring-indigo-600");
  });

  it("편집 화면 상단에 양식 고르기가 나오고, 고른 양식으로 미리보기한다", async () => {
    const { ResumeEditor } = await import("./ResumeEditor");
    const resume: ResumeMeta = {
      id: "r1",
      kind: "company",
      company: "A사",
      roleTitle: "PM",
      jdText: null,
      templateId: "classic",
      title: "A사 PM",
      currentVersionId: "v1",
      postingId: null,
      sourceResumeId: null,
      applyStatus: "draft",
      applyStatusChangedAt: null,
      submittedApplicationId: null,
      portfolio: null,
      includePhoto: true,
      createdAt: 0,
      updatedAt: 0,
    };
    const doc = emptyResumeDocument();
    doc.basics.name = "홍길동";
    const html = renderToStaticMarkup(
      <ResumeEditor
        resume={resume}
        versions={[{ id: "v1", versionNo: 1, note: null, source: "manual", createdAt: 0 } as never]}
        initialDocument={doc}
        currentVersionId="v1"
      />,
    );
    expect(html).toContain("data-template-picker");
    expect(html).toMatch(/aria-checked="true"[^>]*data-template-option="classic"/);
    expect(html).toContain('data-template="classic"');
    // 버전 PDF 링크는 화면의 양식으로 만든다
    expect(html).toContain("/api/resumes/r1/pdf?version=v1&amp;template=classic");
    expect(html.indexOf("data-template-picker")).toBeLessThan(html.indexOf('data-template="classic"'));
  });
});
