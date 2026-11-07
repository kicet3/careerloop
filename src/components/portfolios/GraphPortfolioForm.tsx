"use client";
/**
 * 경험 그래프로 포트폴리오 만들기(또는 다시 만들기) 폼. 내 경험 그래프의 프로젝트 목록을 불러와(GET /api/portfolios/graph) 넣을 프로젝트를 고르고,
 * 강조할 공고(공고 보관함)·이름·메모·AI 엔진을 정해 POST /api/portfolios/graph로 작업을 시작한다. 시작하면 진행 화면으로 옮긴다.
 * 그래프 저장소가 없거나 프로젝트가 없으면 경험 그래프 화면으로 안내한다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { inputClass, textareaClass } from "@/components/resumes/styles";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClass } from "@/components/ui/Button";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import {
  defaultProjectSelection,
  MAX_GRAPH_PORTFOLIO_NOTES_CHARS,
  MAX_GRAPH_PORTFOLIO_PROJECTS,
  type GraphPortfolioJobView,
  type GraphProjectOption,
} from "@/lib/domain/graph-portfolio";
import { MAX_PORTFOLIO_TITLE_CHARS } from "@/lib/domain/portfolios";
import { NO_ENGINE_MESSAGE, PROVIDER_DATA_DESTINATION, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { NETWORK_ERROR, readError } from "./api";

export interface GraphPostingOption {
  id: string;
  company: string;
  roleTitle: string;
}

/** 다시 만들기: 대상 포트폴리오와 지난번 선택. */
export interface GraphPortfolioRegenerate {
  portfolioId: string;
  title: string;
  projectIds: string[];
  postingId: string | null;
  notes: string;
}

type Load = { state: "loading" } | { state: "error"; message: string } | { state: "ready"; enabled: boolean; projects: GraphProjectOption[] };

