"use client";

/**
 * 지원 동기 칸(지원처별 이력서만 — ResumeEditor가 kind 'company'일 때만 붙인다). 사용자가 직접 쓴다.
 * '추천 받기'는 쓸 거리와, 그 재료(강조하는 점·이어지는 경험·구성안)를 종합한 초안을 받아 온다(POST /api/resumes/[id]/motivation/suggest).
 * 초안은 제안일 뿐이다: '초안으로 채우기'(칸이 비어 있으면 바로, 아니면 확인 후 바꾸기)·'아래에 덧붙이기'를 눌러야 칸에 들어가고, 저장은 하지 않는다.
 * 추천 카드의 '메모로 넣기'는 글 끝에 `- [ADD: 메모 — …]` 한 줄을 붙인다: 미리보기에서 노란 자리표시로 보여 지울 때까지 남은 칸으로 센다.
 * 추천 묶음(초안·강조하는 점·경험·구성·질문·주의)은 제목을 눌러 접고 편다. 접힘 상태는 이 브라우저 localStorage에 기억한다(막혀 있으면 이 화면 동안만).
 */
import { useId, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { MAX_RESUME_MOTIVATION_CHARS } from "@/lib/domain/resumes";
import type { MotivationSuggestResponse } from "@/lib/domain/resume-motivation";
import { textareaClass } from "./styles";

type Suggestion = MotivationSuggestResponse["suggestion"];

/** 메모 한 줄(자리표시 안에 대괄호가 들어가지 않게). @internal 테스트용으로 내보낸다. */
export function memoLine(text: string): string {
  return `- [ADD: 메모 — ${text.replace(/[[\]]/g, "").replace(/\s+/g, " ").trim()}]`;
}

/** 글 끝에 메모 줄을 붙인다. 상한을 넘으면 null. @internal 테스트용으로 내보낸다. */
export function appendMemo(value: string, text: string, max = MAX_RESUME_MOTIVATION_CHARS): string | null {
  const line = memoLine(text);
  const base = value.replace(/\s+$/, "");
  const next = base ? `${base}\n${line}` : line;
  return next.length > max ? null : next;
}

/** '초안으로 채우기': 칸이 비어 있으면 초안 그대로, 아니면 confirmReplace()가 true일 때만 바꾼다(취소·상한 초과면 null). @internal 테스트용. */
export function fillWithDraft(value: string, draft: string, confirmReplace: () => boolean, max = MAX_RESUME_MOTIVATION_CHARS): string | null {
  const next = draft.trim();
  if (!next || next.length > max) return null;
  if (value.trim() && !confirmReplace()) return null;
  return next;
}

/** '아래에 덧붙이기': 지금 글 아래에 빈 줄을 두고 초안을 붙인다. 상한을 넘으면 null. @internal 테스트용. */
export function appendDraft(value: string, draft: string, max = MAX_RESUME_MOTIVATION_CHARS): string | null {
  const add = draft.trim();
  if (!add) return null;
  const base = value.replace(/\s+$/, "");
  const next = base ? `${base}\n\n${add}` : add;
  return next.length > max ? null : next;
}

/** 접고 펴는 추천 묶음. */
export const MOTIVATION_SECTIONS = ["draft", "points", "experiences", "outline", "questions", "cautions"] as const;
export type MotivationSection = (typeof MOTIVATION_SECTIONS)[number];
/** 접힌 묶음(true = 접힘). 기본은 모두 펼침. */
export type FoldState = Partial<Record<MotivationSection, boolean>>;

const FOLD_KEY = "resume.motivation.folds";

/** 저장된 접힘 상태를 읽는다(모르는 키·깨진 값은 버린다). @internal 테스트용. */
export function parseFolds(raw: string | null): FoldState {
  if (!raw) return {};
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return {};
    const out: FoldState = {};
    for (const k of MOTIVATION_SECTIONS) if ((v as Record<string, unknown>)[k] === true) out[k] = true;
    return out;
  } catch {
    return {};
  }
}

