"use client";

import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import type { ChatMessage } from "@/lib/domain/chat";
import {
  MAX_POLISH_MESSAGE_CHARS,
  POLISH_DOCUMENT_PATH,
  type PolishConflictField,
  type PolishDocSuggestion,
  polishSectionLabel,
  polishTargets,
  type ResumePolishDocData,
} from "@/lib/domain/resume-polish";
import { smallInputClass } from "../styles";
import { DiffView } from "./DiffView";
import type { PolishApplied } from "./PolishPanel";

interface DocView {
  target: { path: string; label: string; text: string; versionId: string };
  threadId: string | null;
  messages: ChatMessage[];
  /** 저장된 현재 버전의 칸 글(경로 → 글). */
  fields: Record<string, string>;
}

const QUICK = ["가장 약한 부분이 어디야?", "JD 대비 빠진 키워드는?", "수치가 부족한 줄은?", "요약을 JD에 맞게"] as const;

async function readError(res: Response, fallback: string): Promise<{ error: string; conflicts: PolishConflictField[] }> {
  const data = (await res.json().catch(() => null)) as { error?: string; conflicts?: PolishConflictField[] } | null;
  return { error: data?.error ?? fallback, conflicts: Array.isArray(data?.conflicts) ? data.conflicts : [] };
}

