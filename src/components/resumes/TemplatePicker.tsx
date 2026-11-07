"use client";

import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { RESUME_TEMPLATE_IDS, RESUME_TEMPLATES, type ResumeSectionKey, type ResumeTemplate, type ResumeTemplateId } from "@/lib/domain/resumes";

/**
 * 방향키로 옮겨 갈 양식(라디오 그룹 규칙: 끝에서 처음으로 돈다). 해당 없는 키면 null.
 * 순수 함수라 테스트에서 직접 부른다.
 */
export function templateForKey(
  key: string,
  current: ResumeTemplateId,
  ids: readonly ResumeTemplateId[] = RESUME_TEMPLATE_IDS,
): ResumeTemplateId | null {
  if (ids.length === 0) return null;
  const i = Math.max(0, ids.indexOf(current));
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return ids[(i + 1) % ids.length]!;
    case "ArrowLeft":
    case "ArrowUp":
      return ids[(i - 1 + ids.length) % ids.length]!;
    case "Home":
      return ids[0]!;
    case "End":
      return ids[ids.length - 1]!;
    default:
      return null;
  }
}

/** 카드를 스크롤 영역 가운데로 옮길 scrollLeft(양 끝에서는 범위 안으로 자른다). */
export function centeredScrollLeft(cardLeft: number, cardWidth: number, viewWidth: number, scrollWidth: number): number {
  const max = Math.max(0, scrollWidth - viewWidth);
  return Math.min(max, Math.max(0, Math.round(cardLeft - (viewWidth - cardWidth) / 2)));
}

// ---------------------------------------------------------------------------
// 축소 미리보기: 양식의 배치(단일·사이드바·제목 열)·제목 모양·밀도·강조색을 본뜬 작은 그림
// ---------------------------------------------------------------------------

const Line = ({ w, className, color }: { w: string; className?: string; color?: string }) => (
  <span className={cn("block h-[3px] rounded-full bg-slate-200", className)} style={{ width: w, backgroundColor: color }} />
);

function MiniHeading({ t }: { t: ResumeTemplate }) {
  const { accent, headingStyle } = t.style;
  if (headingStyle === "bar") {
    return (
      <span className="flex items-center gap-[3px]">
        <span className="block h-[5px] w-[2px] rounded-full" style={{ backgroundColor: accent }} />
        <Line w="34%" className="h-[4px] bg-slate-500" />
      </span>
    );
  }
  if (headingStyle === "underline") {
    return (
      <span className="block pb-[2px]" style={{ borderBottom: `1px solid ${accent}` }}>
        <Line w="34%" className="h-[4px] bg-slate-500" />
      </span>
    );
  }
  return <Line w="34%" className="h-[4px]" color={accent} />;
}

function MiniBody({ t, k }: { t: ResumeTemplate; k: ResumeSectionKey }) {
  if (k === "skills" && t.style.skillChips) {
    return (
      <span className="flex flex-wrap gap-[2px]">
        {["w-3", "w-4", "w-2.5", "w-3.5"].map((w, i) => (
          <span key={i} className={cn("block h-[4px] rounded-full", w)} style={{ backgroundColor: `${t.style.accent}55` }} />
        ))}
      </span>
    );
  }
  return (
    <>
      <Line w="92%" />
      <Line w="78%" />
    </>
  );
}

function MiniSection({ t, k }: { t: ResumeTemplate; k: ResumeSectionKey }) {
  const compact = t.style.density === "compact";
  return (
    <span className={cn("flex flex-col", compact ? "gap-[2px]" : "gap-[3px]")}>
      <MiniHeading t={t} />
      <MiniBody t={t} k={k} />
    </span>
  );
}