function readFolds(): FoldState {
  try {
    return parseFolds(window.localStorage.getItem(FOLD_KEY));
  } catch {
    return {};
  }
}

function writeFolds(folds: FoldState) {
  try {
    window.localStorage.setItem(FOLD_KEY, JSON.stringify(folds));
  } catch {
    // 저장이 막혀 있으면 이 화면 동안만 기억한다.
  }
}

/** '모두 접기/펼치기': 보이는 묶음 중 하나라도 펼쳐져 있으면 모두 접고, 모두 접혀 있으면 모두 편다. @internal 테스트용. */
export function toggleAllFolds(folds: FoldState, visible: readonly MotivationSection[]): FoldState {
  const anyOpen = visible.some((k) => !folds[k]);
  const next: FoldState = { ...folds };
  for (const k of visible) next[k] = anyOpen;
  return next;
}

function MemoButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={`${label} 메모로 넣기`} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
      메모로 넣기
    </button>
  );
}

function Chevron({ open }: { open: boolean }) {
  return (
    <svg aria-hidden="true" viewBox="0 0 20 20" fill="currentColor" className={`h-4 w-4 shrink-0 text-slate-500 transition-transform ${open ? "rotate-90" : ""}`}>
      <path fillRule="evenodd" d="M7.21 14.77a.75.75 0 0 1 .02-1.06L11.17 10 7.23 6.29a.75.75 0 1 1 1.04-1.08l4.5 4.25a.75.75 0 0 1 0 1.08l-4.5 4.25a.75.75 0 0 1-1.06-.02Z" clipRule="evenodd" />
    </svg>
  );
}

/** 접고 펴는 묶음: 제목 버튼(aria-expanded)을 누르면 내용을 숨기거나 보인다. */
function Group({ title, count, open, onToggle, children, list = true }: { title: string; count?: number; open: boolean; onToggle: () => void; children: ReactNode; list?: boolean }) {
  const id = useId();
  return (
    <div>
      <h4 className="text-xs font-semibold text-slate-700">
        <button type="button" aria-expanded={open} aria-controls={id} onClick={onToggle} className="flex w-full items-center gap-1 rounded-md py-0.5 text-left hover:text-slate-900">
          <Chevron open={open} />
          <span>{title}</span>
          {count !== undefined && <span className="font-normal text-slate-400">{count}</span>}
        </button>
      </h4>
      <div id={id} hidden={!open}>
        {open && (list ? <ul className="mt-1.5 space-y-1.5">{children}</ul> : <div className="mt-1.5">{children}</div>)}
      </div>
    </div>
  );
}

/**
 * 추천 묶음(표시 전용). folds로 접힘을 받고 onToggle·onToggleAll로 바꾼다. @internal 테스트용으로 내보낸다(정적 렌더로 aria-expanded 확인).
 */
