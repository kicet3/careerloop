import { describe, expect, it } from "vitest";
import { detectKind, UPLOAD_EXTENSIONS } from "@/lib/ingest/extract";
import { formatsLabel, UPLOAD_ACCEPT, UPLOAD_FORMATS_LABEL, validateUpload } from "./FileDrop";

describe("업로드 허용 확장자", () => {
  it("화면 목록과 서버 목록이 같고, 모두 서버가 읽을 수 있다", () => {
    expect([...UPLOAD_ACCEPT].sort()).toEqual([...UPLOAD_EXTENSIONS].sort());
    for (const ext of UPLOAD_ACCEPT) expect(detectKind(`cv${ext}`, "")).not.toBeNull();
  });

  it("안내 문구는 대문자 형식 이름이고 .htm은 HTML과 합친다", () => {
    expect(UPLOAD_FORMATS_LABEL).toBe("PDF · DOCX · HWP · HWPX · HTML · TXT · MD");
    expect(formatsLabel([".htm"])).toBe("HTM");
  });

  it("DOC은 변환을 권하고, HWP는 받는다", () => {
    const file = (name: string) => new File(["x"], name);
    expect(validateUpload(file("cv.doc"), UPLOAD_ACCEPT)).toMatch(/DOCX나 PDF/);
    expect(validateUpload(file("이력서.HWP"), UPLOAD_ACCEPT)).toBeNull();
  });
});