/** 카드 윗부분에 보이는 A4 축소 그림(장식용, 스크린리더에는 숨긴다). 양식별로 고정이라 memo한다. */
export const TemplateThumbnail = memo(function TemplateThumbnail({ templateId }: { templateId: ResumeTemplateId }) {
  const t = RESUME_TEMPLATES[templateId];
  const { accent, layout, density } = t.style;
  const compact = density === "compact";
  const sections = t.sectionOrder.filter((k) => k !== "extras" && k !== "certifications" && k !== "motivation");
  const gap = compact ? "gap-[5px]" : "gap-[7px]";

  const header = (
    <span
      className="flex flex-col gap-[3px] pb-[4px]"
      style={{ borderBottom: t.style.headingStyle === "plain" ? "1px solid #e2e8f0" : `1.5px solid ${accent}` }}
    >
      <Line w="46%" className="h-[6px] bg-slate-700" />
      <Line w="62%" className="h-[3px]" color={accent} />
      <Line w="70%" className="h-[2px]" />
    </span>
  );

  let body: React.ReactNode;
  if (layout === "sidebar") {
    const side: ResumeSectionKey[] = ["skills", "education"];
    body = (
      <span className="flex min-h-0 flex-1 gap-[5px]">
        <span className={cn("flex w-[34%] shrink-0 flex-col rounded-[2px] bg-slate-100 p-[3px]", gap)}>
          {side.map((k) => (
            <MiniSection key={k} t={t} k={k} />
          ))}
        </span>
        <span className={cn("flex min-w-0 flex-1 flex-col", gap)}>
          {sections
            .filter((k) => !side.includes(k))
            .slice(0, 4)
            .map((k) => (
              <MiniSection key={k} t={t} k={k} />
            ))}
        </span>
      </span>
    );
  } else if (layout === "labeled") {
    // 성과 중심: 왼쪽 좁은 열에 섹션 제목, 오른쪽에 내용.
    body = (
      <span className={cn("flex flex-col", gap)}>
        {sections.slice(1, 6).map((k) => (
          <span key={k} className="flex gap-[5px] border-t border-slate-200 pt-[3px]">
            <Line w="22%" className="h-[4px] shrink-0" color={accent} />
            <span className="flex min-w-0 flex-1 flex-col gap-[3px]">
              <Line w="88%" className="bg-slate-300" />
              <Line w="70%" />
            </span>
          </span>
        ))}
      </span>
    );
  } else {
    body = (
      <span className={cn("flex flex-col", gap)}>
        {sections.slice(0, compact ? 6 : 5).map((k) => (
          <MiniSection key={k} t={t} k={k} />
        ))}
      </span>
    );
  }

  return (
    <span
      aria-hidden
      data-thumbnail={templateId}
      className={cn("flex h-full flex-col overflow-hidden bg-white shadow-sm ring-1 ring-slate-200", compact ? "gap-[5px] p-[7px]" : "gap-[7px] p-[9px]")}
    >
      {header}
      {body}
    </span>
  );
});

// ---------------------------------------------------------------------------
// 가로 스크롤 양식 고르기
// ---------------------------------------------------------------------------

/**
 * 편집 화면 상단의 양식 고르기: 가로로 스크롤되는 카드(축소 그림 + 이름 + 한 줄 설명).
 * 라디오 그룹 규칙(방향키·Home·End로 이동하며 고른다, 선택된 카드만 탭으로 들어온다).
 * 페이지는 넘치지 않고 카드 줄만 스크롤된다(모바일은 밀어서, 넓은 화면은 좌우 버튼도).
 * memo: 편집 화면에서 글자를 칠 때마다 다시 그리지 않는다(onChange는 안정된 참조로 넘긴다).
 */
