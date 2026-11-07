"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import type { ChatMessage } from "@/lib/domain/chat";
import { MAX_POLISH_MESSAGE_CHARS, polishContinuationStart, polishTargetText, polishTargets, type ResumePolishData } from "@/lib/domain/resume-polish";
import type { ResumeDocument } from "@/lib/domain/resumes";
import type { ResumeMeta, ResumeVersionMeta } from "@/lib/resumes/types";
import { smallInputClass } from "../styles";
import { wordDiff } from "./diff";

export interface PolishApplied {
  version: ResumeVersionMeta;
  document: ResumeDocument;
  resume: ResumeMeta;
}

interface View {
  target: { path: string; label: string; text: string; versionId: string };
  threadId: string | null;
  messages: ChatMessage[];
}

const QUICK = ["더 짧게", "JD 키워드 넣어서", "수치 강조", "더 구체적으로"] as const;

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  return data?.error ?? fallback;
}

/** 다듬기 패널(오른쪽 서랍): 대상 칸 고르기 · 지금 글 · 대화 · 제안 → 차이 미리보기 → 적용(새 버전). */
export function PolishPanel({
  resumeId,
  versionId,
  document: doc,
  dirty,
  target,
  onTargetChange,
  onClose,
  onApplied,
}: {
  resumeId: string;
  /** 편집기의 현재(저장된) 버전 id. 바뀌면(저장·복원·적용) 저장된 지금 글과 대화를 다시 읽는다. */
  versionId: string | null;
  /** 화면의 문서(저장 전일 수 있음). 고를 칸 목록·저장 안 한 변경 안내에 쓴다. 제안·적용은 서버의 저장된 글 기준이다. */
  document: ResumeDocument;
  dirty: boolean;
  target: string | null;
  onTargetChange: (path: string) => void;
  onClose: () => void;
  onApplied: (result: PolishApplied) => void;
}) {
  const [view, setView] = useState<View | null>(null);
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [applying, setApplying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [input, setInput] = useState("");
  const [preview, setPreview] = useState<{ messageId: string; index: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const targets = useMemo(() => polishTargets(doc), [doc]);
  const localText = target ? polishTargetText(doc, target) : null;

  useEffect(() => {
    if (!target) return;
    const ctrl = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 대상·저장된 버전이 바뀌면 그 칸의 대화를 다시 읽는다
    setLoading(true);
    setError(null);
    setPreview(null);
    fetch(`/api/resumes/${resumeId}/polish?target=${encodeURIComponent(target)}`, { signal: ctrl.signal, cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) {
          setView(null);
          setError(await readError(res, "대화를 불러오지 못했습니다."));
          return;
        }
        setView((await res.json()) as View);
      })
      .catch((err: unknown) => {
        if ((err as Error).name !== "AbortError") setError("서버에 연결하지 못했습니다.");
      })
      .finally(() => {
        if (!ctrl.signal.aborted) setLoading(false);
      });
    return () => ctrl.abort();
  }, [resumeId, target, versionId]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [view?.messages.length]);

  async function send(text: string) {
    const message = text.trim();
    if (!target || !message || sending) return;
    setSending(true);
    setError(null);
    setPreview(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/polish`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetPath: target, message }),
      });
      if (!res.ok) {
        setError(await readError(res, "요청을 보내지 못했습니다."));
        return;
      }
      setView((await res.json()) as View);
      setInput("");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setSending(false);
    }
  }

  async function apply(messageId: string, index: number) {
    if (applying) return;
    setApplying(true);
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/polish/apply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messageId, index }),
      });
      if (!res.ok) {
        setError(await readError(res, "적용하지 못했습니다."));
        return;
      }
      const result = (await res.json()) as PolishApplied & { message: ChatMessage };
      onApplied(result);
      setPreview(null);
      setView((v) =>
        v
          ? {
              ...v,
              target: { ...v.target, text: polishTargetText(result.document, v.target.path) ?? v.target.text, versionId: result.version.id },
              messages: v.messages.map((m) => (m.id === result.message.id ? result.message : m)),
            }
          : v,
      );
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setApplying(false);
    }
  }

  const savedText = view?.target.text ?? null;
  // 이 앞의 메시지는 이전 글(칸 위치가 바뀌었거나 직접 고쳤다)에 대한 대화다 — 적용할 수 없게 흐리게 보인다.
  const liveFrom = view ? polishContinuationStart(view.messages, view.target.text) : 0;
  const unsavedHere = dirty && localText !== null && savedText !== null && localText !== savedText;
  const previewData = preview ? view?.messages.find((m) => m.id === preview.messageId)?.data : null;
  const previewSuggestion = previewData?.kind === "resume-polish" ? previewData.suggestions[preview!.index] : undefined;

  return (
    <aside
      className="fixed inset-y-0 right-0 z-40 flex w-full max-w-md flex-col border-l border-slate-200 bg-white shadow-xl"
      aria-label="AI로 다듬기"
      role="dialog"
    >
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-slate-900">AI로 다듬기</h2>
          <p className="text-xs text-slate-500">이력서·공고·경험 그래프에 있는 사실로만 문구를 제안해요.</p>
        </div>
        <button type="button" className="rounded p-1 text-slate-500 hover:bg-slate-100" onClick={onClose} aria-label="닫기">
          ×
        </button>
      </div>

      <div className="space-y-2 border-b border-slate-200 px-4 py-3">
        <label className="block text-xs font-medium text-slate-600">
          다듬을 항목
          <select
            className={cn(smallInputClass, "mt-1")}
            value={target ?? ""}
            onChange={(e) => e.target.value && onTargetChange(e.target.value)}
          >
            <option value="">항목을 고르세요</option>
            {target && !targets.some((t) => t.path === target) && <option value={target}>{view?.target.label ?? target}</option>}
            {targets.map((t) => (
              <option key={t.path} value={t.path}>
                {t.label} — {t.text.slice(0, 30)}
              </option>
            ))}
          </select>
        </label>
        {target && (
          <div className="rounded-md bg-slate-50 px-3 py-2 text-sm whitespace-pre-wrap text-slate-800">
            <span className="mb-1 block text-xs font-medium text-slate-500">저장된 지금 글</span>
            {loading ? "불러오는 중…" : savedText || <span className="text-slate-400">(비어 있음)</span>}
          </div>
        )}
        {unsavedHere && (
          <Alert tone="warning" className="py-2 text-xs">
            이 칸에 저장하지 않은 변경이 있어요. 제안은 저장된 글을 기준으로 만들고, 적용하려면 먼저 저장해 주세요.
          </Alert>
        )}
      </div>

      <div ref={listRef} className="flex-1 space-y-3 overflow-y-auto px-4 py-3">
        {!target && <p className="text-sm text-slate-500">다듬을 항목을 고르거나, 시트에서 칸에 마우스를 올리고 ‘AI로 다듬기’를 누르세요.</p>}
        {target && !loading && view && view.messages.length === 0 && (
          <p className="text-sm text-slate-500">어떻게 고칠지 말해 주세요. 예: “더 짧게”, “JD 키워드 넣어서”, “수치 강조”.</p>
        )}
        {view?.messages.map((m, i) => (
          <div key={m.id}>
            {i === 0 && liveFrom > 0 && <p className="mb-2 text-[11px] font-medium text-slate-400">이전 글에 대한 대화 — 지금 글에는 적용할 수 없어요</p>}
            {i === liveFrom && liveFrom > 0 && <p className="mb-2 border-t border-slate-200 pt-2 text-[11px] font-medium text-slate-400">지금 글에 대한 대화</p>}
            <MessageBubble
              message={m}
              stale={i < liveFrom}
              selected={preview?.messageId === m.id ? preview.index : null}
              onPick={(index) => setPreview({ messageId: m.id, index })}
            />
          </div>
        ))}
        {sending && <p className="text-xs text-slate-500">문구를 만드는 중…</p>}
      </div>

      {previewSuggestion && previewData?.kind === "resume-polish" && (
        <div className="space-y-2 border-t border-slate-200 bg-indigo-50/40 px-4 py-3">
          <p className="text-xs font-medium text-slate-600">바뀌는 내용</p>
          <DiffView before={previewData.before} after={previewSuggestion.text} />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setPreview(null)}>
              취소
            </Button>
            <Button
              size="sm"
              loading={applying}
              disabled={dirty || applying}
              title={dirty ? "새 버전으로 저장하지 않은 변경이 있어요. 먼저 저장(새 버전)해 주세요." : undefined}
              onClick={() => void apply(preview!.messageId, preview!.index)}
            >
              적용(새 버전 저장)
            </Button>
          </div>
          {dirty && (
            <p className="text-xs text-amber-700">
              새 버전으로 저장하지 않은 변경(임시 저장본 포함)이 있어 적용할 수 없어요. 먼저 ‘저장(새 버전)’을 누르거나 임시 저장본을 버려 주세요.
            </p>
          )}
        </div>
      )}

      {error && (
        <div className="px-4 pt-2">
          <Alert tone="error" className="py-2 text-xs">
            {error}
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
              disabled={!target || sending}
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
            disabled={!target || sending}
            onChange={(e) => setInput(e.target.value)}
            placeholder="어떻게 고칠까요? (예: 결과를 앞으로)"
            aria-label="다듬기 요청"
          />
          <Button type="submit" size="sm" loading={sending} disabled={!target || !input.trim() || sending}>
            보내기
          </Button>
        </div>
      </form>
    </aside>
  );
}

function MessageBubble({
  message: m,
  stale,
  selected,
  onPick,
}: {
  message: ChatMessage;
  /** 이전 글에 대한 대화(적용 불가, 흐리게). */
  stale: boolean;
  selected: number | null;
  onPick: (index: number) => void;
}) {
  if (m.role === "user") {
    return <div className={cn("ml-8 rounded-lg bg-indigo-600 px-3 py-2 text-sm whitespace-pre-wrap text-white", stale && "opacity-50")}>{m.content}</div>;
  }
  const data = m.data?.kind === "resume-polish" ? (m.data as ResumePolishData) : null;
  return (
    <div className={cn("mr-4 space-y-2", stale && "opacity-60")}>
      <div className={cn("rounded-lg px-3 py-2 text-sm whitespace-pre-wrap", m.status === "failed" ? "bg-rose-50 text-rose-800" : "bg-slate-100 text-slate-800")}>
        {m.content}
      </div>
      {data?.suggestions.map((s, i) => {
        const applied = m.status === "applied" && data.appliedIndex === i;
        return (
          <button
            key={i}
            type="button"
            disabled={m.status === "applied" || stale}
            title={stale ? "이전 글에 대한 제안이라 적용할 수 없어요. 지금 글로 다시 요청해 주세요." : undefined}
            onClick={() => onPick(i)}
            className={cn(
              "block w-full rounded-lg border px-3 py-2 text-left text-sm transition",
              selected === i ? "border-indigo-500 ring-2 ring-indigo-500/20" : "border-slate-200 hover:border-indigo-300",
              m.status === "applied" && !applied && "opacity-60",
            )}
          >
            <span className="block whitespace-pre-wrap text-slate-900">{s.text}</span>
            <span className="mt-1 block text-xs text-slate-500">{s.reason}</span>
            <span className="mt-1 flex flex-wrap gap-1">
              {applied && <Badge tone="positive">적용함</Badge>}
              {stale && !applied && <Badge tone="neutral">이전 글에 대한 제안</Badge>}
              {s.flagged.length > 0 && <Badge tone="warning">근거 없는 수치 {s.flagged.join(", ")} → 확인 필요</Badge>}
            </span>
          </button>
        );
      })}
      {data?.followUpQuestion && <p className="text-xs text-slate-600">질문: {data.followUpQuestion}</p>}
      {data && data.graphSources > 0 && <p className="text-[11px] text-slate-400">경험 그래프 근거 {data.graphSources}개를 참고했어요.</p>}
    </div>
  );
}

function DiffView({ before, after }: { before: string; after: string }) {
  const parts = wordDiff(before, after);
  return (
    <div className="grid gap-2 text-sm">
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 whitespace-pre-wrap">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">전</span>
        {parts
          .filter((p) => p.kind !== "add")
          .map((p, i) => (p.kind === "del" ? <del key={i} className="bg-rose-100 text-rose-800">{p.text}</del> : <span key={i}>{p.text}</span>))}
      </div>
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 whitespace-pre-wrap">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">후</span>
        {parts
          .filter((p) => p.kind !== "del")
          .map((p, i) => (p.kind === "add" ? <ins key={i} className="bg-emerald-100 text-emerald-800 no-underline">{p.text}</ins> : <span key={i}>{p.text}</span>))}
      </div>
    </div>
  );
}
