"use client";

/**
 * 성과 중심 시트(PerformanceSheet)의 쪽 나눔. 시트는 편집 중인 칸(contenteditable)을 품고 있어 DOM을 쪽마다 옮기면
 * 커서·한글 조합이 끊긴다. 그래서 DOM은 그대로 두고, 다음 쪽으로 넘길 블록 앞에 여백(push)만 넣어 A4 쪽 카드 위치에 맞춘다.
 *
 *  1. 본문(.pf-body)을 복제해 같은 폭의 숨은 칸에 넣고(앞서 넣은 여백은 지운 채) 블록 위치를 잰다.
 *     블록: 머리글, 섹션 머리(테두리·라벨 ~ 첫 항목 위), 항목 한 줄(핵심 성과 하나·경력 한 건·프로젝트 한 건…), 항목 안의 줄.
 *  2. paginate(src/lib/resumes/pagination.ts)로 쪽을 나눈다 — PDF(pdf-performance.tsx)와 같은 규칙:
 *     항목은 통째로 넘기고, 섹션 머리는 첫 항목과 함께, 한 쪽보다 큰 항목만 줄 단위로 나눈다.
 *  3. 각 쪽 첫 블록에 여백을 줘 (쪽 높이 + 쪽 간격) 위치에서 시작하게 한다. 섹션은 margin-top(위 테두리가 함께 내려가게),
 *     그 밖의 블록은 padding-top.
 */
import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { A4, mmToPx, paginate, type PageAtom } from "@/lib/resumes/pagination";

/** 쪽 카드 사이 간격(px). performance-sheet.css의 --pf-page-gap과 같다. */
export const SHEET_PAGE_GAP = 28;
/** A4 297mm에서 위아래 여백 15mm씩을 뺀 본문 높이. */
export const SHEET_BODY_PX = mmToPx(267);
/** 이 너비 이하에서는 시트가 A4가 아닌 모바일 배치라 쪽을 나누지 않는다(performance-sheet.css @media max-width: 600px). */
export const MOBILE_QUERY = "(max-width: 600px)";
const PUSH_ATTR = "data-pg-push";

type Kind = "margin" | "padding";
export interface SheetBlock {
  atom: PageAtom;
  /** 본문 기준 경로(자식 순서). 복제본과 실제 DOM이 같은 구조라 경로로 실제 요소를 찾는다. */
  path: number[];
  kind: Kind;
  /** 복제본에서 잰 원래 margin/padding-top(px). */
  base: number;
  top: number;
}

const isSkipped = (el: Element) =>
  el.tagName === "BUTTON" || getComputedStyle(el).position === "absolute";
const isList = (el: Element) => el.tagName === "UL" || el.tagName === "OL";

function pathOf(root: Element, el: Element): number[] {
  const path: number[] = [];
  let cur: Element | null = el;
  while (cur && cur !== root) {
    const parent: Element | null = cur.parentElement;
    if (!parent) break;
    path.unshift(Array.prototype.indexOf.call(parent.children, cur));
    cur = parent;
  }
  return path;
}

function atPath(root: Element, path: number[]): Element | null {
  let cur: Element | null = root;
  for (const i of path) cur = cur?.children[i] ?? null;
  return cur;
}

function rectOf(el: Element): { top: number; bottom: number } {
  if (getComputedStyle(el).display === "contents") {
    const rs = [...el.children].map((c) => c.getBoundingClientRect());
    if (rs.length === 0) return { top: 0, bottom: 0 };
    return {
      top: Math.min(...rs.map((r) => r.top)),
      bottom: Math.max(...rs.map((r) => r.bottom)),
    };
  }
  const r = el.getBoundingClientRect();
  return { top: r.top, bottom: r.bottom };
}

/** 목록(ul/ol)은 항목(li)으로 펼치고, 버튼·떠 있는 요소는 뺀다. */
function flowChildren(el: Element): Element[] {
  return [...el.children]
    .filter((c) => !isSkipped(c))
    .flatMap((c) =>
      isList(c) ? [...c.children].filter((li) => !isSkipped(li)) : [c],
    );
}

