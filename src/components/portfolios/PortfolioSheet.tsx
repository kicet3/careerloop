"use client";
/**
 * 포트폴리오 본문(Markdown)의 A4 쪽 미리보기 + 인쇄(브라우저 인쇄 → PDF로 저장).
 *
 * 1. 본문을 블록(제목·문단·목록·인용·구분선)으로 나누고(MiniMarkdown의 parseMarkdownBlocks), A4 본문 폭의 숨은 칸에 모두 그려 높이를 잰다.
 * 2. 이력서와 같은 쪽 나눔 규칙(src/lib/resumes/pagination.ts paginate)으로 쪽을 나눈다 — 제목은 다음 블록과 함께 넘어가고(keepWithNext),
 *    블록은 쪼개지 않는다. 한 쪽보다 큰 블록이 있으면 그 쪽 카드를 늘린다(pageOverflow).
 * 3. 쪽마다 A4 카드에 다시 그린다. 인쇄할 때는 카드 사이 간격·그림자를 없애고 카드마다 쪽을 넘긴다(@page A4, 여백 0 — 카드 안 여백이 쪽 여백).
 * HTML을 주입하지 않고 React 요소로만 그린다(링크는 http/https만).
 */
import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { parseMarkdownBlocks, renderInline } from "@/components/report/MiniMarkdown";
import { A4, mmToPx, pageOverflow, paginate, type PageAtom } from "@/lib/resumes/pagination";
import "./portfolio-sheet.css";

type Block = ReturnType<typeof parseMarkdownBlocks>[number];

/** 쪽 여백(mm). portfolio-sheet.css의 --ps-margin과 같다. */
export const SHEET_MARGIN_MM = 16;
const BODY_HEIGHT_PX = A4.heightPx - mmToPx(SHEET_MARGIN_MM * 2);

function BlockView({ block, k }: { block: Block; k: string }): ReactNode {
  switch (block.kind) {
    case "heading": {
      const content = renderInline(block.text, k);
      if (block.level === 1) return <h1 className="ps-h1">{content}</h1>;
      if (block.level === 2) return <h2 className="ps-h2">{content}</h2>;
      return <h3 className="ps-h3">{content}</h3>;
    }
    case "list": {
      const items = block.items.map((it, j) => (
        <li key={j} style={it.depth ? { marginLeft: `${it.depth * 1.1}em` } : undefined}>
          {renderInline(it.text, `${k}-${j}`)}
        </li>
      ));
      return block.ordered ? <ol className="ps-list ps-ol">{items}</ol> : <ul className="ps-list">{items}</ul>;
    }
    case "quote":
      return (
        <blockquote className="ps-quote">
          {block.lines.map((ln, j) => (
            <p key={j}>{renderInline(ln, `${k}-${j}`)}</p>
          ))}
        </blockquote>
      );
    case "hr":
      return <hr className="ps-hr" />;
    case "para":
      return (
        <p className="ps-p">
          {block.lines.map((ln, j) => (
            <span key={j}>
              {j > 0 && <br />}
              {renderInline(ln, `${k}-${j}`)}
            </span>
          ))}
        </p>
      );
  }
}

/** 쪽 나눔 블록: 제목(h2·h3)과 구분선은 다음 블록과 함께 움직인다. */
export function sheetAtoms(blocks: readonly Block[], heights: readonly { height: number; gapBefore: number }[]): PageAtom[] {
  return blocks.map((b, i) => ({
    id: String(i),
    group: `b${i}`,
    height: heights[i]?.height ?? 0,
    gapBefore: heights[i]?.gapBefore ?? 0,
    keepWithNext: (b.kind === "heading" && b.level > 1) || b.kind === "hr",
  }));
}

export function PortfolioSheet({ source }: { source: string }) {
  const blocks = useMemo(() => parseMarkdownBlocks(source), [source]);
  const measureRef = useRef<HTMLDivElement>(null);
  const [layout, setLayout] = useState<{ pages: number[][]; overflow: number[] } | null>(null);

  useLayoutEffect(() => {
    const root = measureRef.current;
    if (!root) return;
    let cancelled = false;
    const measure = () => {
      if (cancelled) return;
      const top0 = root.getBoundingClientRect().top;
      let prevBottom = 0;
      const heights = [...root.children].map((el) => {
        const r = el.getBoundingClientRect();
        const top = r.top - top0;
        const bottom = r.bottom - top0;
        const out = { height: Math.max(0, bottom - top), gapBefore: Math.max(0, top - prevBottom) };
        prevBottom = Math.max(prevBottom, bottom);
        return out;
      });
      const atoms = sheetAtoms(blocks, heights);
      const opts = { pageHeight: BODY_HEIGHT_PX };
      const pages = paginate(atoms, opts);
      setLayout({ pages: pages.map((ids) => ids.map(Number)), overflow: pageOverflow(atoms, pages, opts) });
    };
    measure();
    // 웹 글꼴이 늦게 오면 높이가 바뀐다 — 다 받은 뒤 한 번 더 잰다.
    void document.fonts?.ready.then(measure);
    return () => {
      cancelled = true;
    };
  }, [blocks]);

  const pages = layout?.pages ?? [blocks.map((_, i) => i)];
  return (
    <div className="ps-root">
      <div ref={measureRef} className="ps-measure ps-content" aria-hidden>
        {blocks.map((b, i) => (
          <div key={i} className="ps-block">
            <BlockView block={b} k={`m${i}`} />
          </div>
        ))}
      </div>
      <div className="ps-pages">
        {pages.map((ids, p) => (
          <section
            key={p}
            className="ps-page"
            aria-label={`${p + 1}쪽`}
            style={layout?.overflow[p] ? { minHeight: `calc(297mm + ${Math.ceil(layout.overflow[p])}px)` } : undefined}
          >
            <div className="ps-content">
              {ids.map((i, j) => (
                <div key={i} className={j === 0 ? "ps-block ps-first" : "ps-block"}>
                  <BlockView block={blocks[i]!} k={`p${i}`} />
                </div>
              ))}
            </div>
            <span className="ps-page-no" aria-hidden>
              {p + 1} / {pages.length}
            </span>
          </section>
        ))}
      </div>
    </div>
  );
}
