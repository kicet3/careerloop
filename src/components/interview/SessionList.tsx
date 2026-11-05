"use client";

/** 면접 연습 목록: 진행률·상태 배지, 열기·지우기. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/components/app/stages";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import type { InterviewSessionSummary } from "@/lib/domain/interview";
import { deleteSession, InterviewApiError } from "./api";

export function SessionStatusBadge({ status }: { status: InterviewSessionSummary["status"] }) {
  if (status === "generating") return <Badge tone="info">질문 만드는 중</Badge>;
  if (status === "failed") return <Badge tone="negative">만들기 실패</Badge>;
  return <Badge tone="positive">연습 가능</Badge>;
}

export function SessionList({ sessions }: { sessions: InterviewSessionSummary[] }) {
  const router = useRouter();
  const [items, setItems] = useState(sessions);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function remove(s: InterviewSessionSummary) {
    if (!window.confirm(`'${s.title}' 연습을 지울까요? 질문과 답변 기록이 모두 지워집니다.`)) return;
    setBusy(s.id);
    setError(null);
    try {
      await deleteSession(s.id);
      setItems((xs) => xs.filter((x) => x.id !== s.id));
      router.refresh();
    } catch (err) {
      setError(err instanceof InterviewApiError ? err.message : "지우지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  if (items.length === 0) return <p className="text-sm text-slate-500">아직 만든 면접 연습이 없습니다.</p>;
  return (
    <div className="space-y-2">
      {error && <p className="text-sm text-red-700">{error}</p>}
      <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
        {items.map((s) => {
          const pct = s.questionCount ? Math.round((s.answeredCount / s.questionCount) * 100) : 0;
          return (
            <li key={s.id} className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <Link href={`/app/interview/${s.id}`} className="group block min-w-0">
                <div className="flex items-start justify-between gap-3">
                  <p className="min-w-0 flex-1 truncate font-semibold text-slate-900 group-hover:text-indigo-700">{s.title}</p>
                  <SessionStatusBadge status={s.status} />
                </div>
                <p className="mt-0.5 truncate text-sm text-slate-500">
                  {s.resumeLabel}
                  {s.targetLabel ? ` → ${s.targetLabel}` : ""}
                </p>
                <div className="mt-2 flex flex-wrap gap-1.5">
                  {s.hasPortfolio && <Badge>포트폴리오</Badge>}
                  <Badge tone={s.hasPosting ? "accent" : "neutral"}>{s.hasPosting ? "공고 반영" : "직무 일반"}</Badge>
                </div>
                {s.status === "ready" && (
                  <div className="mt-3">
                    <div className="flex justify-between text-xs text-slate-500">
                      <span>
                        연습 {s.answeredCount}/{s.questionCount}문항
                      </span>
                      <span>{pct}%</span>
                    </div>
                    <div className="mt-1 h-1.5 overflow-hidden rounded-full bg-slate-100" aria-hidden>
                      <div className="h-full rounded-full bg-indigo-500" style={{ width: `${pct}%` }} />
                    </div>
                  </div>
                )}
                <p className="mt-2 text-xs text-slate-400">
                  <time dateTime={new Date(s.updatedAt).toISOString()}>{formatDateTime(s.updatedAt)}</time>
                </p>
              </Link>
              <div className="mt-auto flex justify-end pt-3">
                <Button variant="ghost" size="sm" loading={busy === s.id} onClick={() => remove(s)}>
                  지우기
                </Button>
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
