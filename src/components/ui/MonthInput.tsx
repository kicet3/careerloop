"use client";

/**
 * 월 입력 칸: 글로 바로 쓰고("2024-02"·"2024.02"·"2024년 2월"·"현재") 달력 버튼으로 고를 수도 있다.
 * - 달력: <input type="month">를 지원하는 브라우저는 그 기본 선택기(showPicker)를, 아니면(데스크톱 Safari·Firefox 등) 작은 팝오버
 *   (연도 넘기기 + 12달 격자)를 연다. 팝오버는 Esc로 닫고 방향키로 달을 옮긴다.
 * - 칸을 떠나면(blur) 알아본 값을 format에 맞춘다(dash = YYYY-MM, dot = YYYY.MM). 알아볼 수 없는 글은 그대로 두고 예시를 보인다.
 * - 종료일은 '현재' 체크를 둘 수 있다. onCurrentChange가 있으면 진행 중을 따로 된 값(그래프 current)으로, 없으면 값 "현재"로 쓴다.
 * 해석 규칙은 src/lib/dates/month-input.ts.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  CURRENT_TEXT,
  formatMonth,
  fromPickerValue,
  MONTH_HINT,
  type MonthFormat,
  moveMonth,
  normalizeMonthInput,
  parseMonthInput,
  pickerValue,
  toPickerMonth,
} from "@/lib/dates/month-input";
import { cn } from "./cn";

/** <input type="month">와 showPicker를 둘 다 지원하는가(클라이언트에서 처음 열 때만 잰다). */
let nativeMonthSupport: boolean | null = null;
function supportsNativeMonth(): boolean {
  if (nativeMonthSupport !== null) return nativeMonthSupport;
  if (typeof document === "undefined") return false;
  const probe = document.createElement("input");
  probe.setAttribute("type", "month");
  // 지원하지 않는 브라우저는 type을 text로 되돌리고, 값 검사도 하지 않는다.
  probe.value = "x";
  nativeMonthSupport = probe.type === "month" && probe.value === "" && typeof probe.showPicker === "function";
  return nativeMonthSupport;
}

/** 브라우저 지원은 바뀌지 않는다(서버 렌더는 false, 하이드레이션 뒤 실제 값). */
const noSubscribe = () => () => {};

const CalendarIcon = () => (
  <svg aria-hidden viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.6" className="size-4">
    <rect x="3" y="4.5" width="14" height="12" rx="2" />
    <path d="M3 8.5h14M7 2.5v4M13 2.5v4" strokeLinecap="round" />
  </svg>
);

export interface MonthPickerButtonProps {
  /** 지금 칸의 글(달력의 처음 위치를 고른다). */
  value: string;
  format: MonthFormat;
  /** 고른 달(format에 맞춘 값). */
  onPick: (value: string) => void;
  /** 있으면 팝오버에 '현재' 단추를 둔다. */
  onPickCurrent?: () => void;
  disabled?: boolean;
  /** 버튼 이름(기본 "달력에서 고르기"). 칸 이름이 따로 없는 곳(시트)에서는 "경력 시작 달력에서 고르기"처럼 붙인다. */
  label?: string;
  className?: string;
  /** 버튼과 숨은 기본 선택기를 감싼 상자(자리 잡기용). */
  wrapperClassName?: string;
  /** 기본 아이콘 대신. */
  children?: ReactNode;
}

/**
 * 달력 버튼 + 선택기(기본 선택기 또는 팝오버). MonthInput과 성과 시트(contenteditable 칸 옆)가 같이 쓴다.
 * 팝오버는 body로 띄운다(fixed) — 시트처럼 overflow가 있는 상자 안에서도 잘리지 않는다.
 */
