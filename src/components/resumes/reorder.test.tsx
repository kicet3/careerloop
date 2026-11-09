/**
 * 이력서 편집 목록 순서 바꾸기(reorder.ts): 항목 key가 항목을 따라가는지, 끌기·터치·키보드·버튼 처리, 그리고
 * 구조화 폼·성과 시트의 컨트롤(정적 렌더)과 미리보기·인쇄에 컨트롤이 없는지.
 * DOM 환경(jsdom)이 없는 프로젝트라 이벤트 처리는 컴포넌트가 붙이는 같은 핸들러(reorderHandlers)에 가짜 이벤트를 넣어 본다.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_RESUME_ITEM, emptyResumeDocument, RESUME_SECTION_KEYS, ResumeDocumentSchema, type ResumeDocument } from "@/lib/domain/resumes";
import { PerformanceSheet } from "./PerformanceSheet";
import { DRAG_TYPE, IDLE, itemKey, itemKeys, moveItem, movedMessage, patchItem, reorderHandlers, type ReorderState } from "./reorder";
import { ResumeDocumentForm } from "./ResumeDocumentForm";
import { ResumePreview } from "./ResumePreview";

const exp = (company: string, startDate = "", bullets: string[] = []) => ({ ...EMPTY_RESUME_ITEM.experience(), company, startDate, bullets });
const proj = (name: string) => ({ ...EMPTY_RESUME_ITEM.project(), name });

function docWith(experience = [exp("A사", "2023.01", ["a1", "a2"]), exp("B사", "2020.05", ["b1"]), exp("C사")], projects = [proj("P1"), proj("P2")]) {
  const doc = emptyResumeDocument();
  doc.experience = experience;
  doc.projects = projects;
  return doc;
}

/** 가짜 상태 저장소 + 핸들러. */
function harness(
  count: number,
  opts: { hitTest?: (x: number, y: number) => Element | null; inside?: (x: number, y: number) => boolean } = {},
) {
  let state: ReorderState = IDLE;
  const onMove = vi.fn();
  const onHint = vi.fn();
  const h = () =>
    reorderHandlers({ group: "g1", count, get: () => state, set: (s) => (state = s), onMove, onHint, hitTest: opts.hitTest, inside: opts.inside });
  return { h, onMove, onHint, state: () => state };
}

const dragEvent = () => {
  const dataTransfer = { effectAllowed: "", dropEffect: "", setData: vi.fn(), setDragImage: vi.fn() };
  return { preventDefault: vi.fn(), dataTransfer, currentTarget: null };
};

describe("moveItem", () => {
  it("from 항목을 to 자리로 옮긴다(나머지 순서 유지)", () => {
    expect(moveItem(["a", "b", "c", "d"], 0, 2)).toEqual(["b", "c", "a", "d"]);
    expect(moveItem(["a", "b", "c", "d"], 3, 0)).toEqual(["d", "a", "b", "c"]);
  });
  it("같은 자리·범위 밖은 원래 배열", () => {
    const xs = ["a", "b"];
    expect(moveItem(xs, 1, 1)).toBe(xs);
    expect(moveItem(xs, 0, 2)).toBe(xs);
    expect(moveItem(xs, -1, 0)).toBe(xs);
  });
});