export function MotivationSuggestionPanel({
  suggestion: s,
  folds,
  onToggle,
  onToggleAll,
  onFill,
  onAppend,
  onMemo,
}: {
  suggestion: Suggestion;
  folds: FoldState;
  onToggle: (k: MotivationSection) => void;
  onToggleAll: (visible: MotivationSection[]) => void;
  onFill: (draft: string) => void;
  onAppend: (draft: string) => void;
  onMemo: (text: string) => void;
}) {
  const draft = s.draft ?? "";
  const counts: Record<MotivationSection, number> = {
    draft: draft ? 1 : 0,
    points: s.companyPoints.length,
    experiences: s.linkedExperiences.length,
    outline: s.outline.length,
    questions: s.questions.length,
    cautions: s.cautions.length,
  };
  const visible = MOTIVATION_SECTIONS.filter((k) => counts[k] > 0);
  const open = (k: MotivationSection) => !folds[k];
  const anyOpen = visible.some(open);
  return (
    <div className="mt-3 space-y-4 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3" role="region" aria-label="지원 동기 추천">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <p className="min-w-0 flex-1 text-xs text-slate-600">추천은 출발점입니다. 초안·메모를 넣은 뒤 [ADD: …] 자리를 채우고 내 말로 고쳐 써 주세요.</p>
        {visible.length > 1 && (
          <button type="button" onClick={() => onToggleAll(visible)} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-slate-600 hover:bg-white">
            {anyOpen ? "모두 접기" : "모두 펼치기"}
          </button>
        )}
      </div>
      {visible.length === 0 && <p className="text-sm text-slate-600">추천할 거리를 찾지 못했습니다. 공고를 연결하거나 경험 그래프를 채운 뒤 다시 받아 보세요.</p>}
      {draft && (
        <Group title="초안" open={open("draft")} onToggle={() => onToggle("draft")} list={false}>
          <div className="rounded-md bg-white p-2.5 text-sm">
            <p className="whitespace-pre-wrap text-slate-800">{draft}</p>
            <p className="mt-1.5 text-xs text-slate-500">강조하는 점·이어지는 경험·구성을 종합한 제안입니다. 자료에 없는 계기·느낌·수치는 [ADD: …]로 남겼습니다. 눌러야 칸에 들어갑니다.</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => onFill(draft)}>
                초안으로 채우기
              </Button>
              <Button size="sm" variant="ghost" onClick={() => onAppend(draft)}>
                아래에 덧붙이기
              </Button>
            </div>
          </div>
        </Group>
      )}
      {s.companyPoints.length > 0 && (
        <Group title="회사가 강조하는 점" count={s.companyPoints.length} open={open("points")} onToggle={() => onToggle("points")}>
          {s.companyPoints.map((p, i) => (
            <li key={i} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">{p.point}</p>
                <p className="mt-0.5 text-xs text-slate-500">공고: “{p.jdQuote}”</p>
              </div>
              <MemoButton label={p.point} onClick={() => onMemo(`회사가 강조: ${p.point}`)} />
            </li>
          ))}
        </Group>
      )}
      {s.linkedExperiences.length > 0 && (
        <Group title="연결할 경험" count={s.linkedExperiences.length} open={open("experiences")} onToggle={() => onToggle("experiences")}>
          {s.linkedExperiences.map((e) => (
            <li key={e.nodeId} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
              <div className="min-w-0">
                <p className="font-medium text-slate-900">
                  <span className="mr-1 text-xs font-normal text-slate-500">{e.kind}</span>
                  {e.name}
                </p>
                <p className="mt-0.5 text-xs text-slate-600">{e.why}</p>
              </div>
              <MemoButton label={e.name} onClick={() => onMemo(`${e.name}: ${e.why}`)} />
            </li>
          ))}
        </Group>
      )}
      {s.outline.length > 0 && (
        <Group title="구성안" count={s.outline.length} open={open("outline")} onToggle={() => onToggle("outline")}>
          {s.outline.map((o, i) => (
            <li key={i} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
              <p className="min-w-0">
                <span className="font-medium text-slate-900">
                  {i + 1}. {o.heading}
                </span>
                <span className="text-slate-600"> — {o.guide}</span>
              </p>
              <MemoButton label={o.heading} onClick={() => onMemo(`${o.heading}: ${o.guide}`)} />
            </li>
          ))}
        </Group>
      )}
      {s.questions.length > 0 && (
        <Group title="확인 질문" count={s.questions.length} open={open("questions")} onToggle={() => onToggle("questions")}>
          {s.questions.map((q, i) => (
            <li key={i} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
              <p className="min-w-0 text-slate-800">{q}</p>
              <MemoButton label={q} onClick={() => onMemo(q)} />
            </li>
          ))}
        </Group>
      )}
      {s.cautions.length > 0 && (
        <Group title="주의" count={s.cautions.length} open={open("cautions")} onToggle={() => onToggle("cautions")}>
          {s.cautions.map((c, i) => (
            <li key={i} className="text-sm text-amber-800">
              · {c}
            </li>
          ))}
        </Group>
      )}
    </div>
  );
}

