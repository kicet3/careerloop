"use client";
/**
 * 그래프에 묻기 답변의 출처 표시: 본문의 [n]을 위첨자 버튼으로, 출처 칩(라벨·이름 — 누르면 바로 그래프에서 보기, 경로는 옆 토글로 펼쳐 보기).
 * 누르면 같은 화면의 그래프 보기가
 * 그 노드를 고르고 본인에서의 경로를 강조한다(focusGraphNode). 삭제된 노드(exists=false)는 흐리게 하고 누를 수 없다.
 */
import { Fragment, useId, useState } from "react";
import { cn } from "@/components/ui/cn";
import type { GraphSource } from "@/lib/domain/chat";
import { NODE_LABEL_META } from "@/lib/domain/graph";
import { focusGraphNode } from "./api";
import { LABEL_STYLE } from "./styles";

const MARKER_RE = /\[(\d{1,2}(?:\s*,\s*\d{1,2})*)\]/g;

function focus(s: GraphSource) {
  if (s.exists === false) return;
  focusGraphNode(s.nodeId, s.path.map((p) => p.id));
}

/** 답 본문: [n] → 위첨자 버튼(출처 표에 있는 번호만). */
export function AnswerText({ text, sources }: { text: string; sources: readonly GraphSource[] }) {
  const byN = new Map(sources.map((s) => [s.n, s]));
  const parts: React.ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(MARKER_RE)) {
    parts.push(text.slice(last, m.index));
    const nums = m[1]!.split(",").map((x) => Number(x.trim()));
    parts.push(
      <sup key={`${m.index}`} className="ml-0.5 whitespace-nowrap">
        {nums.map((n, i) => {
          const s = byN.get(n);
          return (
            <Fragment key={n}>
              {i > 0 && <span className="px-0.5 text-slate-400">,</span>}
              {s ? (
                <button
                  type="button"
                  onClick={() => focus(s)}
                  disabled={s.exists === false}
                  title={`${NODE_LABEL_META[s.label].name} · ${s.name}\n${s.pathText}`}
                  className={cn(
                    // 글자 크기는 그대로 두고 누르는 영역만 넓힌다(투명 ::before, 최소 24px — 휴대폰에서 한 번에 누른다).
                    "relative rounded px-0.5 text-[0.7rem] font-semibold text-indigo-700 hover:bg-indigo-100",
                    "before:absolute before:top-1/2 before:left-1/2 before:size-6 before:-translate-x-1/2 before:-translate-y-1/2 before:content-['']",
                    s.exists === false && "text-slate-400 line-through",
                  )}
                  aria-label={`출처 ${n}: ${s.name} 그래프에서 보기`}
                >
                  [{n}]
                </button>
              ) : (
                <span className="text-[0.7rem] text-slate-400">[{n}]</span>
              )}
            </Fragment>
          );
        })}
      </sup>,
    );
    last = m.index + m[0].length;
  }
  parts.push(text.slice(last));
  return <p className="text-sm whitespace-pre-wrap break-words text-slate-800">{parts}</p>;
}

/** 출처 칩 목록. 칩(라벨·이름)을 누르면 바로 그래프에서 보고, 옆의 토글을 누르면 본인에서의 경로가 보인다. */
export function SourceChips({ sources }: { sources: readonly GraphSource[] }) {
  if (sources.length === 0) return null;
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-slate-500">출처(경험 그래프)</p>
      <ul className="space-y-1">
        {sources.map((s) => (
          <SourceChip key={s.n} source={s} />
        ))}
      </ul>
    </div>
  );
}

function SourceChip({ source: s }: { source: GraphSource }) {
  const [open, setOpen] = useState(false);
  const pathId = useId();
  const gone = s.exists === false;
  return (
    <li className={cn("rounded-lg border border-slate-200 bg-white text-xs", gone && "opacity-60")}>
      <div className="flex items-stretch">
        <button
          type="button"
          onClick={() => focus(s)}
          disabled={gone}
          title={gone ? "삭제된 항목" : "그래프에서 보기"}
          aria-label={`출처 ${s.n}: ${NODE_LABEL_META[s.label].name} ${s.name}${gone ? " (삭제된 항목)" : " 그래프에서 보기"}`}
          className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-l-lg px-2 py-1 text-left hover:bg-indigo-50 disabled:cursor-not-allowed disabled:hover:bg-transparent"
        >
          <span className="font-semibold text-slate-500">[{s.n}]</span>
          <span className={cn("size-2 shrink-0 rounded-full", LABEL_STYLE[s.label].dot)} aria-hidden />
          <span className="text-slate-500">{NODE_LABEL_META[s.label].name}</span>
          <span className={cn("min-w-0 truncate font-medium text-slate-800", gone && "line-through")}>{s.name}</span>
          {gone && <span className="text-slate-500">(삭제된 항목)</span>}
        </button>
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          aria-controls={pathId}
          aria-label={`출처 ${s.n} 경로 ${open ? "접기" : "펼치기"}`}
          className="flex min-h-8 min-w-8 items-center justify-center rounded-r-lg border-l border-slate-100 text-slate-400 hover:bg-slate-50 hover:text-slate-700"
        >
          <span className={cn("transition-transform", open && "rotate-90")} aria-hidden>
            ›
          </span>
        </button>
      </div>
      <div id={pathId} hidden={!open} className="space-y-1 border-t border-slate-100 px-2 py-1.5 text-slate-600">
        <p className="break-words">{s.pathText}</p>
        {s.snippet && <p className="break-words text-slate-500">{s.snippet}</p>}
      </div>
    </li>
  );
}
