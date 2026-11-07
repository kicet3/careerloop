import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MonthInput, MonthPickerButton, MonthPickerPopover } from "./MonthInput";

const noop = () => {};

describe("MonthInput", () => {
  it("글 칸 + 달력 버튼(aria-label·aria-expanded) + 숨은 기본 선택기, 값을 그대로 보인다", () => {
    const html = renderToStaticMarkup(<MonthInput id="d1" value="2024-02" format="dash" onChange={noop} />);
    expect(html).toContain('id="d1"');
    expect(html).toContain('type="text"');
    expect(html).toContain('value="2024-02"');
    expect(html).toContain('aria-label="달력에서 고르기"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toMatch(/<input[^>]*type="month"[^>]*tabindex="-1"[^>]*aria-hidden="true"/i);
    expect(html).toContain('placeholder="예: 2024-02"');
    expect(html).not.toContain('type="checkbox"');
    expect(html).not.toContain("aria-invalid");
  });

  it("dot 형식 종료일: '현재' 체크, 값 '현재'면 체크됨", () => {
    const html = renderToStaticMarkup(<MonthInput value="현재" format="dot" allowCurrent onChange={noop} />);
    expect(html).toContain('placeholder="예: 2024.02"');
    expect(html).toMatch(/type="checkbox"[^>]*checked=""/);
    expect(html).toContain('value="현재"');
  });

  it("그래프 종료일(current 따로): 진행 중이면 칸은 비활성 '현재', 체크 이름은 받은 대로", () => {
    const on = renderToStaticMarkup(<MonthInput value="" format="dash" current onCurrentChange={noop} currentLabel="현재 재직 중" onChange={noop} />);
    expect(on).toMatch(/<input[^>]*type="text"[^>]*disabled=""[^>]*value="현재"/);
    expect(on).toContain("현재 재직 중");
    expect(on).toMatch(/type="checkbox"[^>]*checked=""/);
    const off = renderToStaticMarkup(<MonthInput value="2023-04" format="dash" current={false} onCurrentChange={noop} onChange={noop} />);
    expect(off).toContain('value="2023-04"');
    expect(off).not.toMatch(/type="checkbox"[^>]*checked=""/);
  });

  it("알아볼 수 없는 처음 값은 그대로 보이고 예시를 안내한다(aria-invalid·describedby)", () => {
    const html = renderToStaticMarkup(<MonthInput id="d2" value="작년 봄쯤" format="dot" onChange={noop} />);
    expect(html).toContain('value="작년 봄쯤"');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('aria-describedby="d2-hint"');
    expect(html).toContain('id="d2-hint"');
    expect(html).toContain("예: 2024.02");
  });

  it("시작일에 '현재'는 알아볼 수 없음으로 본다", () => {
    expect(renderToStaticMarkup(<MonthInput value="현재" format="dot" onChange={noop} />)).toContain('aria-invalid="true"');
  });
});

describe("MonthPickerButton·Popover", () => {
  it("버튼 이름을 바꿀 수 있다(시트 칸 옆)", () => {
    const html = renderToStaticMarkup(<MonthPickerButton value="" format="dot" label="최근 경력 시작 달력에서 고르기" onPick={noop} />);
    expect(html).toContain('aria-label="최근 경력 시작 달력에서 고르기"');
  });

  it("팝오버: dialog, 연도, 12달(고른 달 aria-pressed, 그 달만 tabindex=0), '현재' 단추", () => {
    const anchor = { current: null };
    const html = renderToStaticMarkup(
      <MonthPickerPopover id="p" anchor={anchor} initial={{ year: 2024, month: 2 }} onPick={noop} onPickCurrent={noop} onClose={noop} />,
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-labelledby="p-title"');
    expect(html).toContain("2024년");
    expect(html).toContain('aria-label="이전 해"');
    expect(html).toContain('aria-label="다음 해"');
    expect(html.match(/data-month="/g)).toHaveLength(12);
    expect(html).toMatch(/tabindex="0" aria-label="2024년 2월" aria-pressed="true"/);
    expect(html).toMatch(/tabindex="-1" aria-label="2024년 3월" aria-pressed="false"/);
    expect(html).toContain(">현재<");
  });

  it("값이 없으면 오늘이 있는 해·달에서 시작하고 '현재'는 없다", () => {
    const html = renderToStaticMarkup(
      <MonthPickerPopover id="p" anchor={{ current: null }} initial={null} today={new Date(2026, 10, 7)} onPick={noop} onClose={noop} />,
    );
    expect(html).toContain("2026년");
    expect(html).toMatch(/tabindex="0" aria-label="2026년 11월"/);
    expect(html).not.toContain(">현재<");
  });
});
