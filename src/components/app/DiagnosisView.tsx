"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import type { DiagnosisStatus, StageStatus } from "@/lib/domain/schemas";
import {
  DIAGNOSIS_STATUS_VIEW,
  formatElapsed,
  groupStatus,
  isActiveStatus,
  progressCounts,
  STAGE_GROUPS,
  stageLabel,
  type StageState,
} from "./stages";

const POLL_MS = 2000;

export interface DiagnosisViewState {
  status: DiagnosisStatus;
  error: string | null;
  stages: StageState[];
  /** 경과 시간 기준(epoch ms). */
  startedAt: number;
}

/** GET /api/diagnoses/[id] 응답 중 이 화면이 쓰는 부분(DiagnosisStatusResponse의 부분집합). */
interface PollResponse {
  status: DiagnosisStatus;
  error: string | null;
  stages: StageState[];
}

/**
 * 진행 중·실패한 진단의 진행 화면. 2초마다 상태를 폴링하고,
 * 완료되면 router.refresh()로 서버 페이지가 보고서를 그리게 한다.
 */
export function DiagnosisView({ id, initial }: { id: string; initial: DiagnosisViewState }) {
  const router = useRouter();
  const [state, setState] = useState(initial);
  const [pollError, setPollError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [now, setNow] = useState<number | null>(null);
  const refreshed = useRef(false);

  const active = isActiveStatus(state.status);

  // 폴링
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const controller = new AbortController();

    async function tick() {
      try {
        const res = await fetch(`/api/diagnoses/${id}`, { cache: "no-store", signal: controller.signal });
        if (res.status === 404) {
          setPollError("진단을 찾을 수 없습니다. 삭제되었을 수 있습니다.");
          return;
        }
        if (res.status === 401) {
          router.push(`/login?next=/app/d/${id}`);
          return;
        }
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as PollResponse;
        if (cancelled) return;
        setPollError(null);
        setState((prev) => ({ ...prev, status: data.status, error: data.error, stages: data.stages }));
        if (isActiveStatus(data.status)) timer = setTimeout(tick, POLL_MS);
      } catch {
        if (cancelled) return;
        setPollError("상태를 불러오지 못해 다시 시도하는 중입니다…");
        timer = setTimeout(tick, POLL_MS * 2);
      }
    }
    timer = setTimeout(tick, POLL_MS);
    return () => {
      cancelled = true;
      controller.abort();
      clearTimeout(timer);
    };
  }, [active, id, router]);

  // 완료되면 서버 컴포넌트가 보고서를 렌더링하도록 새로고침
  useEffect(() => {
    if (state.status === "done" && !refreshed.current) {
      refreshed.current = true;
      router.refresh();
    }
  }, [state.status, router]);

  // 경과 시간 (하이드레이션 이후에만 계산)
  useEffect(() => {
    if (!active) return;
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const t = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(t);
    };
  }, [active]);

  async function retry() {
    setRetrying(true);
    setRetryError(null);
    try {
      const res = await fetch(`/api/diagnoses/${id}/retry`, { method: "POST" });
      const data = (await res.json().catch(() => null)) as { error?: string } | null;
      if (!res.ok) {
        setRetryError(
          data?.error ??
            (res.status === 409
              ? "이미 진행 중인 진단이 있습니다."
              : res.status === 429
                ? "오늘 진단 가능 횟수를 모두 사용했습니다."
                : "재시도를 시작하지 못했습니다."),
        );
        return;
      }
      refreshed.current = false;
      setState((prev) => ({
        status: "queued",
        error: null,
        startedAt: Date.now(),
        stages: prev.stages.map((s) => (s.status === "done" ? s : { ...s, status: "pending", error: null })),
      }));
    } catch {
      setRetryError("서버에 연결하지 못했습니다.");
    } finally {
      setRetrying(false);
    }
  }

  const { done, total } = progressCounts(state.stages);
  const pct = total ? Math.round((done / total) * 100) : 0;
  const statusView = DIAGNOSIS_STATUS_VIEW[state.status];
  const failed = state.status === "failed";

  return (
    <div className="space-y-5">
      <Card className="p-5 sm:p-6">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <h2 className="text-lg font-semibold text-slate-900">
              {state.status === "done" ? "보고서를 불러오는 중" : failed ? "진단이 중단되었습니다" : "심사 중입니다"}
            </h2>
            <Badge tone={statusView.tone}>{statusView.label}</Badge>
          </div>
          {active && now !== null && (
            <span className="text-sm text-slate-500 tabular-nums">경과 {formatElapsed(now - state.startedAt)}</span>
          )}
        </div>

        <div className="mt-4">
          <div className="flex justify-between text-xs text-slate-500">
            <span>
              {done}/{total} 단계 완료
            </span>
            <span className="tabular-nums">{pct}%</span>
          </div>
          <div
            role="progressbar"
            aria-label="진단 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={pct}
            className="mt-1.5 h-2 overflow-hidden rounded-full bg-slate-100"
          >
            <div
              className={cn("h-full rounded-full transition-[width] duration-500", failed ? "bg-red-400" : "bg-indigo-600")}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>

        {active && (
          <p className="mt-4 text-sm text-slate-500">
            심사위원 7명이 각자 이력서를 읽고, 종합·재작성·개선 방향까지 만드는 데 보통 3~5분 걸립니다. 이 창을 닫아도
            진단은 계속되며 <Link href="/app" className="text-indigo-700 underline underline-offset-2">내 진단</Link>에서
            다시 볼 수 있습니다.
          </p>
        )}
        {state.status === "done" && (
          <p className="mt-4 flex items-center gap-2 text-sm text-slate-500">
            <Spinner size="sm" /> 보고서를 만드는 중입니다…
          </p>
        )}
        {pollError && <p className="mt-3 text-sm text-amber-700" role="status">{pollError}</p>}
      </Card>

      {failed && (
        <Alert tone="error" title="일부 단계가 실패했습니다">
          <p>{state.error ?? "알 수 없는 오류가 발생했습니다."}</p>
          <p className="mt-1 text-red-700/80">
            재시도하면 이미 끝난 단계는 그대로 두고 실패한 단계부터 이어서 진행합니다.
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button onClick={retry} loading={retrying}>
              재시도
            </Button>
            <Link href="/app" className={buttonClass("secondary")}>
              내 진단으로
            </Link>
          </div>
          {retryError && <p className="mt-2 font-medium">{retryError}</p>}
        </Alert>
      )}

      <ol className="space-y-3">
        {STAGE_GROUPS.map((group, i) => {
          const gs = groupStatus(group.stages, state.stages);
          const multi = group.stages.length > 1;
          return (
            <li key={group.id}>
              <Card className="p-4 sm:p-5">
                <div className="flex items-start gap-3">
                  <StepMarker index={i + 1} status={gs} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                      <h3 className="font-semibold text-slate-900">{group.title}</h3>
                      {multi && <span className="text-xs text-slate-400">동시 진행</span>}
                    </div>
                    {group.hint && <p className="mt-0.5 text-sm text-slate-500">{group.hint}</p>}
                    {(multi || gs === "failed") && (
                      <ul className={cn("mt-3 grid gap-1.5", multi && "sm:grid-cols-2")}>
                        {group.stages.map((key) => {
                          const s = state.stages.find((x) => x.stage === key);
                          return (
                            <StageRow
                              key={key}
                              label={stageLabel(key)}
                              status={s?.status ?? "pending"}
                              error={s?.error ?? null}
                              halted={failed}
                            />
                          );
                        })}
                      </ul>
                    )}
                  </div>
                </div>
              </Card>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

const STAGE_STATUS_TEXT: Record<StageStatus, string> = {
  pending: "대기",
  running: "진행 중",
  done: "완료",
  failed: "실패",
};

function StageRow({
  label,
  status,
  error,
  halted,
}: {
  label: string;
  status: StageStatus;
  error: string | null;
  halted: boolean;
}) {
  const text = halted && status === "pending" ? "중단됨" : STAGE_STATUS_TEXT[status];
  return (
    <li className="rounded-md bg-slate-50 px-3 py-2 text-sm">
      <div className="flex items-center justify-between gap-2">
        <span className="truncate text-slate-800">{label}</span>
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 text-xs font-medium",
            status === "done" && "text-emerald-700",
            status === "running" && "text-indigo-700",
            status === "failed" && "text-red-700",
            status === "pending" && "text-slate-400",
          )}
        >
          {status === "running" && <Spinner size="sm" />}
          {status === "done" && <CheckIcon />}
          {text}
        </span>
      </div>
      {status === "failed" && error && <p className="mt-1 text-xs break-words text-red-700">{error}</p>}
    </li>
  );
}

function StepMarker({ index, status }: { index: number; status: StageStatus }) {
  const base = "grid size-7 shrink-0 place-items-center rounded-full text-xs font-bold";
  if (status === "done")
    return (
      <span className={cn(base, "bg-emerald-100 text-emerald-700")} aria-label="완료">
        <CheckIcon />
      </span>
    );
  if (status === "running")
    return (
      <span className={cn(base, "bg-indigo-100 text-indigo-700")} aria-label="진행 중">
        <Spinner size="sm" />
      </span>
    );
  if (status === "failed")
    return (
      <span className={cn(base, "bg-red-100 text-red-700")} aria-label="실패">
        !
      </span>
    );
  return (
    <span className={cn(base, "bg-slate-100 text-slate-500")} aria-label="대기">
      {index}
    </span>
  );
}

function CheckIcon() {
  return (
    <svg viewBox="0 0 16 16" className="size-3.5" fill="none" stroke="currentColor" strokeWidth={2.2} aria-hidden>
      <path d="M3.5 8.5l3 3 6-7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}
