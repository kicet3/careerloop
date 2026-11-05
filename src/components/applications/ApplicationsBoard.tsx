"use client";

/**
 * 지원 현황 보드. 넓은 화면(lg 이상)은 단계별 칸반 열, 좁은 화면은 단계 필터 + 목록. 카드를 누르면 오른쪽 패널에서
 * 수정·단계 변경·단계 이력·제출본을 본다. 카드의 단계 선택으로 바로 옮길 수도 있다(끌어 놓기 대신 — 키보드·터치에서도 같다).
 * ?new=1&postingId=<id>로 들어오면 그 공고로 새 지원 폼을, ?open=<id>면 그 지원을 연다.
 */
import { useRouter } from "next/navigation";
import { useCallback, useMemo, useState, useSyncExternalStore } from "react";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import type { ApplicationFormOptions } from "@/lib/applications/options";
import {
  APPLICATION_BOARD_COLUMNS,
  APPLICATION_STAGE_LABELS,
  APPLICATION_STAGES,
  CLOSED_STAGES,
  type ApplicationStage,
  type JobApplication,
} from "@/lib/domain/applications";
import { formatKstDate, kstToday, relativeKstLabel, daysBetween } from "@/lib/time/kst";
import { ApplicationPanel, type PanelTarget } from "./ApplicationPanel";
import { STAGE_DOT, STAGE_TONE } from "./stage-style";

type Filter = "active" | "all" | ApplicationStage;

const noopSubscribe = () => () => {};

