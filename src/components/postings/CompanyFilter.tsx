"use client";
/**
 * '회사' 필터(공고 보관함·공고 찾기 공용): 입력해 회사를 찾고(공고 수와 함께) 여러 회사를 골라 칩으로 둔다.
 * - 값은 회사 키(companyKey) 목록이다. 주소(?company=)·서버 필터는 부르는 쪽(useUrlFilters)이 맞춘다.
 * - 처음 목록(공고 수 많은 회사 + 고른 회사)은 서버가 그려 준다(initialOptions). 입력하면 잠깐 멈춘 뒤 endpoint?q=로 서버에서 찾는다.
 * - 접근성: 입력칸은 combobox(aria-expanded·aria-controls·aria-activedescendant), 목록은 여러 개 고르는 listbox(aria-selected).
 *   ↑↓로 옮기고 Enter로 고르거나 빼며, Esc로 닫는다. 빈 입력칸에서 Backspace는 마지막 칩을 뺀다.
 */
import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { cn } from "@/components/ui/cn";
import { COMPANY_FILTER_MAX, type CompanyOption } from "@/lib/domain/company";

const SEARCH_DELAY_MS = 200;

type Search = { q: string; status: "loading" | "done" | "error"; options: CompanyOption[] };

export function CompanyFilter({
  id,
  endpoint,
  value,
  onChange,
  initialOptions,
  className,
}: {
  id: string;
  /** 회사 목록 API(GET ?q=&include=). */
  endpoint: string;
  /** 고른 회사 키. */
  value: string[];
  onChange: (keys: string[]) => void;
  /** 서버가 그린 처음 목록(공고 수 많은 순 + 고른 회사). */
  initialOptions: CompanyOption[];
  className?: string;
}) {
  const listId = useId();
  const statusId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  /** 칩 빼기·'회사 지우기' 뒤 입력칸으로 포커스를 돌려줄 때는 목록을 열지 않는다(모바일 키보드·드롭다운이 아래를 가리지 않게). */
  const suppressOpenRef = useRef(false);
  const [text, setText] = useState("");
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [search, setSearch] = useState<Search | null>(null);
  /** 한 번 본 회사 표기(칩 이름) — 검색으로 고른 회사가 처음 목록에 없어도 이름으로 보인다. */
  const [seen, setSeen] = useState<Record<string, CompanyOption>>({});
  const q = text.trim();

  useEffect(() => {
    if (!q) return;
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      setSearch((s) => ({ q, status: "loading", options: s?.options ?? [] }));
      try {
        const params = new URLSearchParams({ q });
        const res = await fetch(`${endpoint}?${params}`, { signal: ctrl.signal });
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { options: CompanyOption[] };
        setSearch({ q, status: "done", options: data.options });
        setSeen((prev) => ({ ...prev, ...Object.fromEntries(data.options.map((o) => [o.key, o])) }));
      } catch (err) {
        if ((err as Error).name !== "AbortError") setSearch({ q, status: "error", options: [] });
      }
    }, SEARCH_DELAY_MS);
    return () => {
      clearTimeout(timer);
      ctrl.abort();
    };
  }, [q, endpoint]);

  const known = useMemo(() => {
    const map = new Map<string, CompanyOption>(Object.entries(seen));
    for (const o of initialOptions) map.set(o.key, o);
    return map;
  }, [seen, initialOptions]);

  // 검색어가 있으면 서버 결과(오기 전에는 이미 아는 회사 중 이름이 맞는 것), 없으면 처음 목록.
  const options: CompanyOption[] = useMemo(() => {
    if (!q) return initialOptions;
    if (search?.q === q && search.status !== "loading") return search.options;
    const lower = q.toLowerCase();
    return [...known.values()].filter((o) => o.label.toLowerCase().includes(lower)).slice(0, 20);
  }, [q, search, known, initialOptions]);
  const loading = !!q && (search?.q !== q || search.status === "loading");
  const failed = !!q && search?.q === q && search.status === "error";
  const full = value.length >= COMPANY_FILTER_MAX;
  const activeIndex = active < options.length ? active : -1;

  // 목록이 바뀌면(서버 검색 결과 도착 등) 강조를 지운다 — 같은 자리의 다른 회사를 Enter로 고르지 않게.
  const optionKeys = options.map((o) => o.key).join("\n");
  const [prevKeys, setPrevKeys] = useState(optionKeys);
  if (prevKeys !== optionKeys) {
    setPrevKeys(optionKeys);
    setActive(-1);
  }

  // 키보드로 옮긴 항목이 보이도록 목록을 스크롤한다.
  useEffect(() => {
    if (!open || activeIndex < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)?.scrollIntoView?.({ block: "nearest" });
  }, [open, activeIndex]);

  const focusInputQuietly = () => {
    suppressOpenRef.current = true;
    inputRef.current?.focus();
    suppressOpenRef.current = false;
  };

  const toggle = (o: CompanyOption) => {
    if (value.includes(o.key)) onChange(value.filter((k) => k !== o.key));
    else if (!full) {
      setSeen((prev) => ({ ...prev, [o.key]: o }));
      onChange([...value, o.key]);
      setText("");
    }
    inputRef.current?.focus();
  };

  function onKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      if (!open) setOpen(true);
      if (options.length === 0) return;
      const step = e.key === "ArrowDown" ? 1 : -1;
      setActive((i) => (i < 0 ? (step > 0 ? 0 : options.length - 1) : (i + step + options.length) % options.length));
    } else if (e.key === "Enter") {
      if (open && activeIndex >= 0) {
        e.preventDefault();
        toggle(options[activeIndex]);
      }
    } else if (e.key === "Escape") {
      if (open) {
        e.preventDefault();
        setOpen(false);
        setActive(-1);
      } else if (text) setText("");
    } else if (e.key === "Backspace" && !text && value.length > 0) {
      onChange(value.slice(0, -1));
    }
  }

  const optionId = (i: number) => `${listId}-o${i}`;
  const statusText = !open
    ? ""
    : failed
      ? "회사 목록을 불러오지 못했습니다."
      : loading
        ? "회사를 찾는 중입니다."
        : options.length === 0
          ? "맞는 회사가 없습니다."
          : `회사 ${options.length}곳`;

  return (
    <div
      className={cn("relative", className)}
      onBlur={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) {
          setOpen(false);
          setActive(-1);
        }
      }}
    >
      <label htmlFor={id} className="sr-only">
        회사
      </label>
      <div
        className="flex min-h-[42px] w-full flex-wrap items-center gap-1.5 rounded-lg border border-slate-300 bg-white px-2 py-1.5 focus-within:border-indigo-500 focus-within:ring-2 focus-within:ring-indigo-500/20"
        onClick={(e) => {
          if (e.target === e.currentTarget) inputRef.current?.focus();
        }}
      >
        {value.length > 0 && (
          <ul className="contents" aria-label="고른 회사">
            {value.map((k) => {
              const option = known.get(k);
              // 목록에 없는 키(공고가 없거나 숨긴 공고뿐인 회사): 정규화된 키를 그대로 보이되 '공고 없음'으로 흐리게 둔다.
              const label = option?.label ?? k;
              return (
                <li
                  key={k}
                  className={cn(
                    "inline-flex max-w-full items-center gap-1 rounded-md py-0.5 pr-0.5 pl-2 text-sm",
                    option ? "bg-indigo-50 text-indigo-800" : "bg-slate-100 text-slate-500",
                  )}
                >
                  <span className="min-w-0 truncate" title={option ? label : `${label} (공고 없음)`}>
                    {label}
                    {!option && <span className="ml-1 text-xs">(공고 없음)</span>}
                  </span>
                  <button
                    type="button"
                    onClick={() => {
                      onChange(value.filter((v) => v !== k));
                      focusInputQuietly();
                    }}
                    className="inline-flex size-6 shrink-0 items-center justify-center rounded text-indigo-500 hover:bg-indigo-100 hover:text-indigo-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
                    aria-label={`${label} 빼기`}
                  >
                    <span aria-hidden="true">×</span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        <input
          ref={inputRef}
          id={id}
          type="text"
          role="combobox"
          aria-expanded={open}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={open && activeIndex >= 0 ? optionId(activeIndex) : undefined}
          aria-describedby={statusId}
          autoComplete="off"
          value={text}
          maxLength={100}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => {
            if (!suppressOpenRef.current) setOpen(true);
          }}
          onClick={() => setOpen(true)}
          onKeyDown={onKeyDown}
          placeholder={value.length ? "회사 더 고르기" : "회사 (입력해 찾기)"}
          className="min-w-[8rem] flex-1 border-0 bg-transparent px-1 py-1 text-[15px] text-slate-900 placeholder:text-slate-400 focus:ring-0 focus:outline-none"
        />
        {value.length > 0 && (
          <button
            type="button"
            onClick={() => {
              onChange([]);
              setText("");
              setOpen(false);
              focusInputQuietly();
            }}
            className="ml-auto shrink-0 rounded px-2 py-1 text-xs font-medium text-slate-500 hover:bg-slate-100 hover:text-slate-800 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500"
          >
            회사 지우기
          </button>
        )}
      </div>
      <p id={statusId} className="sr-only" role="status" aria-live="polite">
        {statusText}
      </p>
      {open && (
        <div className="absolute inset-x-0 top-full z-20 mt-1 overflow-hidden rounded-lg border border-slate-200 bg-white shadow-lg">
          {full && <p className="border-b border-slate-100 px-3 py-2 text-xs text-slate-500">회사는 {COMPANY_FILTER_MAX}곳까지 고를 수 있습니다.</p>}
          <ul ref={listRef} id={listId} role="listbox" aria-label="회사" aria-multiselectable="true" className="max-h-64 overflow-y-auto py-1">
            {options.map((o, i) => {
              const selected = value.includes(o.key);
              const disabled = full && !selected;
              return (
                <li
                  key={o.key}
                  id={optionId(i)}
                  data-index={i}
                  role="option"
                  aria-selected={selected}
                  aria-disabled={disabled || undefined}
                  // 누르는 동안 입력칸 포커스를 잃지 않게(목록이 닫히지 않게).
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => !disabled && toggle(o)}
                  onMouseEnter={() => setActive(i)}
                  className={cn(
                    "flex cursor-pointer items-center gap-2 px-3 py-2 text-sm",
                    i === activeIndex ? "bg-indigo-50" : "",
                    disabled ? "cursor-not-allowed text-slate-400" : "text-slate-800",
                  )}
                >
                  <span
                    aria-hidden="true"
                    className={cn(
                      "inline-flex size-4 shrink-0 items-center justify-center rounded border text-[11px] leading-none",
                      selected ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-transparent",
                    )}
                  >
                    ✓
                  </span>
                  <span className="min-w-0 flex-1 truncate">{o.label}</span>
                  <span className="shrink-0 text-xs text-slate-500">{o.count}개</span>
                </li>
              );
            })}
          </ul>
          {options.length === 0 && (
            <p className="px-3 py-2 text-sm text-slate-500">{failed ? "회사 목록을 불러오지 못했습니다." : loading ? "찾는 중…" : q ? "맞는 회사가 없습니다." : "공고가 있는 회사가 없습니다."}</p>
          )}
        </div>
      )}
    </div>
  );
}
