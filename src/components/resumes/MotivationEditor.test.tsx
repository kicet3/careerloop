import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { MotivationSuggestResponse } from "@/lib/domain/resume-motivation";
import { appendDraft, appendMemo, fillWithDraft, memoLine, MotivationEditor, MotivationSuggestionPanel, parseFolds, toggleAllFolds, type FoldState } from "./MotivationEditor";

const suggestion: MotivationSuggestResponse["suggestion"] = {
  companyPoints: [{ point: "결제 안정성", jdQuote: "결제 안정성" }],
  linkedExperiences: [{ nodeId: "p1", name: "주문 시스템 개편", kind: "프로젝트", why: "결제 흐름 개선" }],
  outline: [{ heading: "지원 계기", guide: "계기를 적어 보세요" }],
  questions: ["회사를 알게 된 계기는?"],
  cautions: ["회사 칭찬만 나열하지 마세요"],
  draft: "[ADD: 이 회사를 알게 된 계기] 주문 시스템 개편 경험을 결제 안정성에 잇고 싶습니다.",
};
const noop = () => {};
const panel = (folds: FoldState, s = suggestion) =>
  renderToStaticMarkup(<MotivationSuggestionPanel suggestion={s} folds={folds} onToggle={noop} onToggleAll={noop} onFill={noop} onAppend={noop} onMemo={noop} />);

describe("MotivationEditor", () => {
  it("직접 쓰는 칸과 '추천 받기' 버튼, 글자 수를 보인다", () => {
    const html = renderToStaticMarkup(<MotivationEditor resumeId="r1" value="안녕" onChange={() => {}} />);
    expect(html).toContain(">지원 동기<");
    expect(html).toContain("추천 받기");
    expect(html).toContain("<textarea");
    expect(html).toContain('maxLength="1500"');
    expect(html).toContain("2 / 1500자");
    expect(html).toContain("칸에 바로 넣지 않습니다");
  });

  it("메모로 넣기: 글 끝에 [ADD: 메모 — …] 한 줄(대괄호 제거), 상한을 넘으면 넣지 않는다", () => {
    expect(memoLine("회사가 강조: [결제] 안정성")).toBe("- [ADD: 메모 — 회사가 강조: 결제 안정성]");
    expect(appendMemo("", "질문")).toBe("- [ADD: 메모 — 질문]");
    expect(appendMemo("첫 줄\n\n", "질문")).toBe("첫 줄\n- [ADD: 메모 — 질문]");
    expect(appendMemo("가".repeat(1490), "긴 메모 줄입니다")).toBeNull();
  });

  it("추천 묶음: 초안 카드(채우기·덧붙이기)가 먼저, 묶음마다 aria-expanded 토글, 기본은 모두 펼침", () => {
    const html = panel({});
    expect(html.indexOf("초안으로 채우기")).toBeGreaterThan(-1);
    expect(html).toContain("아래에 덧붙이기");
    expect(html.indexOf(">초안<")).toBeLessThan(html.indexOf("회사가 강조하는 점"));
    for (const t of ["회사가 강조하는 점", "연결할 경험", "구성안", "확인 질문", "주의"]) expect(html).toContain(t);
    expect(html.match(/aria-expanded="true"/g)).toHaveLength(6);
    expect(html).not.toContain('aria-expanded="false"');
    expect(html).toContain("모두 접기");
    expect(html).toContain("주문 시스템 개편 경험을 결제 안정성에 잇고 싶습니다.");
  });

  it("추천 묶음: 접힌 묶음은 aria-expanded=false이고 내용이 빠진다, 모두 접히면 '모두 펼치기'", () => {
    const html = panel({ draft: true, questions: true });
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(2);
    expect(html).not.toContain("초안으로 채우기");
    expect(html).not.toContain("회사를 알게 된 계기는?");
    expect(html).toContain("결제 안정성");
    const all = panel({ draft: true, points: true, experiences: true, outline: true, questions: true, cautions: true });
    expect(all).toContain("모두 펼치기");
    expect(all).not.toContain('aria-expanded="true"');
    // 초안이 없는(예전 서버) 응답: 초안 카드 없이 나머지만.
    const old = panel({}, { ...suggestion, draft: undefined as unknown as string });
    expect(old).not.toContain("초안으로 채우기");
    expect(old.match(/aria-expanded="true"/g)).toHaveLength(5);
  });

  it("모두 접기/펼치기·저장된 접힘 상태 읽기", () => {
    const visible = ["draft", "points", "questions"] as const;
    expect(toggleAllFolds({}, visible)).toEqual({ draft: true, points: true, questions: true });
    expect(toggleAllFolds({ draft: true }, visible)).toEqual({ draft: true, points: true, questions: true });
    expect(toggleAllFolds({ draft: true, points: true, questions: true }, visible)).toEqual({ draft: false, points: false, questions: false });
    expect(parseFolds('{"draft":true,"outline":false,"x":true}')).toEqual({ draft: true });
    expect(parseFolds("깨진 값")).toEqual({});
    expect(parseFolds(null)).toEqual({});
  });

  it("초안으로 채우기: 빈 칸은 바로, 글이 있으면 확인 후 바꾸기(취소하면 그대로)", () => {
    let asked = 0;
    const yes = () => (asked++, true);
    expect(fillWithDraft("  ", " 초안 ", yes)).toBe("초안");
    expect(asked).toBe(0);
    expect(fillWithDraft("내 글", "초안", yes)).toBe("초안");
    expect(asked).toBe(1);
    expect(fillWithDraft("내 글", "초안", () => false)).toBeNull();
    expect(fillWithDraft("", "", yes)).toBeNull();
  });

  it("아래에 덧붙이기: 빈 줄을 두고 붙이고, 상한을 넘으면 넣지 않는다", () => {
    expect(appendDraft("", "초안")).toBe("초안");
    expect(appendDraft("내 글\n\n", "초안")).toBe("내 글\n\n초안");
    expect(appendDraft("가".repeat(1490), "열 글자가 넘는 초안")).toBeNull();
  });
});
