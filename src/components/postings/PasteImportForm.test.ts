/** 붙여넣기 입력의 화면 검사(서버 PostingPasteImportInputSchema와 같은 길이 규칙, 링크는 선택). */
import { describe, expect, it } from "vitest";
import { POSTING_LIMITS, POSTING_PASTE_MIN_CHARS, PostingPasteImportInputSchema } from "@/lib/domain/postings";
import { pasteImportProblem } from "./PasteImportForm";

describe("pasteImportProblem", () => {
  it("링크 없이 본문만으로 통과하고, 길이 범위 밖이면 서버와 같은 안내", () => {
    const ok = "가".repeat(POSTING_PASTE_MIN_CHARS);
    expect(pasteImportProblem(ok)).toBeNull();
    expect(PostingPasteImportInputSchema.parse({ pageText: ok })).toEqual({ url: "", pageText: ok });
    expect(pasteImportProblem("가".repeat(POSTING_PASTE_MIN_CHARS - 1))).toContain("너무 짧습니다");
    expect(pasteImportProblem(`  ${"가".repeat(POSTING_PASTE_MIN_CHARS - 1)}  `)).toContain("너무 짧습니다");
    expect(pasteImportProblem("가".repeat(POSTING_LIMITS.jdText + 1))).toContain("30,000자");
  });
});