export function MonthPickerButton({
  value,
  format,
  onPick,
  onPickCurrent,
  disabled,
  label = "달력에서 고르기",
  className,
  wrapperClassName,
  children,
}: MonthPickerButtonProps) {
  const popId = useId();
  const btnRef = useRef<HTMLButtonElement>(null);
  const nativeRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(false);
  // 터치 기기(iOS·Android)는 showPicker가 막히거나 아무것도 안 할 수 있어, 기본 선택기를 지원하면 숨은 칸이 탭을 직접 받게 한다.
  const nativeOk = useSyncExternalStore(noSubscribe, supportsNativeMonth, () => false);
  const picked = toPickerMonth(value);
  const pickedValue = picked ? pickerValue(picked.year, picked.month) : "";

  // 기본 선택기가 지금 칸 값에서 열리게 맞춰 둔다(버튼을 거치지 않는 터치 탭 포함).
  useEffect(() => {
    if (nativeRef.current) nativeRef.current.value = pickedValue;
  }, [pickedValue]);

  function openPicker() {
    if (open) return setOpen(false);
    const native = nativeRef.current;
    if (native && supportsNativeMonth()) {
      native.value = pickedValue;
      try {
        native.showPicker();
        return;
      } catch {
        // 교차 출처 iframe 등에서 막히면 팝오버로.
      }
    }
    setOpen(true);
  }

  function close(refocus: boolean) {
    setOpen(false);
    if (refocus) btnRef.current?.focus();
  }

  return (
    <span className={cn("relative inline-flex", wrapperClassName)}>
      <button
        ref={btnRef}
        type="button"
        aria-label={label}
        title={label}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-controls={open ? popId : undefined}
        disabled={disabled}
        onClick={openPicker}
        className={cn(
          "inline-flex items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-indigo-700 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 disabled:pointer-events-none disabled:opacity-40",
          className,
        )}
      >
        {children ?? <CalendarIcon />}
      </button>
      {/* 기본 선택기의 기준 칸: 보이지 않게 버튼 자리에 겹쳐 둔다(display:none이면 showPicker가 위치를 못 잡는다). */}
      <input
        ref={nativeRef}
        type="month"
        tabIndex={-1}
        aria-hidden
        defaultValue=""
        disabled={disabled}
        // text-base: iOS가 16px보다 작은 칸에 포커스하면 화면을 확대한다.
        className={cn(
          "pointer-events-none absolute inset-0 size-full text-base opacity-0",
          nativeOk && !disabled && "pointer-coarse:pointer-events-auto",
        )}
        onChange={(e) => {
          const v = fromPickerValue(e.target.value, format);
          if (v) onPick(v);
        }}
      />
      {open && (
        <MonthPickerPopover
          id={popId}
          anchor={btnRef}
          initial={picked}
          onPick={(y, m) => {
            onPick(formatMonth(y, m, format));
            close(true);
          }}
          onPickCurrent={
            onPickCurrent
              ? () => {
                  onPickCurrent();
                  close(true);
                }
              : undefined
          }
          onClose={close}
        />
      )}
    </span>
  );
}

const MONTH_NAMES = Array.from({ length: 12 }, (_, i) => `${i + 1}월`);