describe("항목 key(화면 전용 정체성)", () => {
  it("순서를 바꿔도 key는 항목을 따라간다(자리 번호 key 버그 회귀)", () => {
    const doc = docWith();
    const before = itemKeys(doc.experience);
    const moved = moveItem(doc.experience, 0, 2);
    const after = itemKeys(moved);
    // A사 카드(불릿 원문 "a1\na2"·시작 2023.01을 들고 있는 ListText·MonthInput 포함)가 같은 key로 세 번째 자리에 간다.
    expect(after).toEqual([before[1], before[2], before[0]]);
    expect(moved[2]).toMatchObject({ company: "A사", startDate: "2023.01", bullets: ["a1", "a2"] });
  });

  it("항목을 고쳐도(patchItem) key를 이어받고, 고친 뒤 옮겨도 같은 key", () => {
    const xs = docWith().experience;
    const k0 = itemKey(xs[0]!);
    const edited = xs.map((x, i) => (i === 0 ? patchItem(x, { bullets: ["a1", "", "a2"] }) : x));
    expect(edited[0]).not.toBe(xs[0]);
    expect(itemKey(edited[0]!)).toBe(k0);
    expect(itemKeys(moveItem(edited, 0, 1))[1]).toBe(k0);
  });

  it("바깥에서 새로 만든 항목(복원 등)은 새 key, 같은 객체가 두 번 있어도 key가 겹치지 않는다", () => {
    const a = exp("A사");
    expect(itemKey({ ...a })).not.toBe(itemKey(a));
    const ks = itemKeys([a, a]);
    expect(new Set(ks).size).toBe(2);
  });

  it("저장 문서에는 key가 들어가지 않는다(스키마 그대로 통과)", () => {
    const doc = docWith();
    itemKeys(doc.experience);
    const moved: ResumeDocument = { ...doc, experience: moveItem(doc.experience, 0, 1).map((x) => patchItem(x, { title: "리드" })) };
    const json = JSON.parse(JSON.stringify(moved));
    expect(Object.keys(json.experience[0]).sort()).toEqual(Object.keys(EMPTY_RESUME_ITEM.experience()).sort());
    expect(ResumeDocumentSchema.safeParse(json).success).toBe(true);
  });
});

