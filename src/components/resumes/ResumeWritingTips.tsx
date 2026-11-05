"use client";

/**
 * 이력서 작성 팁 패널(접기·펼치기). 편집기(ResumeEditor)에 붙어 있다.
 * 내용: 첫 화면 4요소(지금 문서에서 채워졌는지 표시), 프로젝트 구조 반복, 성과 숫자 정의·기준, 협업·개성은 행동으로,
 * 제출 전 12개 체크리스트(체크 상태는 이력서별 localStorage). 문구 원천은 src/lib/resumes/writing-guide.ts — 초안·심사 프롬프트와 같은 기준.
 */
import { useMemo, useState, useSyncExternalStore } from "react";
import { cn } from "@/components/ui/cn";
import type { ResumeDocument, ResumeKind } from "@/lib/domain/resumes";
import {
  BEHAVIOR_STRUCTURE,
  FIRST_SCREEN_ITEMS,
  HEADLINE_TEMPLATE,
  NUMBER_CHECKS,
  NUMBER_PITFALLS,
  PROJECT_STRUCTURE,
  resumeTipSignals,
  SUBMIT_CHECKLIST,
  VAGUE_PHRASE_FIXES,
} from "@/lib/resumes/writing-guide";

const OPEN_KEY = "resume.tips.open";
const checksKey = (resumeId: string) => `resume.tips.checks.${resumeId}`;

// ---- localStorage 구독(막혀 있으면 이 탭 메모리에만) ----
const listeners = new Set<() => void>();
const memory = new Map<string, string>();
function read(key: string): string | null {
  if (memory.has(key)) return memory.get(key)!;
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}
function write(key: string, value: string) {
  memory.set(key, value);
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // 이 탭에서는 memory로 유지된다.
  }
  listeners.forEach((l) => l());
}
function subscribe(l: () => void) {
  listeners.add(l);
  const onStorage = (e: StorageEvent) => {
    if (e.key) memory.delete(e.key);
    l();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(l);
    window.removeEventListener("storage", onStorage);
  };
}
function useStored(key: string): string | null {
  return useSyncExternalStore(subscribe, () => read(key), () => null);
}

function parseChecks(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const v: unknown = JSON.parse(raw);
    const ids = new Set<string>(SUBMIT_CHECKLIST.map((c) => c.id));
    return new Set(Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && ids.has(x)) : []);
  } catch {
    return new Set();
  }
}

type Tab = "first" | "project" | "numbers" | "behavior" | "checklist";
const TABS: { id: Tab; label: string }[] = [
  { id: "first", label: "첫 화면 4요소" },
  { id: "project", label: "프로젝트 구조" },
  { id: "numbers", label: "성과 숫자" },
  { id: "behavior", label: "협업·개성" },
  { id: "checklist", label: "제출 전 체크리스트" },
];