/** 세로로 쌓이는(블록 흐름) 요소만 줄로 나눌 수 있다. flex·grid 줄(제목 | 기간)은 한 덩어리. */
function stacksVertically(el: Element) {
  const d = getComputedStyle(el).display;
  return d === "block" || d === "list-item" || d === "flow-root";
}

/** 복제한 본문에서 블록을 잰다(위치는 본문 위 기준 px). */
export function measureSheetBlocks(root: HTMLElement): SheetBlock[] {
  const top0 = root.getBoundingClientRect().top;
  const blocks: SheetBlock[] = [];
  let prevBottom = 0;
  const add = (
    el: Element,
    id: string,
    group: string,
    kind: Kind,
    span: { top: number; bottom: number },
    keepWithNext = false,
  ) => {
    const top = span.top - top0;
    const bottom = span.bottom - top0;
    const cs = getComputedStyle(el);
    blocks.push({
      atom: {
        id,
        group,
        keepWithNext,
        height: Math.max(0, bottom - top),
        gapBefore: Math.max(0, top - prevBottom),
      },
      path: pathOf(root, el),
      kind,
      base: parseFloat(kind === "margin" ? cs.marginTop : cs.paddingTop) || 0,
      top,
    });
    prevBottom = Math.max(prevBottom, bottom);
  };

  [...root.children].forEach((child, i) => {
    const content = child.classList.contains("pf-section")
      ? child.querySelector(":scope > .pf-section-content")
      : null;
    const rows = content ? flowChildren(content) : [];
    if (!content || rows.length === 0) {
      add(child, `b${i}`, `b${i}`, "margin", rectOf(child));
      return;
    }
    const sec = rectOf(child);
    const firstRow = rectOf(rows[0]!);
    add(
      child,
      `s${i}`,
      `s${i}`,
      "margin",
      { top: sec.top, bottom: firstRow.top },
      true,
    );
    rows.forEach((row, r) => {
      const group = `s${i}.r${r}`;
      const span = rectOf(row);
      const lines = stacksVertically(row) ? flowChildren(row) : [];
      if (lines.length <= 1) {
        add(row, group, group, "padding", span);
        return;
      }
      lines.forEach((line, l) => {
        const lr = rectOf(line);
        add(l === 0 ? row : line, `${group}.l${l}`, group, "padding", {
          top: l === 0 ? span.top : lr.top,
          bottom:
            l === lines.length - 1
              ? Math.max(span.bottom, lr.bottom)
              : lr.bottom,
        });
      });
    });
  });
  return blocks;
}

export interface SheetPush {
  path: number[];
  kind: Kind;
  /** 새 margin/padding-top(px). */
  value: number;
}

/** 쪽 나눔 결과로 각 쪽 첫 블록에 줄 여백을 계산한다(순수 계산). */
export function sheetPushes(
  blocks: SheetBlock[],
  pageHeight = SHEET_BODY_PX,
  pageStride = A4.heightPx + SHEET_PAGE_GAP,
): { pages: number; pushes: SheetPush[] } {
  const pages = paginate(
    blocks.map((b) => b.atom),
    { pageHeight },
  );
  const byId = new Map(blocks.map((b) => [b.atom.id, b]));
  const pushes: SheetPush[] = [];
  let shift = 0;
  pages.forEach((ids, p) => {
    if (p === 0 || ids.length === 0) return;
    const b = byId.get(ids[0]!)!;
    const push = Math.max(0, p * pageStride - (b.top + shift));
    shift += push;
    pushes.push({ path: b.path, kind: b.kind, value: b.base + push });
  });
  return { pages: pages.length, pushes };
}

function clearPushes(root: HTMLElement) {
  root.querySelectorAll<HTMLElement>(`[${PUSH_ATTR}]`).forEach((el) => {
    el.style.removeProperty(
      el.getAttribute(PUSH_ATTR) === "margin" ? "margin-top" : "padding-top",
    );
    el.removeAttribute(PUSH_ATTR);
  });
}

