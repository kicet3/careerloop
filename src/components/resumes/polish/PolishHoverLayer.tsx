"use client";

import { type ReactNode, useRef, useState } from "react";
import { polishPathFromField } from "@/lib/domain/resume-polish";

/**
 * 편집 칸 위의 'AI로 다듬기' 버튼. 감싼 영역에서 data-field가 다듬을 수 있는 칸(polishPathFromField)이면 마우스를 올리거나
 * 포커스할 때 그 칸 오른쪽 위에 버튼을 띄운다. 편집기 본문(PerformanceSheet)은 고치지 않는다 — 칸의 data-field만 읽는다.
 */
export function PolishHoverLayer({ children, onPolish, disabled = false }: { children: ReactNode; onPolish: (path: string) => void; disabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState<{ path: string; top: number; right: number } | null>(null);

  const track = (target: EventTarget | null) => {
    if (disabled) return;
    const el = (target as Element | null)?.closest?.("[data-field]");
    const root = ref.current;
    if (!(el instanceof HTMLElement) || !root || !root.contains(el)) return;
    const path = polishPathFromField(el.dataset.field ?? "");
    if (!path) return;
    const box = el.getBoundingClientRect();
    const base = root.getBoundingClientRect();
    setActive({ path, top: box.top - base.top, right: base.right - box.right });
  };

  return (
    <div
      ref={ref}
      className="relative"
      onMouseOver={(e) => track(e.target)}
      onFocus={(e) => track(e.target)}
      onMouseLeave={() => {
        if (!ref.current?.contains(document.activeElement)) setActive(null);
      }}
    >
      {children}
      {active && !disabled && (
        <button
          type="button"
          className="absolute z-20 -translate-y-full rounded-full border border-indigo-200 bg-white px-2 py-0.5 text-[11px] font-medium text-indigo-700 shadow-sm hover:bg-indigo-50 print:hidden"
          style={{ top: Math.max(0, active.top), right: active.right }}
          // 칸의 포커스를 빼앗지 않는다(누르는 순간 칸이 blur되며 버튼이 사라지지 않게).
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => onPolish(active.path)}
          data-polish-button
        >
          AI로 다듬기
        </button>
      )}
    </div>
  );
}
