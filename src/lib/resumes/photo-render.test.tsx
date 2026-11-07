/**
 * 이력서 사진: PDF(모든 양식)에 사진 data URI를 넣으면 이미지가 들어가고 없으면 없다, data URI가 아닌 주소는 무시(서버가 공개 주소를 열지 않는다).
 * 사진은 이력서 문서(ResumeDocument = AI 구조화 출력 스키마)에 없다 — AI에 보내지 않는다.
 */
import sharp from "sharp";
import { z } from "zod";
import { describe, expect, it, vi } from "vitest";
import { RESUME_TEMPLATE_IDS, ResumeDocumentSchema } from "@/lib/domain/resumes";
import { makeSampleResume } from "./__fixtures__/sample";
import { resumeToText } from "./layout";
import { renderResumePdf } from "./pdf";

vi.mock("server-only", () => ({}));

const hasImage = (pdf: Uint8Array) => /\/Subtype\s*\/Image/.test(Buffer.from(pdf).toString("latin1"));

describe("이력서 PDF 사진", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s: 사진이 있으면 이미지가 들어가고, 없으면 없다", async (id) => {
    const jpeg = await sharp({ create: { width: 600, height: 800, channels: 3, background: "#8899aa" } }).jpeg().toBuffer();
    const photo = `data:image/jpeg;base64,${jpeg.toString("base64")}`;
    const withPhoto = await renderResumePdf(makeSampleResume(), id, { photo });
    const without = await renderResumePdf(makeSampleResume(), id);
    expect(hasImage(withPhoto)).toBe(true);
    expect(hasImage(without)).toBe(false);
  }, 60_000);

  it("data URI가 아닌 사진 주소(공개 URL·파일 경로)는 무시한다", async () => {
    for (const photo of ["https://example.com/a.jpg", "/etc/passwd", "file:///tmp/a.jpg"]) {
      expect(hasImage(await renderResumePdf(makeSampleResume(), "classic", { photo }))).toBe(false);
    }
  }, 60_000);
});

describe("사진은 AI에 보내지 않는다", () => {
  it("이력서 문서 스키마(AI 초안 구조화 출력)와 진단용 텍스트에 사진 칸이 없다", () => {
    const schema = JSON.stringify(z.toJSONSchema(ResumeDocumentSchema));
    expect(schema).not.toMatch(/photo|사진|image/i);
    expect(resumeToText(makeSampleResume(), "classic")).not.toMatch(/photo|data:image/i);
  });
});