/** 기본 선택기가 없을 때의 팝오버: 연도 넘기기 + 12달 격자(3열). */
export function MonthPickerPopover({
  id,
  anchor,
  initial,
  onPick,
  onPickCurrent,
  onClose,
  today = new Date(),
}: {
  id: string;
  anchor: React.RefObject<HTMLElement | null>;
  initial: { year: number; month: number } | null;
  onPick: (year: number, month: number) => void;
  onPickCurrent?: () => void;
  /** refocus: 버튼으로 포커스를 돌려놓을지(Esc·고르기는 예, 바깥 클릭은 아니오). */
  onClose: (refocus: boolean) => void;
  today?: Date;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [year, setYear] = useState(initial?.year ?? today.getFullYear());
  const [focusMonth, setFocusMonth] = useState(initial?.month ?? today.getMonth() + 1);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const titleId = `${id}-title`;
  // 열 때·방향키로 옮길 때만 달 단추로 포커스를 옮긴다(연도 단추를 누를 때는 그 자리에 둔다).
  const wantFocus = useRef(true);

  // 버튼 아래(넘치면 위)에 띄운다. 스크롤·크기 변경에도 따라간다.
  useLayoutEffect(() => {
    const place = () => {
      const a = anchor.current?.getBoundingClientRect();
      const box = ref.current?.getBoundingClientRect();
      if (!a) return;
      const w = box?.width ?? 240;
      const h = box?.height ?? 260;
      const left = Math.max(8, Math.min(a.right - w, window.innerWidth - w - 8));
      const below = a.bottom + 4;
      const top = below + h > window.innerHeight - 8 && a.top - h - 4 > 8 ? a.top - h - 4 : below;
      setPos({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [anchor]);

  // 바깥을 누르면 닫는다.
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      const t = e.target as Node;
      if (ref.current?.contains(t) || anchor.current?.contains(t)) return;
      onClose(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [anchor, onClose]);

  // 열리면, 그리고 방향키로 옮기면 그 달 단추에 포커스.
  useEffect(() => {
    if (!wantFocus.current) return;
    wantFocus.current = false;
    ref.current?.querySelector<HTMLButtonElement>(`[data-month="${focusMonth}"]`)?.focus();
  }, [focusMonth, year]);

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      onClose(true);
      return;
    }
    if (!(e.target as HTMLElement).dataset.month) return;
    const next = moveMonth(year, focusMonth, e.key);
    if (!next) return;
    e.preventDefault();
    wantFocus.current = true;
    setYear(next.year);
    setFocusMonth(next.month);
  };

  const body = (
    <div
      ref={ref}
      id={id}
      role="dialog"
      aria-modal="false"
      aria-labelledby={titleId}
      onKeyDown={onKeyDown}
      // Tab으로 팝오버 밖(버튼 제외)으로 나가면 닫는다.
      onBlur={(e) => {
        const to = e.relatedTarget as Node | null;
        if (to && !ref.current?.contains(to) && !anchor.current?.contains(to)) onClose(false);
      }}
      style={pos ? { top: pos.top, left: pos.left } : { visibility: "hidden" }}
      className="fixed z-50 w-60 rounded-xl border border-slate-200 bg-white p-3 text-sm text-slate-800 shadow-lg"
    >
      <div className="mb-2 flex items-center justify-between">
        <button type="button" aria-label="이전 해" onClick={() => setYear((y) => y - 1)} className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100">
          ‹
        </button>
        <p id={titleId} className="font-semibold" aria-live="polite">
          {year}년
        </p>
        <button type="button" aria-label="다음 해" onClick={() => setYear((y) => y + 1)} className="rounded-md px-2 py-1 text-slate-600 hover:bg-slate-100">
          ›
        </button>
      </div>
      <div role="group" aria-label={`${year}년 달 고르기`} className="grid grid-cols-3 gap-1">
        {MONTH_NAMES.map((name, i) => {
          const m = i + 1;
          const selected = initial?.year === year && initial.month === m;
          return (
            <button
              key={m}
              type="button"
              data-month={m}
              tabIndex={m === focusMonth ? 0 : -1}
              aria-label={`${year}년 ${m}월`}
              aria-pressed={selected}
              onClick={() => onPick(year, m)}
              className={cn(
                "rounded-md py-1.5 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/50",
                selected ? "bg-indigo-600 font-semibold text-white" : "hover:bg-indigo-50",
              )}
            >
              {name}
            </button>
          );
        })}
      </div>
      {onPickCurrent && (
        <button type="button" onClick={onPickCurrent} className="mt-2 w-full rounded-md border border-slate-200 py-1.5 text-slate-700 hover:bg-slate-50">
          {CURRENT_TEXT}
        </button>
      )}
    </div>
  );
  return typeof document === "undefined" ? body : createPortal(body, document.body);
}

export interface MonthInputProps {
  id?: string;
  value: string;
  onChange: (value: string) => void;
  format: MonthFormat;
  /** 종료일: '현재' 체크를 보인다. */
  allowCurrent?: boolean;
  /** 진행 중을 따로 된 값으로 쓰는 곳(그래프 current). 있으면 '현재'는 이 값으로만 바꾸고 칸 값은 비운다. */
  current?: boolean;
  onCurrentChange?: (on: boolean) => void;
  /** '현재' 체크 이름(기본 "현재"). */
  currentLabel?: string;
  placeholder?: string;
  maxLength?: number;
  required?: boolean;
  /** 칸 이름(라벨 요소가 없을 때). */
  "aria-label"?: string;
  /** 바깥 상자. */
  className?: string;
  /** 글 칸 모양(각 화면의 입력 칸 클래스). */
  inputClassName?: string;
}

export function MonthInput({
  id: idProp,
  value,
  onChange,
  format,
  allowCurrent = false,
  current,
  onCurrentChange,
  currentLabel = CURRENT_TEXT,
  placeholder,
  maxLength,
  required,
  "aria-label": ariaLabel,
  className,
  inputClassName,
}: MonthInputProps) {
  const auto = useId();
  const id = idProp ?? auto;
  const hintId = `${id}-hint`;
  const flagMode = !!onCurrentChange;
  const canCurrent = allowCurrent || flagMode;
  const isCurrent = flagMode ? current === true : canCurrent && parseMonthInput(value, format).kind === "current";
  // 처음 값(저장된 옛 글)이 알아볼 수 없으면 바로 안내한다. 입력하는 동안은 숨기고 칸을 떠날 때 다시 본다.
  const [touched, setTouched] = useState(true);
  const invalid = touched && !isCurrent && !normalizeMonthInput(value, format, { allowCurrent: canCurrent }).recognized;

  function setCurrent(on: boolean) {
    if (flagMode) {
      onCurrentChange!(on);
      if (on && value) onChange("");
    } else onChange(on ? CURRENT_TEXT : "");
  }

  function commit(raw: string) {
    setTouched(true);
    const n = normalizeMonthInput(raw, format, { allowCurrent: canCurrent });
    if (n.current) return setCurrent(true);
    if (n.value !== raw) onChange(n.value);
  }

  function pick(v: string) {
    setTouched(true);
    if (flagMode && current) onCurrentChange!(false);
    onChange(v);
  }

  return (
    <div className={className}>
      <div className="relative">
        <input
          id={id}
          type="text"
          inputMode="text"
          autoComplete="off"
          aria-label={ariaLabel}
          aria-invalid={invalid || undefined}
          aria-describedby={invalid ? hintId : undefined}
          required={required}
          maxLength={maxLength}
          placeholder={placeholder ?? MONTH_HINT[format]}
          disabled={flagMode && isCurrent}
          value={flagMode && isCurrent ? CURRENT_TEXT : value}
          onChange={(e) => {
            setTouched(false);
            onChange(e.target.value);
          }}
          onBlur={(e) => commit(e.target.value)}
          className={cn(inputClassName, "pr-9 disabled:bg-slate-50 disabled:text-slate-500")}
        />
        <span className="absolute inset-y-0 right-1 flex items-center">
          <MonthPickerButton
            value={isCurrent ? "" : value}
            format={format}
            onPick={pick}
            onPickCurrent={canCurrent ? () => setCurrent(true) : undefined}
            className="size-7"
          />
        </span>
      </div>
      {canCurrent && (
        <label className="mt-1 inline-flex items-center gap-1.5 text-xs text-slate-600">
          <input type="checkbox" checked={isCurrent} onChange={(e) => setCurrent(e.target.checked)} className="size-3.5 accent-indigo-600" />
          {currentLabel}
        </label>
      )}
      {invalid && (
        <p id={hintId} className="mt-1 text-xs text-amber-700">
          알아볼 수 없는 날짜예요. {MONTH_HINT[format]}
        </p>
      )}
    </div>
  );
}