export function ResumeWritingTips({ resumeId, kind, document }: { resumeId: string; kind: ResumeKind; document: ResumeDocument }) {
  // 기본은 접힘(편집 공간을 가리지 않게). 한 번 펼치면 다음에도 펼친 채로 연다.
  const open = useStored(OPEN_KEY) === "1";
  const rawChecks = useStored(checksKey(resumeId));
  const checks = useMemo(() => parseChecks(rawChecks), [rawChecks]);
  const [tab, setTab] = useState<Tab>("first");
  const signals = useMemo(() => resumeTipSignals(document), [document]);
  const firstDone = Object.values(signals.firstScreen).filter(Boolean).length;

  function toggleCheck(id: string) {
    const next = new Set(checks);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    write(checksKey(resumeId), JSON.stringify([...next]));
  }

  return (
    <section className="rounded-xl border border-indigo-100 bg-indigo-50/40" aria-labelledby={`tips-${resumeId}`}>
      <button
        type="button"
        id={`tips-${resumeId}`}
        aria-expanded={open}
        aria-controls={`tips-body-${resumeId}`}
        onClick={() => write(OPEN_KEY, open ? "0" : "1")}
        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left"
      >
        <span className="text-sm font-semibold text-indigo-900">
          작성 팁{" "}
          <span className="font-normal text-slate-600">
            · 첫 화면 {firstDone}/4 · 체크리스트 {checks.size}/{SUBMIT_CHECKLIST.length}
            {signals.addPlaceholders > 0 ? ` · 채울 [ADD] ${signals.addPlaceholders}곳` : ""}
          </span>
        </span>
        <span aria-hidden className={cn("text-slate-500 transition-transform", open && "rotate-180")}>
          ▾
        </span>
      </button>
      {open && (
        <div id={`tips-body-${resumeId}`} className="border-t border-indigo-100 px-4 pb-4 pt-3 text-sm text-slate-700">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="작성 팁 주제">
            {TABS.map((t) => (
              <button
                key={t.id}
                type="button"
                role="tab"
                aria-selected={tab === t.id}
                onClick={() => setTab(t.id)}
                className={cn(
                  "rounded-full px-3 py-1 text-xs ring-1 ring-inset",
                  tab === t.id ? "bg-indigo-600 text-white ring-indigo-600" : "bg-white text-slate-700 ring-slate-200 hover:bg-slate-50",
                )}
              >
                {t.label}
              </button>
            ))}
          </div>
          <div className="mt-3" role="tabpanel">
            {tab === "first" && (
              <div className="space-y-2">
                <p>읽는 사람이 위쪽만 훑어도 아래 네 가지가 바로 보이게 배치하세요.</p>
                <ul className="space-y-1.5">
                  {FIRST_SCREEN_ITEMS.map((it) => {
                    const ok = signals.firstScreen[it.key];
                    return (
                      <li key={it.key} className="flex gap-2">
                        <span aria-hidden className={ok ? "text-emerald-600" : "text-slate-300"}>
                          {ok ? "✓" : "○"}
                        </span>
                        <span>
                          <span className="font-medium text-slate-900">{it.title}</span> — {it.body}
                          <span className="sr-only">{ok ? " (채워짐)" : " (비어 있음)"}</span>
                        </span>
                      </li>
                    );
                  })}
                </ul>
                <p className="rounded-lg bg-white px-3 py-2 text-xs text-slate-600">
                  한 줄 소개 틀: {HEADLINE_TEMPLATE}
                  <br />
                  숫자가 아직 확인되지 않았다면 넣지 말고, 실제 도입·검증 결과나 담당 범위를 먼저 쓰세요.
                </p>
                {kind === "general" && <p className="text-xs text-slate-500">공용 이력서는 지원처별로 복제한 뒤 공고에 맞춰 대표 성과 순서를 바꾸세요.</p>}
              </div>
            )}
            {tab === "project" && (
              <div className="space-y-2">
                <p>프로젝트마다 같은 정보를 같은 순서로 두면 비교하기 쉽습니다. 길이는 같지 않아도 됩니다.</p>
                <ol className="flex flex-wrap items-center gap-1 text-xs">
                  {PROJECT_STRUCTURE.map((s, i) => (
                    <li key={s} className="flex items-center gap-1">
                      <span className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200">{s}</span>
                      {i < PROJECT_STRUCTURE.length - 1 && <span aria-hidden>→</span>}
                    </li>
                  ))}
                </ol>
                <p>&lsquo;참여&rsquo;·&lsquo;지원&rsquo;·&lsquo;담당&rsquo;으로 끝나는 문장은 무엇을 분석·결정·만들었는지로 바꾸세요. 보조 역할을 총괄로 부풀리지는 않습니다.</p>
                <div className="overflow-x-auto">
                  <table className="w-full min-w-[32rem] text-left text-xs">
                    <thead className="text-slate-500">
                      <tr>
                        <th className="py-1 pr-2 font-medium">이런 표현이면</th>
                        <th className="py-1 pr-2 font-medium">스스로 물어볼 것</th>
                        <th className="py-1 font-medium">문장 틀</th>
                      </tr>
                    </thead>
                    <tbody>
                      {VAGUE_PHRASE_FIXES.map((r) => (
                        <tr key={r.before} className="border-t border-indigo-100 align-top">
                          <td className="py-1 pr-2">{r.before}</td>
                          <td className="py-1 pr-2">{r.ask}</td>
                          <td className="py-1">{r.frame}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {signals.vagueLines.length > 0 && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <p className="font-medium">지금 이력서에서 행동이 잘 안 보이는 문장</p>
                    <ul className="mt-1 list-disc pl-4">
                      {signals.vagueLines.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {tab === "numbers" && (
              <div className="space-y-2">
                <p>숫자가 많다고 근거가 강해지지는 않습니다. 성과 숫자마다 아래를 설명할 수 있는지 확인하세요.</p>
                <ul className="flex flex-wrap gap-1.5 text-xs">
                  {NUMBER_CHECKS.map((c) => (
                    <li key={c} className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200">
                      {c}
                    </li>
                  ))}
                </ul>
                <ul className="list-disc space-y-0.5 pl-5">
                  {NUMBER_PITFALLS.map((p) => (
                    <li key={p}>{p}</li>
                  ))}
                </ul>
                {signals.numberLinesWithoutContext.length > 0 && (
                  <div className="rounded-lg bg-amber-50 px-3 py-2 text-xs text-amber-900">
                    <p className="font-medium">기간·대상이 함께 보이지 않는 숫자 문장</p>
                    <ul className="mt-1 list-disc pl-4">
                      {signals.numberLinesWithoutContext.map((l, i) => (
                        <li key={i}>{l}</li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            )}
            {tab === "behavior" && (
              <div className="space-y-2">
                <p>&lsquo;성실하다&rsquo;·&lsquo;원만하다&rsquo; 같은 자기평가 대신, 그것을 보여 주는 장면 하나를 고르세요.</p>
                <ol className="flex flex-wrap items-center gap-1 text-xs">
                  {BEHAVIOR_STRUCTURE.map((s, i) => (
                    <li key={s} className="flex items-center gap-1">
                      <span className="rounded-md bg-white px-2 py-1 ring-1 ring-slate-200">{s}</span>
                      {i < BEHAVIOR_STRUCTURE.length - 1 && <span aria-hidden>→</span>}
                    </li>
                  ))}
                </ol>
                <p className="text-xs text-slate-500">회사 지정 양식이 있으면 그 양식이 먼저입니다. 특이한 형식이 역량 증명을 대신하지는 않습니다.</p>
              </div>
            )}
            {tab === "checklist" && (
              <div className="space-y-2">
                <p>
                  제출 직전에 하나씩 확인하세요. 점수로 합격을 예측하는 표가 아닙니다.{" "}
                  <span className="text-xs text-slate-500">(체크는 이 브라우저에 이력서별로 저장됩니다)</span>
                </p>
                <ul className="grid gap-1 sm:grid-cols-2">
                  {SUBMIT_CHECKLIST.map((c, i) => (
                    <li key={c.id}>
                      <label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-0.5 hover:bg-white">
                        <input type="checkbox" className="mt-0.5" checked={checks.has(c.id)} onChange={() => toggleCheck(c.id)} />
                        <span className={cn(checks.has(c.id) && "text-slate-400 line-through")}>
                          {i + 1}. {c.text}
                        </span>
                      </label>
                    </li>
                  ))}
                </ul>
                {checks.size > 0 && (
                  <button type="button" className="text-xs text-slate-500 hover:text-indigo-700" onClick={() => write(checksKey(resumeId), "[]")}>
                    체크 모두 지우기
                  </button>
                )}
                <p className="text-xs text-slate-500">진행 중인 프로젝트를 완료형으로 바꾸지 마세요. 끝난 부분과 진행 중인 부분을 나누고 기준일을 적습니다.</p>
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
