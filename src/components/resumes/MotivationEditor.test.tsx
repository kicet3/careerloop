import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { appendMemo, memoLine, MotivationEditor } from "./MotivationEditor";

describe("MotivationEditor", () => {
  it("직접 쓰는 칸과 '추천 받기' 버튼, 글자 수를 보인다", () => {
    const html = renderToStaticMarkup(<MotivationEditor resumeId="r1" value="안녕" onChange={() => {}} />);
    expect(html).toContain(">지원 동기<");
    expect(html).toContain("추천 받기");
    expect(html).toContain("<textarea");
    expect(html).toContain('maxLength="1500"');
    expect(html).toContain("2 / 1500자");
    expect(html).toContain("문장은 쓰지 않습니다");
  });

  it("메모로 넣기: 글 끝에 [ADD: 메모 — …] 한 줄(대괄호 제거), 상한을 넘으면 넣지 않는다", () => {
    expect(memoLine("회사가 강조: [결제] 안정성")).toBe("- [ADD: 메모 — 회사가 강조: 결제 안정성]");
    expect(appendMemo("", "질문")).toBe("- [ADD: 메모 — 질문]");
    expect(appendMemo("첫 줄\n\n", "질문")).toBe("첫 줄\n- [ADD: 메모 — 질문]");
    expect(appendMemo("가".repeat(1490), "긴 메모 줄입니다")).toBeNull();
  });
});