/** 전체 이력서 대화: 질문 → 답변 + 칸 제안 카드(구역별, 전/후 차이) → 카드별 적용 또는 골라서 한 번에 적용(새 버전 하나). */
export function PolishDocumentChat({
  resumeId,
  versionId,
  dirty,
  onApplied,
  onJump,
}: {
  resumeId: string;
  versionId: string | null;
  dirty: boolean;
  onApplied: (result: PolishApplied) => void;
  onJump: (path: string) => void;
}) {
  const [view, setView] = useState<DocView | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<{ error: string; conflicts: PolishConflictField[] } | null>(null);
  const [input, setInput] = useState("");
  const [selected, setSelected] = useState<{ messageId: string; indices: number[] } | null>(null);
  const [reload, setReload] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 저장된 버전이 바뀌면(저장·복원·적용) 대화와 칸 글을 다시 읽는다
    setLoading(true);
    fetch(`/api/resumes/${resumeId}/polish?target=${POLISH_DOCUMENT_PATH}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          setView(null);
          setError(await readError(res, "대화를 불러오지 못했습니다."));
          return;
        }
        setView((await res.json()) as DocView);
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== "AbortError") setError({ error: "서버에 연결하지 못했습니다.", conflicts: [] });
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [resumeId, versionId, reload]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [view?.messages.length]);

  async function send(text: string) {
    const message = text.trim();
    if (!message || sending) return;
    setSending(true);
    setError(null);
    setSelected(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/polish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPath: POLISH_DOCUMENT_PATH, message }),
      });
      if (!res.ok) {
        setError(await readError(res, "요청을 보내지 못했습니다."));
        return;
      }
      setView((await res.json()) as DocView);
      setInput("");
    } catch {
      setError({ error: "서버에 연결하지 못했습니다.", conflicts: [] });
    } finally {
      setSending(false);
    }
  }

  async function apply(messageId: string, indices: number[]) {
    if (applying || indices.length === 0) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/polish/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, indices }),
      });
      if (!res.ok) {
        setError(await readError(res, "적용하지 못했습니다."));
        // 충돌이면 저장된 칸 글을 다시 읽어 바뀐 칸을 표시한다.
        if (res.status === 409) setReload((n) => n + 1);
        return;
      }
      const result = (await res.json()) as PolishApplied & { message: ChatMessage };
      onApplied(result);
      setSelected(null);
      setView((v) =>
        v
          ? {
              ...v,
              target: { ...v.target, versionId: result.version.id },
              fields: Object.fromEntries(polishTargets(result.document, { includeEmpty: true }).map((t) => [t.path, t.text])),
              messages: v.messages.map((m) => (m.id === result.message.id ? result.message : m)),
            }
          : v,
      );
    } catch {
      setError({ error: "서버에 연결하지 못했습니다.", conflicts: [] });
    } finally {
      setApplying(false);
    }
  }

  function toggle(messageId: string, index: number) {
    setSelected((cur) => {
      const base = cur?.messageId === messageId ? cur.indices : [];
      const indices = base.includes(index) ? base.filter((i) => i !== index) : [...base, index];
      return indices.length ? { messageId, indices } : null;
    });
  }

  return (
    <>
      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {loading && !view && <p className="text-sm text-slate-500">불러오는 중…</p>}
        {!loading && view && view.messages.length === 0 && (
          <p className="text-sm text-slate-500">
            이력서 전체를 보고 답해요. 예: “가장 약한 부분이 어디야?”, “JD 대비 빠진 키워드는?”. 고칠 칸이 있으면 바로 적용할 수 있는 제안도 함께 드려요.
          </p>
        )}
        {view?.messages.map((m) => (
          <DocMessage
            key={m.id}
            message={m}
            fields={view.fields}
            dirty={dirty}
            applying={applying}
            selected={selected?.messageId === m.id ? selected.indices : []}
            onToggle={(i) => toggle(m.id, i)}
            onApply={(indices) => void apply(m.id, indices)}
            onJump={onJump}
          />
        ))}
        {sending && <p className="text-xs text-slate-500">이력서를 살펴보는 중…</p>}
      </div>

      {dirty && (
        <div className="px-4 pt-2">
          <p className="text-xs text-amber-700">
            새 버전으로 저장하지 않은 변경(임시 저장본 포함)이 있어 적용할 수 없어요. 답변과 제안은 저장된 버전을 기준으로 만들어요.
          </p>
        </div>
      )}

      {error && (
        <div className="px-4 pt-2">
          <Alert tone="error" className="py-2 text-xs">
            {error.error}
            {error.conflicts.length > 0 && (
              <ul className="mt-1 list-disc pl-4">
                {error.conflicts.map((c) => (
                  <li key={c.path}>{c.label}</li>
                ))}
              </ul>
            )}
          </Alert>
        </div>
      )}

      <form
        className="space-y-2 border-t border-slate-200 px-4 py-3"
        onSubmit={(e) => {
          e.preventDefault();
          void send(input);
        }}
      >
        <div className="flex flex-wrap gap-1.5">
          {QUICK.map((q) => (
            <button
              key={q}
              type="button"
              disabled={sending}
              className="rounded-full border border-slate-300 px-2.5 py-0.5 text-xs text-slate-700 hover:bg-slate-50 disabled:opacity-50"
              onClick={() => void send(q)}
            >
              {q}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <input
            className={smallInputClass}
            value={input}
            maxLength={MAX_POLISH_MESSAGE_CHARS}
            disabled={sending}
            onChange={(e) => setInput(e.target.value)}
            placeholder="이력서에 대해 물어보세요 (예: 어떤 경력을 앞에 둘까?)"
            aria-label="전체 이력서 질문"
          />
          <Button type="submit" size="sm" loading={sending} disabled={!input.trim() || sending}>
            보내기
          </Button>
        </div>
      </form>
    </>
  );
}

function DocMessage({
  message: m,
  fields,
  dirty,
  applying,
  selected,
  onToggle,
  onApply,
  onJump,
}: {
  message: ChatMessage;
  fields: Record<string, string>;
  dirty: boolean;
  applying: boolean;
  selected: number[];
  onToggle: (index: number) => void;
  onApply: (indices: number[]) => void;
  onJump: (path: string) => void;
}) {
  if (m.role === "user") {
    return <div className="ml-8 rounded-lg bg-indigo-600 px-3 py-2 text-sm whitespace-pre-wrap text-white">{m.content}</div>;
  }
  const data = m.data?.kind === "resume-polish-doc" ? (m.data as ResumePolishDocData) : null;
  const appliedSet = new Set((data?.applied ?? []).map((a) => a.index));
  const groups = new Map<string, { s: PolishDocSuggestion; i: number }[]>();
  data?.suggestions.forEach((s, i) => {
    const key = polishSectionLabel(s.path);
    groups.set(key, [...(groups.get(key) ?? []), { s, i }]);
  });
  // 저장된 칸 글이 제안 때 글이면 적용할 수 있다(적용한 뒤 되돌린 제안도 다시 적용할 수 있다).
  const selectable = (s: PolishDocSuggestion) => fields[s.path] === s.before;
  // 고른 뒤 바뀐 칸(다시 읽기·다른 카드 적용)은 '선택 적용'에서 뺀다.
  const picked = selected.filter((i) => data?.suggestions[i] && selectable(data.suggestions[i]));
  const blockedTitle = dirty ? "새 버전으로 저장하지 않은 변경이 있어요. 먼저 저장(새 버전)해 주세요." : undefined;
  return (
    <div className="mr-2 space-y-2">
      <div className={cn("rounded-lg px-3 py-2 text-sm whitespace-pre-wrap", m.status === "failed" ? "bg-rose-50 text-rose-800" : "bg-slate-100 text-slate-800")}>
        {m.content}
      </div>
      {data && data.answerFlagged.length > 0 && <Badge tone="warning">답변의 근거 없는 수치 {data.answerFlagged.join(", ")} → 확인 필요</Badge>}
      {[...groups.entries()].map(([section, items]) => (
        <div key={section} className="space-y-1.5">
          <p className="text-[11px] font-semibold text-slate-500">{section}</p>
          {items.map(({ s, i }) => {
            const live = selectable(s);
            const applied = appliedSet.has(i) && !live && fields[s.path] === s.after;
            const reverted = appliedSet.has(i) && live;
            const stale = !live && !applied;
            return (
              <div key={i} className={cn("space-y-2 rounded-lg border px-3 py-2", picked.includes(i) ? "border-indigo-500 ring-2 ring-indigo-500/20" : "border-slate-200", (applied || stale) && "opacity-70")}>
                <div className="flex items-start justify-between gap-2">
                  <label className="flex items-start gap-2 text-xs font-medium text-slate-700">
                    <input
                      type="checkbox"
                      className="mt-0.5"
                      checked={picked.includes(i)}
                      disabled={!live}
                      onChange={() => onToggle(i)}
                      aria-label={`${s.label} 선택`}
                    />
                    {s.label}
                  </label>
                  <button type="button" className="shrink-0 text-[11px] text-indigo-700 underline" onClick={() => onJump(s.path)}>
                    칸으로 이동
                  </button>
                </div>
                <DiffView before={s.before} after={s.after} />
                {s.reason && <p className="text-xs text-slate-500">{s.reason}</p>}
                <div className="flex flex-wrap items-center justify-between gap-1">
                  <span className="flex flex-wrap gap-1">
                    {applied && <Badge tone="positive">적용함</Badge>}
                    {reverted && <Badge tone="neutral">적용 뒤 되돌림 — 다시 적용할 수 있어요</Badge>}
                    {stale && <Badge tone="neutral">제안 뒤 바뀐 칸 — 적용할 수 없어요</Badge>}
                    {s.flagged.length > 0 && <Badge tone="warning">근거 없는 수치 {s.flagged.join(", ")} → 확인 필요</Badge>}
                  </span>
                  <Button size="sm" variant="secondary" disabled={!live || dirty || applying} title={blockedTitle} onClick={() => onApply([i])}>
                    적용
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      ))}
      {data && data.suggestions.length > 1 && (
        <div className="flex justify-end">
          <Button size="sm" loading={applying} disabled={picked.length === 0 || dirty || applying} title={blockedTitle} onClick={() => onApply(picked)}>
            선택 적용{picked.length ? ` (${picked.length})` : ""} · 새 버전 하나로
          </Button>
        </div>
      )}
      {data?.followUpQuestion && <p className="text-xs text-slate-600">질문: {data.followUpQuestion}</p>}
      {data && data.graphSources > 0 && <p className="text-[11px] text-slate-400">경험 그래프 근거 {data.graphSources}개를 참고했어요.</p>}
    </div>
  );
}