export const TemplatePicker = memo(function TemplatePicker({
  value,
  onChange,
  disabled = false,
  className,
}: {
  value: ResumeTemplateId;
  onChange: (id: ResumeTemplateId) => void;
  disabled?: boolean;
  className?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const cards = useRef(new Map<ResumeTemplateId, HTMLButtonElement>());
  const [edges, setEdges] = useState({ left: false, right: false });
  const firstScroll = useRef(true);

  const updateEdges = useCallback(() => {
    const el = scroller.current;
    if (!el) return;
    const left = el.scrollLeft > 2;
    const right = el.scrollLeft + el.clientWidth < el.scrollWidth - 2;
    setEdges((e) => (e.left === left && e.right === right ? e : { left, right }));
  }, []);

  // 고른 카드를 보이게 한다: 처음에는 바로, 그 뒤(키보드로 옮길 때 등)에는 부드럽게. 페이지 세로 스크롤은 건드리지 않는다.
  useLayoutEffect(() => {
    const el = scroller.current;
    const card = cards.current.get(value);
    if (!el || !card) return;
    const viewLeft = el.scrollLeft;
    const cardLeft = card.offsetLeft - el.offsetLeft;
    const visible = cardLeft >= viewLeft && cardLeft + card.offsetWidth <= viewLeft + el.clientWidth;
    if (firstScroll.current || !visible) {
      const left = centeredScrollLeft(cardLeft, card.offsetWidth, el.clientWidth, el.scrollWidth);
      el.scrollTo({ left, behavior: firstScroll.current ? "instant" : "smooth" });
    }
    firstScroll.current = false;
    updateEdges();
  }, [value, updateEdges]);

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    el.addEventListener("scroll", updateEdges, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateEdges);
    ro?.observe(el);
    return () => {
      el.removeEventListener("scroll", updateEdges);
      ro?.disconnect();
    };
  }, [updateEdges]);

  function scrollByPage(dir: -1 | 1) {
    const el = scroller.current;
    if (!el) return;
    el.scrollBy({ left: dir * Math.max(160, el.clientWidth * 0.8), behavior: "smooth" });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) return;
    const next = templateForKey(e.key, value);
    if (!next) return;
    e.preventDefault();
    cards.current.get(next)?.focus({ preventScroll: true });
    if (next !== value) onChange(next);
  }

  const arrow = (dir: -1 | 1, show: boolean) => (
    <button
      type="button"
      tabIndex={-1}
      aria-label={dir < 0 ? "이전 양식 보기" : "다음 양식 보기"}
      onClick={() => scrollByPage(dir)}
      className={cn(
        "absolute top-1/2 z-10 hidden size-8 -translate-y-1/2 items-center justify-center rounded-full border border-slate-200 bg-white/95 text-slate-700 shadow-md hover:bg-slate-50",
        dir < 0 ? "left-0" : "right-0",
        show && "sm:flex",
      )}
    >
      <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="size-4">
        {dir < 0 ? (
          <path fillRule="evenodd" d="M12.79 5.23a.75.75 0 0 1-.02 1.06L8.832 10l3.938 3.71a.75.75 0 1 1-1.04 1.08l-4.5-4.25a.75.75 0 0 1 0-1.08l4.5-4.25a.75.75 0 0 1 1.06.02Z" clipRule="evenodd" />
        ) : (
          <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.168 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
        )}
      </svg>
    </button>
  );

  return (
    <div className={cn("relative max-w-full min-w-0", className)} data-template-picker>
      {arrow(-1, edges.left)}
      <div
        ref={scroller}
        role="radiogroup"
        aria-label="이력서 양식"
        aria-disabled={disabled || undefined}
        onKeyDown={onKeyDown}
        className="flex snap-x snap-mandatory gap-3 overflow-x-auto overscroll-x-contain px-1 pt-1 pb-3 [scrollbar-width:thin]"
      >
        {RESUME_TEMPLATE_IDS.map((id) => {
          const t = RESUME_TEMPLATES[id];
          const active = id === value;
          return (
            <button
              key={id}
              ref={(node) => {
                if (node) cards.current.set(id, node);
                else cards.current.delete(id);
              }}
              type="button"
              role="radio"
              aria-checked={active}
              tabIndex={active ? 0 : -1}
              disabled={disabled}
              data-template-option={id}
              onClick={() => {
                if (!active) onChange(id);
              }}
              className={cn(
                "group flex w-40 shrink-0 snap-center flex-col overflow-hidden rounded-lg border bg-white text-left transition focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-60 sm:w-44",
                active ? "border-indigo-600 ring-2 ring-indigo-600" : "border-slate-200 hover:border-slate-300 hover:shadow-sm",
              )}
            >
              <span className={cn("block h-24 px-4 pt-3", active ? "bg-indigo-50" : "bg-slate-50 group-hover:bg-slate-100")}>
                <TemplateThumbnail templateId={id} />
              </span>
              <span className="block border-t border-slate-100 px-3 py-2">
                <span className="flex items-center gap-1.5 text-sm font-medium text-slate-900">
                  <span aria-hidden className="inline-block size-2 shrink-0 rounded-full" style={{ backgroundColor: t.style.accent }} />
                  <span className="truncate">{t.name}</span>
                  {active && (
                    <svg aria-hidden viewBox="0 0 20 20" fill="currentColor" className="ml-auto size-4 shrink-0 text-indigo-600">
                      <path fillRule="evenodd" d="M16.704 4.153a.75.75 0 0 1 .143 1.052l-8 10.5a.75.75 0 0 1-1.127.075l-4.5-4.5a.75.75 0 0 1 1.06-1.06l3.894 3.893 7.48-9.817a.75.75 0 0 1 1.05-.143Z" clipRule="evenodd" />
                    </svg>
                  )}
                </span>
                <span className="mt-0.5 line-clamp-2 block text-xs leading-snug text-slate-500" title={t.description}>
                  {t.description}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      {arrow(1, edges.right)}
    </div>
  );
});