function applyPush(el: HTMLElement, kind: Kind, value: number) {
  // display: contents(직무 역량 한 줄)는 상자가 없으므로 안의 칸들에 준다.
  const targets =
    getComputedStyle(el).display === "contents"
      ? ([...el.children] as HTMLElement[])
      : [el];
  for (const t of targets) {
    t.style.setProperty(
      kind === "margin" ? "margin-top" : "padding-top",
      `${value}px`,
    );
    t.setAttribute(PUSH_ATTR, kind);
  }
}

/**
 * 시트 본문을 쪽으로 나누고 쪽 수를 돌려준다(모바일 배치·서버 렌더에서는 1).
 * 처음 그릴 때 바로 재고, 그 뒤로는 `version`(문서 내용)이 바뀌거나 본문 크기가 바뀌면(입력·글꼴 로드·창 크기)
 * 120ms 모았다가 다시 잰다 — 글자를 칠 때마다 본문 전체를 복제해 재지 않게. 그동안은 쪽 위치가 잠깐 어긋나 보일 수 있다.
 */
export function useSheetPages(
  bodyRef: RefObject<HTMLElement | null>,
  version: unknown,
): number {
  const [pages, setPages] = useState(1);
  const [tick, setTick] = useState(0);
  const scheduleRef = useRef<() => void>(() => {});

  useEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      clearTimeout(timer);
      timer = setTimeout(() => setTick((t) => t + 1), 120);
    };
    scheduleRef.current = schedule;
    const ro = new ResizeObserver(schedule);
    ro.observe(body);
    const mq = window.matchMedia(MOBILE_QUERY);
    mq.addEventListener("change", schedule);
    document.fonts?.addEventListener("loadingdone", schedule);
    document.fonts?.ready.then(schedule).catch(() => {});
    return () => {
      clearTimeout(timer);
      ro.disconnect();
      mq.removeEventListener("change", schedule);
      document.fonts?.removeEventListener("loadingdone", schedule);
      scheduleRef.current = () => {};
    };
  }, [bodyRef]);

  // 문서가 바뀌면 바로 재지 않고 모았다가 잰다(첫 값은 아래 첫 측정이 맡는다).
  const firstVersion = useRef(true);
  useEffect(() => {
    if (firstVersion.current) {
      firstVersion.current = false;
      return;
    }
    scheduleRef.current();
  }, [version]);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    const next = layoutSheet(body);
    setPages(next);
  }, [bodyRef, tick]);

  return pages;
}

/** 본문을 재고 쪽 여백을 넣은 뒤 쪽 수를 돌려준다. */
function layoutSheet(body: HTMLElement): number {
  if (window.matchMedia(MOBILE_QUERY).matches) {
    clearPushes(body);
    return 1;
  }
  // 숨은 복제본(같은 시트 안, 같은 폭)에서 여백을 뺀 원래 배치를 잰다. 같은 작업 안에서 넣고 빼므로 화면에 그려지지 않는다.
  const clone = body.cloneNode(true) as HTMLElement;
  clearPushes(clone);
  clone.setAttribute("aria-hidden", "true");
  clone.setAttribute("inert", "");
  clone.querySelectorAll("[id]").forEach((el) => el.removeAttribute("id"));
  Object.assign(clone.style, {
    position: "absolute",
    visibility: "hidden",
    pointerEvents: "none",
    left: `${body.offsetLeft}px`,
    top: "0px",
    width: `${body.clientWidth}px`,
  });
  body.parentElement!.appendChild(clone);
  let result: ReturnType<typeof sheetPushes>;
  try {
    result = sheetPushes(measureSheetBlocks(clone));
  } finally {
    clone.remove();
  }
  // 같은 값을 다시 써도 크기가 그대로라 ResizeObserver가 다시 부르지 않는다. React가 바꿔 끼운 요소도 놓치지 않게 매번 새로 쓴다.
  clearPushes(body);
  for (const p of result.pushes) {
    const el = atPath(body, p.path);
    if (el instanceof HTMLElement) applyPush(el, p.kind, p.value);
  }
  return result.pages;
}