export function ApplicationsBoard({
  initialItems,
  options,
  initialTarget,
}: {
  initialItems: JobApplication[];
  options: ApplicationFormOptions;
  initialTarget: PanelTarget | null;
}) {
  const router = useRouter();
  const [items, setItems] = useState(initialItems);
  const [target, setTarget] = useState<PanelTarget | null>(initialTarget);
  const [filter, setFilter] = useState<Filter>("active");
  const [query, setQuery] = useState("");
  const [moving, setMoving] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const today = kstToday();
  // 패널은 document.body로 포털을 연다 — 서버 렌더(?new=·?open=으로 처음부터 열린 경우)에서는 그리지 않고 하이드레이션 뒤에 연다.
  const hydrated = useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q ? items.filter((a) => `${a.company} ${a.roleTitle} ${a.nextStep}`.toLowerCase().includes(q)) : items;
    // 즐겨찾기 → 다음 일정 가까운 순 → 최근 수정순.
    return [...list].sort(
      (a, b) =>
        Number(b.favorite) - Number(a.favorite) ||
        (a.nextDate ?? "9999").localeCompare(b.nextDate ?? "9999") ||
        b.updatedAt - a.updatedAt,
    );
  }, [items, query]);

  const counts = useMemo(() => {
    const c = Object.fromEntries(APPLICATION_STAGES.map((s) => [s, 0])) as Record<ApplicationStage, number>;
    for (const a of visible) c[a.stage] += 1;
    return c;
  }, [visible]);

  const mobileList = visible.filter((a) =>
    filter === "all" ? true : filter === "active" ? !CLOSED_STAGES.includes(a.stage) : a.stage === filter,
  );

  const upsert = useCallback(
    (a: JobApplication) => {
      setItems((prev) => {
        const i = prev.findIndex((x) => x.id === a.id);
        if (i < 0) return [a, ...prev];
        const next = [...prev];
        next[i] = a;
        return next;
      });
      router.refresh();
    },
    [router],
  );
  const remove = useCallback(
    (id: string) => {
      setItems((prev) => prev.filter((x) => x.id !== id));
      router.refresh();
    },
    [router],
  );
  const closePanel = useCallback(() => setTarget(null), []);

  async function moveStage(a: JobApplication, stage: ApplicationStage) {
    if (stage === a.stage) return;
    setMoving(a.id);
    setError(null);
    try {
      const res = await fetch(`/api/applications/${a.id}/stage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ stage }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.error ?? "단계를 바꾸지 못했습니다.");
      const { events: _events, ...app } = data.application;
      void _events;
      upsert(app as JobApplication);
    } catch (err) {
      setError(err instanceof Error ? err.message : "단계를 바꾸지 못했습니다.");
    } finally {
      setMoving(null);
    }
  }

  const card = (a: JobApplication) => (
    <ApplicationCard
      key={a.id}
      app={a}
      today={today}
      busy={moving === a.id}
      onOpen={() => setTarget({ mode: "edit", id: a.id })}
      onMove={(s) => moveStage(a, s)}
    />
  );

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <label className="min-w-0 flex-1 sm:max-w-xs">
          <span className="sr-only">회사·직무 검색</span>
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="회사·직무 검색"
            className="block h-10 w-full rounded-lg border border-slate-300 bg-white px-3 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
          />
        </label>
        <Button onClick={() => setTarget({ mode: "new", postingId: null })}>지원 기록 추가</Button>
      </div>

      {error && (
        <p role="alert" className="text-sm text-red-700">
          {error}
        </p>
      )}

      {items.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-lg font-semibold text-slate-900">아직 지원 기록이 없습니다</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            지원한 회사와 낸 이력서 버전을 남겨 두면 단계별 진행과 버전별 실제 응답률을 비교할 수 있습니다. 공고 보관함의 공고에서 바로 추가할 수도
            있습니다.
          </p>
          <Button size="lg" className="mt-6" onClick={() => setTarget({ mode: "new", postingId: null })}>
            첫 지원 기록 추가
          </Button>
        </Card>
      ) : (
        <>
          {/* 좁은 화면: 단계 필터 + 목록 */}
          <div className="lg:hidden">
            <div className="relative -mx-4 flex gap-1.5 overflow-x-auto px-4 pb-2 sm:-mx-6 sm:px-6" role="tablist" aria-label="단계 필터">
              {(["active", "all", ...APPLICATION_STAGES] as Filter[]).map((f) => {
                const n =
                  f === "all" ? visible.length : f === "active" ? visible.filter((a) => !CLOSED_STAGES.includes(a.stage)).length : counts[f];
                const label = f === "all" ? "전체" : f === "active" ? "진행 중" : APPLICATION_STAGE_LABELS[f];
                return (
                  <button
                    key={f}
                    type="button"
                    role="tab"
                    aria-selected={filter === f}
                    onClick={() => setFilter(f)}
                    className={cn(
                      "inline-flex h-8 shrink-0 items-center gap-1 rounded-full border px-3 text-sm",
                      filter === f ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700",
                    )}
                  >
                    {label}
                    <span className={cn("tabular-nums", filter === f ? "text-indigo-100" : "text-slate-400")}>{n}</span>
                  </button>
                );
              })}
            </div>
            {mobileList.length === 0 ? (
              <p className="py-10 text-center text-sm text-slate-500">이 단계의 지원이 없습니다.</p>
            ) : (
              <ul className="mt-2 grid gap-2 sm:grid-cols-2">{mobileList.map((a) => <li key={a.id}>{card(a)}</li>)}</ul>
            )}
          </div>

          {/* 넓은 화면: 단계별 칸반 열 */}
          {/* relative: 카드 안 sr-only(absolute) 글자가 스크롤 영역 밖 문서 폭을 늘리지 않게 */}
          <div className="relative hidden gap-3 overflow-x-auto pb-2 lg:flex">
            {APPLICATION_BOARD_COLUMNS.map((stage) => {
              const col = visible.filter((a) => a.stage === stage);
              return (
                <section
                  key={stage}
                  aria-label={`${APPLICATION_STAGE_LABELS[stage]} ${col.length}건`}
                  className="flex w-60 shrink-0 flex-col rounded-xl border border-slate-200 bg-slate-50/70 min-[1600px]:w-auto min-[1600px]:flex-1"
                >
                  <h2 className="flex items-center gap-2 px-3 pt-3 pb-2 text-sm font-semibold text-slate-800">
                    <span aria-hidden className={cn("size-2 rounded-full", STAGE_DOT[stage])} />
                    {APPLICATION_STAGE_LABELS[stage]}
                    <span className="ml-auto text-xs font-normal tabular-nums text-slate-500">{col.length}</span>
                  </h2>
                  <ul className="flex min-h-24 flex-1 flex-col gap-2 px-2 pb-2">{col.map((a) => <li key={a.id}>{card(a)}</li>)}</ul>
                </section>
              );
            })}
          </div>
        </>
      )}

      {target && hydrated && <ApplicationPanel target={target} options={options} onClose={closePanel} onSaved={upsert} onDeleted={remove} />}
    </div>
  );
}

function NextBadge({ app, today }: { app: JobApplication; today: string }) {
  if (!app.nextDate || CLOSED_STAGES.includes(app.stage)) return null;
  const diff = daysBetween(today, app.nextDate);
  const tone = diff === null ? "neutral" : diff < 0 ? "negative" : diff <= 2 ? "warning" : "neutral";
  return (
    <Badge tone={tone} className="max-w-full">
      <span className="truncate">
        {relativeKstLabel(app.nextDate, today)} · {app.nextStep || formatKstDate(app.nextDate)}
      </span>
    </Badge>
  );
}

function ApplicationCard({
  app,
  today,
  busy,
  onOpen,
  onMove,
}: {
  app: JobApplication;
  today: string;
  busy: boolean;
  onOpen: () => void;
  onMove: (stage: ApplicationStage) => void;
}) {
  return (
    <div className={cn("rounded-lg border border-slate-200 bg-white p-3 shadow-sm transition-colors hover:border-indigo-300", busy && "opacity-60")}>
      <button type="button" onClick={onOpen} className="block w-full min-w-0 text-left focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500/40 rounded">
        <span className="flex items-start gap-1.5">
          <span className="min-w-0 flex-1">
            <span className="block truncate font-semibold text-slate-900">{app.company}</span>
            <span className="mt-0.5 block truncate text-sm text-slate-500">{app.roleTitle}</span>
          </span>
          {app.favorite && (
            <span className="shrink-0 text-amber-500" aria-label="즐겨찾기">
              ★
            </span>
          )}
        </span>
        <span className="mt-2 flex flex-wrap gap-1">
          <span className="lg:hidden">
            <Badge tone={STAGE_TONE[app.stage]}>{APPLICATION_STAGE_LABELS[app.stage]}</Badge>
          </span>
          <NextBadge app={app} today={today} />
          {app.resumeLabel && (
            <Badge tone={app.hasSubmittedCopy ? "accent" : "neutral"} className="max-w-full">
              <span className="truncate">{app.resumeLabel}</span>
            </Badge>
          )}
        </span>
        {app.appliedAt && <span className="mt-1.5 block text-xs text-slate-400">지원 {formatKstDate(app.appliedAt)}</span>}
      </button>
      <label className="mt-2 block">
        <span className="sr-only">{app.company} 단계 바꾸기</span>
        <select
          value={app.stage}
          disabled={busy}
          onChange={(e) => onMove(e.target.value as ApplicationStage)}
          className="block h-8 w-full rounded-md border border-slate-200 bg-slate-50 px-2 text-xs text-slate-700 focus:border-indigo-500 focus:outline-none"
        >
          {APPLICATION_STAGES.map((s) => (
            <option key={s} value={s}>
              {s === app.stage ? `단계: ${APPLICATION_STAGE_LABELS[s]}` : `→ ${APPLICATION_STAGE_LABELS[s]}`}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