describe("reorderHandlers", () => {
  it("위/아래 버튼: 처음·끝에서는 막히고, 누르면 한 칸 옮긴다", () => {
    const { h, onMove } = harness(3);
    expect(h().up(0).disabled).toBe(true);
    expect(h().down(0).disabled).toBe(false);
    expect(h().up(2).disabled).toBe(false);
    expect(h().down(2).disabled).toBe(true);
    h().down(0).onClick();
    expect(onMove).toHaveBeenLastCalledWith(0, 1, "down");
    h().up(2).onClick();
    expect(onMove).toHaveBeenLastCalledWith(2, 1, "up");
  });

  it("HTML5 끌기: dragStart → dragOver → drop이면 놓은 자리로 옮긴다", () => {
    const { h, onMove, state } = harness(3);
    const start = dragEvent();
    h().handle(0).onDragStart(start);
    expect(start.dataTransfer.effectAllowed).toBe("move");
    // 입력 칸이 받는 text/plain이 아니어야 목록 밖 칸에 놓아도 글이 들어가지 않는다.
    expect(start.dataTransfer.setData).toHaveBeenCalledWith(DRAG_TYPE, "");
    expect(start.dataTransfer.setData).not.toHaveBeenCalledWith("text/plain", expect.anything());
    expect(state()).toMatchObject({ from: 0, over: 0 });

    const over = dragEvent();
    h().item(2).onDragOver(over);
    expect(over.preventDefault).toHaveBeenCalled();
    expect(over.dataTransfer.dropEffect).toBe("move");
    expect(state().over).toBe(2);

    const drop = dragEvent();
    h().item(2).onDrop(drop);
    expect(drop.preventDefault).toHaveBeenCalled();
    expect(onMove).toHaveBeenCalledWith(0, 2);
    expect(state()).toEqual(IDLE);
    h().handle(0).onDragEnd();
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("이 목록에서 시작하지 않은 끌기(파일·다른 목록)는 받지 않는다", () => {
    const { h, onMove } = harness(3);
    const over = dragEvent();
    h().item(1).onDragOver(over);
    expect(over.preventDefault).not.toHaveBeenCalled();
    h().item(1).onDrop(dragEvent());
    expect(onMove).not.toHaveBeenCalled();
  });

  it("제자리에 놓거나 끌기를 취소하면 옮기지 않는다", () => {
    const { h, onMove, state } = harness(3);
    h().handle(1).onDragStart(dragEvent());
    h().item(1).onDrop(dragEvent());
    h().handle(1).onDragStart(dragEvent());
    h().item(2).onDragOver(dragEvent());
    h().handle(1).onDragEnd();
    expect(onMove).not.toHaveBeenCalled();
    expect(state()).toEqual(IDLE);
  });

  it("터치(포인터): 손잡이를 누른 채 다른 항목 위로 옮겨 떼면 그 자리로", () => {
    const items = [0, 1, 2].map((i) => ({ getAttribute: (n: string) => (n === "data-reorder-item" ? String(i) : "g1") }));
    const other = { getAttribute: (n: string) => (n === "data-reorder-item" ? "0" : "other-list") };
    let under: unknown = null;
    const el = (target: unknown) => ({ closest: () => target }) as unknown as Element;
    const { h, onMove, state } = harness(3, { hitTest: () => el(under) });
    const capture = vi.fn();
    const p = (x: Partial<{ pointerType: string; pointerId: number }> = {}) => ({
      pointerId: 7,
      pointerType: "touch",
      clientX: 0,
      clientY: 0,
      preventDefault: vi.fn(),
      currentTarget: { setPointerCapture: capture },
      ...x,
    });

    // 마우스는 HTML5 끌기에 맡긴다.
    h().handle(0).onPointerDown(p({ pointerType: "mouse" }));
    expect(state()).toEqual(IDLE);

    h().handle(0).onPointerDown(p());
    expect(capture).toHaveBeenCalledWith(7);
    expect(state()).toMatchObject({ from: 0, pointerId: 7 });
    under = other; // 다른 목록 위는 무시
    h().handle(0).onPointerMove(p());
    expect(state().over).toBe(0);
    under = items[2];
    h().handle(0).onPointerMove(p({ pointerId: 8 })); // 다른 손가락
    expect(state().over).toBe(0);
    h().handle(0).onPointerMove(p());
    expect(state().over).toBe(2);
    // 터치 끌기 중에는 HTML5 drop을 받지 않는다(이중 처리 방지).
    h().item(1).onDrop(dragEvent());
    expect(onMove).not.toHaveBeenCalled();
    h().handle(0).onPointerUp(p());
    expect(onMove).toHaveBeenCalledWith(0, 2);
    expect(state()).toEqual(IDLE);

    h().handle(1).onPointerDown(p());
    h().handle(1).onPointerCancel(p());
    expect(state()).toEqual(IDLE);
    expect(onMove).toHaveBeenCalledTimes(1);
  });

  it("터치(포인터): 목록 밖에서 떼면 취소, 항목 사이 틈(목록 안)에서 떼면 마지막으로 지난 자리로", () => {
    const item2 = { getAttribute: (n: string) => (n === "data-reorder-item" ? "2" : "g1") };
    let under: unknown = null;
    let inList = false;
    const { h, onMove, state } = harness(3, {
      hitTest: () => ({ closest: () => under }) as unknown as Element,
      inside: () => inList,
    });
    const p = { pointerId: 3, pointerType: "touch", clientX: 0, clientY: 0, preventDefault: vi.fn(), currentTarget: null };

    h().handle(0).onPointerDown(p);
    under = item2;
    h().handle(0).onPointerMove(p);
    expect(state().over).toBe(2);
    under = null; // 목록 밖(다른 섹션·화면 밖)
    h().handle(0).onPointerUp(p);
    expect(onMove).not.toHaveBeenCalled();
    expect(state()).toEqual(IDLE);

    h().handle(0).onPointerDown(p);
    under = item2;
    h().handle(0).onPointerMove(p);
    under = null;
    inList = true; // 항목 사이 틈
    h().handle(0).onPointerUp(p);
    expect(onMove).toHaveBeenCalledWith(0, 2);
  });

  it("키보드: 손잡이에서 Enter·Space는 사용법을 알리고 옮기지 않는다", () => {
    const { h, onMove, onHint } = harness(3);
    for (const k of ["Enter", " "]) {
      const ev = { key: k, preventDefault: vi.fn() };
      h().handle(1).onKeyDown(ev);
      expect(ev.preventDefault).toHaveBeenCalled();
    }
    expect(onHint).toHaveBeenCalledTimes(2);
    expect(onMove).not.toHaveBeenCalled();
  });

  it("키보드: 손잡이에서 ↑↓ 한 칸, Home/End 맨 위·아래, 끝에서는 그대로", () => {
    const { h, onMove } = harness(4);
    const key = (k: string, extra = {}) => ({ key: k, preventDefault: vi.fn(), ...extra });
    h().handle(1).onKeyDown(key("ArrowUp"));
    expect(onMove).toHaveBeenLastCalledWith(1, 0, "handle");
    h().handle(1).onKeyDown(key("ArrowDown"));
    expect(onMove).toHaveBeenLastCalledWith(1, 2, "handle");
    h().handle(2).onKeyDown(key("Home"));
    expect(onMove).toHaveBeenLastCalledWith(2, 0, "handle");
    h().handle(1).onKeyDown(key("End"));
    expect(onMove).toHaveBeenLastCalledWith(1, 3, "handle");
    onMove.mockClear();
    h().handle(0).onKeyDown(key("ArrowUp"));
    h().handle(3).onKeyDown(key("End"));
    h().handle(1).onKeyDown(key("ArrowUp", { metaKey: true }));
    const tab = key("Tab");
    h().handle(1).onKeyDown(tab);
    expect(tab.preventDefault).not.toHaveBeenCalled();
    expect(onMove).not.toHaveBeenCalled();
  });

  it("알림 문장", () => {
    expect(movedMessage("경력 1(A사)", 2, 3)).toBe("경력 1(A사)을(를) 3번째로 옮겼습니다. 전체 3개.");
  });
});

const tagWith = (html: string, label: string) => html.match(new RegExp(`<[^>]*aria-label="${label}"[^>]*>`))?.[0] ?? "";

describe("구조화 폼(ResumeDocumentForm) 순서 컨트롤", () => {
  const html = renderToStaticMarkup(<ResumeDocumentForm value={docWith()} onChange={() => {}} sectionOrder={RESUME_SECTION_KEYS} />);

  it("경력·프로젝트 카드마다 손잡이·위·아래, 처음/끝 버튼은 막힌다", () => {
    expect(tagWith(html, "경력 1 위로 이동")).toContain('disabled=""');
    expect(tagWith(html, "경력 1 아래로 이동")).not.toContain('disabled=""');
    expect(tagWith(html, "경력 3 아래로 이동")).toContain('disabled=""');
    expect(tagWith(html, "프로젝트 2 아래로 이동")).toContain('disabled=""');
    expect(tagWith(html, "프로젝트 1 위로 이동")).toContain('disabled=""');
    const handle = tagWith(html, "경력 2 순서 바꾸기");
    expect(handle).toContain('draggable="true"');
    expect(handle).toContain('role="button"');
    expect(handle).toContain('tabindex="0"');
    expect(html.match(/data-reorder-item="\d+"/g)?.length).toBeGreaterThanOrEqual(5);
    expect(html).toContain('aria-live="polite"');
  });

  it("항목이 하나뿐이면 순서 컨트롤을 그리지 않는다", () => {
    const one = renderToStaticMarkup(
      <ResumeDocumentForm value={docWith([exp("A사")], [proj("P1")])} onChange={() => {}} sectionOrder={RESUME_SECTION_KEYS} />,
    );
    expect(one).not.toContain("경력 1 위로 이동");
    expect(one).not.toContain("경력 1 순서 바꾸기");
    expect(one).toContain('aria-label="경력 1 삭제"');
  });

  it("옮긴 문서를 그리면 카드 순서·칸 값이 항목을 따라간다", () => {
    const doc = docWith();
    const moved = renderToStaticMarkup(
      <ResumeDocumentForm value={{ ...doc, experience: moveItem(doc.experience, 0, 2) }} onChange={() => {}} sectionOrder={RESUME_SECTION_KEYS} />,
    );
    const at = (s: string) => moved.indexOf(s);
    expect(at('value="B사"')).toBeLessThan(at('value="C사"'));
    expect(at('value="C사"')).toBeLessThan(at('value="A사"'));
    // A사의 시작일·불릿이 A사 카드(세 번째) 안에 있다.
    expect(at('value="2023.01"')).toBeGreaterThan(at('value="A사"'));
    expect(moved.indexOf("a1\na2")).toBeGreaterThan(at('value="A사"'));
  });
});

describe("성과 시트(PerformanceSheet) 순서 컨트롤", () => {
  it("편집 모드: 경력·프로젝트마다 손잡이·위·아래(여백에 띄운 pf-reorder), 처음/끝 버튼은 막힌다", () => {
    const html = renderToStaticMarkup(<PerformanceSheet document={docWith()} onChange={() => {}} />);
    expect(html.split('class="pf-reorder"').length - 1).toBe(5);
    expect(tagWith(html, "최근 경력 위로 이동")).toContain('disabled=""');
    expect(tagWith(html, "3번째 경력 아래로 이동")).toContain('disabled=""');
    expect(tagWith(html, "2번째 경력 위로 이동")).not.toContain('disabled=""');
    expect(tagWith(html, "첫 프로젝트 순서 바꾸기")).toContain('draggable="true"');
    expect(tagWith(html, "2번째 프로젝트 아래로 이동")).toContain('disabled=""');
    expect(html).toMatch(/<article[^>]*data-item="experience\.1"[^>]*data-reorder-item="1"/);
    // 알림 영역은 본문(쪽 나눔 측정 대상) 밖.
    const body = html.slice(html.indexOf('class="pf-body"'));
    expect(html).toContain('aria-live="polite"');
    expect(body.indexOf('aria-live="polite"')).toBeGreaterThan(body.indexOf("</article>"));
  });

  it("옮긴 순서대로 칸 값이 그려진다", () => {
    const doc = docWith();
    const html = renderToStaticMarkup(<PerformanceSheet document={{ ...doc, projects: moveItem(doc.projects, 1, 0) }} onChange={() => {}} />);
    expect(html.indexOf(">P2<")).toBeLessThan(html.indexOf(">P1<"));
    expect(html).toMatch(/data-field="projects\.0\.name"[^>]*>P2</);
  });

  it("항목이 하나면 컨트롤 없음, 읽기 전용·미리보기에는 순서 컨트롤·끌기 속성이 없다", () => {
    const one = renderToStaticMarkup(<PerformanceSheet document={docWith([exp("A사")], [proj("P1")])} onChange={() => {}} />);
    expect(one).not.toContain("pf-reorder");
    for (const html of [
      renderToStaticMarkup(<PerformanceSheet document={docWith()} />),
      renderToStaticMarkup(<ResumePreview document={docWith()} templateId="performance" />),
      renderToStaticMarkup(<ResumePreview document={docWith()} templateId="classic" />),
    ]) {
      expect(html).not.toContain("pf-reorder");
      expect(html).not.toContain("data-reorder");
      expect(html).not.toContain("순서 바꾸기");
      expect(html).not.toContain("draggable");
    }
  });

  it("미리보기는 바뀐 순서를 그대로 보인다", () => {
    const doc = docWith();
    const moved = { ...doc, experience: moveItem(doc.experience, 2, 0) };
    for (const templateId of ["performance", "classic"] as const) {
      const html = renderToStaticMarkup(<ResumePreview document={moved} templateId={templateId} />);
      expect(html.indexOf("C사")).toBeLessThan(html.indexOf("A사"));
      expect(html.indexOf("A사")).toBeLessThan(html.indexOf("B사"));
    }
  });

  it("인쇄(@media print)에서도 순서 컨트롤을 숨긴다", () => {
    const sheetCss = readFileSync(path.join(import.meta.dirname, "performance-sheet.css"), "utf8");
    const print = sheetCss.slice(sheetCss.indexOf("@media print"));
    expect(print.slice(0, print.indexOf("display: none"))).toContain(".pf-reorder");
    // 여백에 띄운다(쪽 나눔 측정에서 빠진다: sheet-pagination은 absolute 요소를 뺀다).
    expect(sheetCss).toMatch(/\.pf-reorder \{\s*position: absolute;/);
  });
});
