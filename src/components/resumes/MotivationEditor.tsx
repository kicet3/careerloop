"use client";

/**
 * 지원 동기 칸(지원처별 이력서만 — ResumeEditor가 kind 'company'일 때만 붙인다). 사용자가 직접 쓴다.
 * '추천 받기'는 쓸 거리만 받아 온다(POST /api/resumes/[id]/motivation/suggest — 문단은 쓰지 않는다).
 * 추천 카드의 '메모로 넣기'는 글 끝에 `- [ADD: 메모 — …]` 한 줄을 붙인다: 미리보기에서 노란 자리표시로 보여 지울 때까지 남은 칸으로 센다.
 */
import { useState, type ReactNode } from "react";
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

function MemoButton({ onClick, label }: { onClick: () => void; label: string }) {
  return (
    <button type="button" onClick={onClick} aria-label={`${label} 메모로 넣기`} className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50">
      메모로 넣기
    </button>
  );
}

function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div>
      <h4 className="text-xs font-semibold text-slate-700">{title}</h4>
      <ul className="mt-1.5 space-y-1.5">{children}</ul>
    </div>
  );
}

export function MotivationEditor({ resumeId, value, onChange }: { resumeId: string; value: string; onChange: (v: string) => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestion, setSuggestion] = useState<Suggestion | null>(null);

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
      setSuggestion(data.suggestion);
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

  const s = suggestion;
  const empty = s && s.companyPoints.length + s.linkedExperiences.length + s.outline.length + s.questions.length + s.cautions.length === 0;

  return (
    <Card className="p-4 sm:p-5" data-section="motivation">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-base font-semibold text-slate-900">지원 동기</h2>
          <p className="mt-0.5 text-xs text-slate-500">직접 쓰는 칸입니다. AI는 쓸 거리만 추천하고 문장은 쓰지 않습니다. 비워 두면 이력서에 나오지 않습니다.</p>
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
      {s && (
        <div className="mt-3 space-y-4 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3" aria-label="지원 동기 쓸 거리 추천">
          <p className="text-xs text-slate-600">추천은 재료일 뿐입니다. 메모로 넣은 줄은 노란 자리표시로 남으니 내 말로 바꿔 써 주세요.</p>
          {empty && <p className="text-sm text-slate-600">추천할 거리를 찾지 못했습니다. 공고를 연결하거나 경험 그래프를 채운 뒤 다시 받아 보세요.</p>}
          {s.companyPoints.length > 0 && (
            <Group title="회사·공고가 강조하는 점">
              {s.companyPoints.map((p, i) => (
                <li key={i} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">{p.point}</p>
                    <p className="mt-0.5 text-xs text-slate-500">공고: “{p.jdQuote}”</p>
                  </div>
                  <MemoButton label={p.point} onClick={() => insert(`회사가 강조: ${p.point}`)} />
                </li>
              ))}
            </Group>
          )}
          {s.linkedExperiences.length > 0 && (
            <Group title="이어지는 내 경험">
              {s.linkedExperiences.map((e) => (
                <li key={e.nodeId} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium text-slate-900">
                      <span className="mr-1 text-xs font-normal text-slate-500">{e.kind}</span>
                      {e.name}
                    </p>
                    <p className="mt-0.5 text-xs text-slate-600">{e.why}</p>
                  </div>
                  <MemoButton label={e.name} onClick={() => insert(`${e.name}: ${e.why}`)} />
                </li>
              ))}
            </Group>
          )}
          {s.outline.length > 0 && (
            <Group title="문단 구성">
              {s.outline.map((o, i) => (
                <li key={i} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
                  <p className="min-w-0">
                    <span className="font-medium text-slate-900">
                      {i + 1}. {o.heading}
                    </span>
                    <span className="text-slate-600"> — {o.guide}</span>
                  </p>
                  <MemoButton label={o.heading} onClick={() => insert(`${o.heading}: ${o.guide}`)} />
                </li>
              ))}
            </Group>
          )}
          {s.questions.length > 0 && (
            <Group title="먼저 답해 볼 질문">
              {s.questions.map((q, i) => (
                <li key={i} className="flex items-start justify-between gap-2 rounded-md bg-white p-2 text-sm">
                  <p className="min-w-0 text-slate-800">{q}</p>
                  <MemoButton label={q} onClick={() => insert(q)} />
                </li>
              ))}
            </Group>
          )}
          {s.cautions.length > 0 && (
            <Group title="주의할 점">
              {s.cautions.map((c, i) => (
                <li key={i} className="text-sm text-amber-800">
                  · {c}
                </li>
              ))}
            </Group>
          )}
        </div>
      )}
    </Card>
  );
}
