/** 이력서 머리글 사진(웹 미리보기): 모든 양식에서 사진 주소가 있으면 머리글에 img로, 없으면 그리지 않는다. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RESUME_TEMPLATE_IDS } from "@/lib/domain/resumes";
import { makeSampleResume } from "@/lib/resumes/__fixtures__/sample";
import { buildModel, ResumePreview } from "./ResumePreview";

const PHOTO = "/api/account/photo?v=abc123";

describe("ResumePreview 사진", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s: 사진이 있으면 머리글에 넣는다", (id) => {
    const html = renderToStaticMarkup(<ResumePreview document={makeSampleResume()} templateId={id} photoUrl={PHOTO} />);
    expect(html).toMatch(new RegExp(`<img[^>]*src="${PHOTO.replace(/[?]/g, "\\?")}"[^>]*data-resume-photo|<img[^>]*data-resume-photo[^>]*src="${PHOTO.replace(/[?]/g, "\\?")}"`));
    expect(html).toContain('alt="프로필 사진"');
    // 사진은 머리글 안(이름 옆)에만 한 번
    expect(html.match(/data-resume-photo/g)).toHaveLength(1);
  });

  it.each(RESUME_TEMPLATE_IDS)("%s: 사진이 없으면 img가 없다", (id) => {
    const html = renderToStaticMarkup(<ResumePreview document={makeSampleResume()} templateId={id} />);
    expect(html).not.toContain("data-resume-photo");
    expect(html).not.toContain("<img");
  });

  it("A4 쪽 나눔 모델: 사진은 머리글 블록 안에 있다(첫 쪽 머리글 높이에 포함)", () => {
    for (const id of ["classic", "developer"] as const) {
      const model = buildModel(makeSampleResume(), id, PHOTO);
      const header = model.header ?? model.main.find((a) => a.id === "header")!;
      expect(renderToStaticMarkup(<>{header.node}</>)).toContain("data-resume-photo");
      const others = [...model.main, ...model.side].filter((a) => a.id !== "header");
      for (const a of others) expect(renderToStaticMarkup(<>{a.node}</>)).not.toContain("data-resume-photo");
    }
  });
});