export function GraphPortfolioForm({
  postings,
  providers,
  defaultProvider,
  regenerate,
  onCancel,
}: {
  postings: GraphPostingOption[];
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
  regenerate?: GraphPortfolioRegenerate;
  onCancel?: () => void;
}) {
  const router = useRouter();
  const [load, setLoad] = useState<Load>({ state: "loading" });
  const [selected, setSelected] = useState<string[]>([]);
  const [postingId, setPostingId] = useState(regenerate?.postingId ?? "");
  const [title, setTitle] = useState("");
  const [notes, setNotes] = useState(regenerate?.notes ?? "");
  const [provider, setProvider] = useState<ProviderId | null>(defaultProvider);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);
  const previousKey = regenerate?.projectIds.join(",") ?? "";

  useEffect(() => {
    let stopped = false;
    (async () => {
      try {
        const res = await fetch("/api/portfolios/graph", { cache: "no-store" });
        if (!res.ok) {
          if (!stopped) setLoad({ state: "error", message: await readError(res, "경험 그래프를 불러오지 못했습니다.") });
          return;
        }
        const data = (await res.json()) as { enabled: boolean; projects: GraphProjectOption[] };
        if (stopped) return;
        setLoad({ state: "ready", enabled: data.enabled, projects: data.projects });
        const ids = new Set(data.projects.map((p) => p.id));
        const previous = previousKey ? previousKey.split(",").filter((id) => ids.has(id)) : [];
        setSelected(previous.length > 0 ? previous : defaultProjectSelection(data.projects));
      } catch {
        if (!stopped) setLoad({ state: "error", message: NETWORK_ERROR });
      }
    })();
    return () => {
      stopped = true;
    };
  }, [previousKey, reloadKey]);

  const projects = useMemo(() => (load.state === "ready" ? load.projects : []), [load]);
  const order = useMemo(() => new Map(projects.map((p, i) => [p.id, i])), [projects]);
  const selectedProvider = providers.find((p) => p.id === provider);
  const destination = provider ? PROVIDER_DATA_DESTINATION[provider] : null;
  const missingPosting = !!regenerate?.postingId && !postings.some((p) => p.id === regenerate.postingId);

  function toggle(id: string) {
    setError(null);
    setSelected((cur) => {
      if (cur.includes(id)) return cur.filter((x) => x !== id);
      if (cur.length >= MAX_GRAPH_PORTFOLIO_PROJECTS) {
        setError(`프로젝트는 한 번에 ${MAX_GRAPH_PORTFOLIO_PROJECTS}개까지 고를 수 있습니다.`);
        return cur;
      }
      return [...cur, id].sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
    });
  }

  async function submit() {
    setError(null);
    if (selected.length === 0) {
      setError("포트폴리오에 넣을 프로젝트를 하나 이상 골라 주세요.");
      return;
    }
    if (!provider || !selectedProvider?.ready) {
      setError(selectedProvider?.reason ?? (providers.some((p) => p.ready) ? "사용할 AI 엔진을 골라 주세요." : NO_ENGINE_MESSAGE));
      return;
    }
    setBusy(true);
    try {
      const res = await fetch("/api/portfolios/graph", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectIds: selected,
          postingId: postingId && !(missingPosting && postingId === regenerate?.postingId) ? postingId : null,
          ...(!regenerate && title.trim() ? { title: title.trim() } : {}),
          ...(notes.trim() ? { notes: notes.trim() } : {}),
          provider,
          ...(regenerate ? { portfolioId: regenerate.portfolioId } : {}),
        }),
      });
      if (!res.ok) {
        setError(await readError(res, "포트폴리오 만들기를 시작하지 못했습니다."));
        setBusy(false);
        return;
      }
      const { job } = (await res.json()) as { job: GraphPortfolioJobView };
      router.push(`/app/portfolios/drafts/${encodeURIComponent(job.id)}`);
    } catch {
      setError(NETWORK_ERROR);
      setBusy(false);
    }
  }

  if (load.state === "loading") {
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500" role="status">
        <Spinner size="sm" /> 경험 그래프의 프로젝트를 불러오는 중…
      </p>
    );
  }
  if (load.state === "error") {
    return (
      <Alert tone="error" title="경험 그래프를 불러오지 못했습니다">
        <p>{load.message}</p>
        <Button size="sm" variant="secondary" className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>
          다시 불러오기
        </Button>
      </Alert>
    );
  }
  if (!load.enabled) {
    return (
      <Alert tone="warning" title="경험 그래프를 쓸 수 없습니다">
        이 서버에는 경험 그래프 저장소(Neo4j)가 설정되지 않아 그래프로 포트폴리오를 만들 수 없습니다. 파일이나 링크로 추가해 주세요.
      </Alert>
    );
  }
  if (projects.length === 0) {
    return (
      <Alert tone="info" title="경험 그래프에 프로젝트가 없습니다">
        <p>포트폴리오는 경험 그래프의 프로젝트로 만듭니다. 먼저 채팅·이력서 가져오기·GitHub 연결로 프로젝트를 정리해 주세요.</p>
        <Link href="/app/graph" className={cn(buttonClass("primary", "sm"), "mt-3")}>
          경험 그래프로 가기
        </Link>
      </Alert>
    );
  }

  return (
    <div className="space-y-4">
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">
          넣을 프로젝트{" "}
          <span className="font-normal text-slate-500">
            ({selected.length}/{Math.min(projects.length, MAX_GRAPH_PORTFOLIO_PROJECTS)}개 · 구조화가 잘 된 프로젝트를 먼저 골라 두었습니다)
          </span>
        </legend>
        <ul className="mt-2 grid max-h-80 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
          {projects.map((p) => {
            const on = selected.includes(p.id);
            return (
              <li key={p.id}>
                <label
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border px-3 py-2.5 text-sm",
                    on ? "border-indigo-400 bg-indigo-50/60" : "border-slate-200 hover:border-slate-300",
                  )}
                >
                  <input type="checkbox" checked={on} onChange={() => toggle(p.id)} className="mt-0.5 accent-indigo-600" />
                  <span className="min-w-0">
                    <span className="block truncate font-medium text-slate-900">{p.name}</span>
                    {p.summary && <span className="line-clamp-2 block text-xs text-slate-500">{p.summary}</span>}
                    <span className="mt-1 flex flex-wrap gap-x-2 text-xs text-slate-500">
                      {p.period && <span>{p.period}</span>}
                      <span className={p.done >= 5 ? "text-emerald-700" : p.done >= 3 ? "text-slate-600" : "text-amber-700"}>
                        구조화 {p.done}/{p.total}
                      </span>
                      {p.skills > 0 && <span>기술 {p.skills}</span>}
                      {p.hasMetric && <span className="text-emerald-700">수치 성과</span>}
                    </span>
                  </span>
                </label>
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          구조화가 덜 된 프로젝트는 빈칸이 <strong>[ADD: …]</strong>로 남습니다.{" "}
          <Link href="/app/graph" className="font-medium text-indigo-700 hover:underline">
            경험 그래프
          </Link>
          에서 프로젝트를 채우면 더 충실해집니다.
        </p>
      </fieldset>

      <label className="block">
        <span className="block text-sm font-medium text-slate-800">
          강조할 공고 <span className="font-normal text-slate-400">(선택 — 공고 요건과 관련된 경험을 앞에 둡니다)</span>
        </span>
        <select value={postingId} onChange={(e) => setPostingId(e.target.value)} className={inputClass}>
          <option value="">공고 없이</option>
          {missingPosting && regenerate?.postingId && <option value={regenerate.postingId}>(지워진 공고 — 공고 없이 만듭니다)</option>}
          {postings.map((p) => (
            <option key={p.id} value={p.id}>
              {p.company} · {p.roleTitle}
            </option>
          ))}
        </select>
      </label>

      {/* 다시 만들기는 본문만 바꾼다 — 이름은 보관함의 이름 그대로(본문 제목도 그 이름). 이름은 포트폴리오 화면의 '고치기'에서 바꾼다. */}
      {!regenerate && (
        <label className="block">
          <span className="block text-sm font-medium text-slate-800">
            이름 <span className="font-normal text-slate-400">(비우면 &lsquo;경험 그래프 포트폴리오&rsquo;)</span>
          </span>
          <input
            value={title}
            maxLength={MAX_PORTFOLIO_TITLE_CHARS}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="예: 백엔드 개발자 포트폴리오"
            className={inputClass}
          />
        </label>
      )}

      <label className="block">
        <span className="block text-sm font-medium text-slate-800">
          강조점·톤 메모 <span className="font-normal text-slate-400">(선택)</span>
        </span>
        <textarea
          value={notes}
          maxLength={MAX_GRAPH_PORTFOLIO_NOTES_CHARS}
          onChange={(e) => setNotes(e.target.value)}
          rows={3}
          placeholder="예: 성능 개선 경험을 강조하고 간결한 문체로. (메모는 강조점으로만 쓰고 사실로 넣지 않습니다)"
          className={textareaClass}
        />
      </label>

      {providers.length > 1 && (
        <fieldset>
          <legend className="text-sm font-medium text-slate-800">AI 엔진</legend>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {providers.map((p) => (
              <label
                key={p.id}
                className={cn(
                  "flex items-start gap-3 rounded-lg border border-slate-200 px-3 py-2 has-[:checked]:border-indigo-500 has-[:checked]:bg-indigo-50/60",
                  p.ready ? "cursor-pointer" : "cursor-not-allowed opacity-60",
                )}
              >
                <input
                  type="radio"
                  name="graph-portfolio-provider"
                  value={p.id}
                  checked={provider === p.id}
                  disabled={!p.ready}
                  onChange={() => setProvider(p.id)}
                  className="mt-1 accent-indigo-600"
                />
                <span className="min-w-0">
                  <span className="block text-sm font-medium text-slate-900">{p.label}</span>
                  <span className="block text-xs text-slate-500">{p.ready ? (p.account ? `${p.account} · ${p.description}` : p.description) : p.reason}</span>
                </span>
              </label>
            ))}
          </div>
        </fieldset>
      )}

      <Alert tone="info">
        {destination ? `고른 프로젝트의 경험 그래프${postingId ? "와 공고 JD" : ""}가 ${destination}(으)로 전송됩니다. ` : ""}
        AI는 그래프에 있는 사실만 쓰고, 없는 내용은 <strong>[ADD: …]</strong>로 남깁니다. 그래프에 없는 수치는 저장 전에 확인 표시로 바꿉니다.
        {regenerate && " 다시 만들면 지금 본문(직접 고친 내용 포함)이 새 본문으로 바뀝니다."}
      </Alert>

      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <p className="mr-auto text-xs text-slate-500">보통 1~5분 걸립니다. 진행 화면을 떠나도 계속 쓰고, 끝나면 알림으로 알려 드립니다.</p>
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            취소
          </Button>
        )}
        <Button size="sm" onClick={() => void submit()} loading={busy} disabled={busy || selected.length === 0}>
          {regenerate ? "다시 만들기" : "포트폴리오 만들기"}
        </Button>
      </div>
    </div>
  );
}