export function MotivationEditor({ resumeId, value, onChange }: { resumeId: string; value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);
  const [folds, setFolds] = useState<FoldState>({});

  async function suggest() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/motivation/suggest`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ motivation: value }),
      });
      const data = (await res.json().catch(() => null)) as (MotivationSuggestResponse & { error?: string }) | null;
      if (!res.ok || !data?.suggestion) {
        setError(data?.error ?? "추천을 받지 못했습니다. 잠시 후 다시 시도해 주세요.");
        return;
      }
      // 접힘 상태는 추천이 처음 보일 때 읽는다(서버 렌더와 어긋나지 않게 effect·초기값에서 읽지 않는다).
      if (!suggestion) setFolds(readFolds());
      setSuggestion({ ...data.suggestion, draft: data.suggestion.draft ?? "" });
    } catch {
      setError("추천을 받지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  function insert(text: string) {
    const next = appendMemo(value, text);
    if (next === null) {
      setError(`지원 동기는 ${MAX_RESUME_MOTIVATION_CHARS}자까지 쓸 수 있어 메모를 넣지 못했습니다. 글을 줄인 뒤 다시 넣어 주세요.`);
      return;
    }
    setError(null);
    onChange(next);
  }

  function fill(draft: string) {
    const next = fillWithDraft(value, draft, () => window.confirm("지금 쓴 지원 동기를 지우고 초안으로 바꿀까요?"));
    if (next === null) return;
    setError(null);
    onChange(next);
  }

  function append(draft: string) {
    const next = appendDraft(value, draft);
    if (next === null) {
      setError(`지원 동기는 ${MAX_RESUME_MOTIVATION_CHARS}자까지 쓸 수 있어 초안을 덧붙이지 못했습니다. 글을 줄이거나 '초안으로 채우기'를 써 주세요.`);
      return;
    }
    setError(null);
    onChange(next);
  }

  function updateFolds(next: FoldState) {
    setFolds(next);
    writeFolds(next);
  }

  return (
    <Card className="p-4 sm:p-5" data-section="motivation">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">지원 동기</h2>
          <p className="mt-0.5 text-xs text-slate-500">직접 쓰는 칸입니다. AI는 쓸 거리와 초안을 추천할 뿐 칸에 바로 넣지 않습니다. 비워 두면 이력서에 나오지 않습니다.</p>
        </div>
        <Button size="sm" variant="secondary" onClick={suggest} loading={busy} disabled={busy}>
          추천 받기
        </Button>
      </div>
      <label className="mt-3 block">
        <span className="sr-only">지원 동기</span>
        <textarea
          value={value}
          maxLength={MAX_RESUME_MOTIVATION_CHARS}
          rows={7}
          onChange={(e) => onChange(e.target.value)}
          placeholder="이 회사·직무에 지원하는 이유, 이어지는 내 경험, 입사 후 하고 싶은 일을 내 말로 적어 주세요. 문단은 빈 줄로 나눕니다."
          className={textareaClass}
        />
      </label>
      <p className="mt-1 text-right text-xs text-slate-400">
        {value.length} / {MAX_RESUME_MOTIVATION_CHARS}자
      </p>
      {error && (
        <div className="mt-2">
          <Alert tone="error">{error}</Alert>
        </div>
      )}
      {suggestion && (
        <MotivationSuggestionPanel
          suggestion={suggestion}
          folds={folds}
          onToggle={(k) => updateFolds({ ...folds, [k]: !folds[k] })}
          onToggleAll={(visible) => updateFolds(toggleAllFolds(folds, visible))}
          onFill={fill}
          onAppend={append}
          onMemo={insert}
        />
      )}
    </Card>
  );
}
