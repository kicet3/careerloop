"use client";

/**
 * 경험 그래프 > 'GitHub에서 가져오기' 창. 1단계: 내 저장소·기여한 저장소 목록(검색·정렬·필터, owner/repo 직접 입력).
 * 2단계: 저장소 요약·경고·AI에 보낼 정보 미리보기 + 이을 프로젝트 고르기(맞는 프로젝트 / 다른 프로젝트 / 새 프로젝트) → 'AI와 정리 시작'.
 * 저장소 글(README 등)은 React 텍스트로만 보인다(HTML·마크다운으로 해석하지 않는다).
 * 연결이 없으면 연결 안내(폼 POST /api/github/connect, 돌아오면 ?github=pick으로 이 창이 다시 열린다), 설정이 없으면 안내만.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { fetchGraph } from "@/components/graph/api";
import { Alert, Badge, Button, Spinner } from "@/components/ui";
import type { ChatMessage, ChatThread } from "@/lib/domain/chat";
import { nodeDisplayName } from "@/lib/domain/graph";
import { type GithubRepoDetailView, type GithubRepoListItem, type GithubStatusView, parseFullName } from "@/lib/github/types";
import { githubApi, GithubClientError, relativeTime } from "./client";

type Sort = "pushed" | "name" | "stars";
type StartResult = { thread: ChatThread; message: ChatMessage; projectNodeId: string; created: boolean };

export function GithubRepoPicker({
  initialFullName,
  initialProjectId,
  provider,
  onClose,
  onStarted,
}: {
  initialFullName?: string;
  initialProjectId?: string;
  provider: string | null;
  onClose: () => void;
  onStarted: (r: StartResult) => void;
}) {
  const [status, setStatus] = useState<GithubStatusView | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(initialFullName ?? null);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    githubApi.status().then(setStatus, (e: Error) => setStatusError(e.message));
  }, []);

  // 부모가 렌더할 때마다 onClose가 새로 만들어져도 포커스를 다시 옮기지 않게 ref로 읽는다.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  // 열 때 한 번만 창에 포커스, Esc로 닫기, Tab은 창 안에서만 돈다, 닫으면 원래 자리(연 버튼)로 포커스를 돌려준다.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onCloseRef.current();
        return;
      }
      const dialog = dialogRef.current;
      if (e.key !== "Tab" || !dialog) return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      const active = document.activeElement;
      if (e.shiftKey && (active === first || active === dialog || !dialog.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      if (opener?.isConnected) opener.focus();
    };
  }, []);

  const ready = status?.configured && status.connected && status.status === "active";

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-slate-900/40 p-4 sm:items-center" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="github-picker-title"
        tabIndex={-1}
        className="flex max-h-[90vh] w-full max-w-2xl flex-col rounded-xl bg-white shadow-xl outline-none"
      >
        <div className="flex items-center gap-2 border-b border-slate-200 px-4 py-3">
          <h2 id="github-picker-title" className="flex-1 text-base font-semibold text-slate-900">
            GitHub에서 프로젝트 가져오기
          </h2>
          <Button size="sm" variant="ghost" onClick={onClose}>
            닫기
          </Button>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-4 py-4">
          {statusError ? (
            <Alert tone="error">{statusError}</Alert>
          ) : !status ? (
            <div className="flex justify-center py-10">
              <Spinner label="GitHub 연결 상태를 확인하는 중" />
            </div>
          ) : !status.configured ? (
            <Alert tone="info" title="관리자가 GitHub 연동을 아직 설정하지 않았습니다">
              설정되면 GitHub 저장소 정보를 읽어 프로젝트 단위로 AI와 정리할 수 있습니다.
            </Alert>
          ) : !ready ? (
            <ConnectPrompt reauth={status.connected} />
          ) : selected ? (
            <RepoStep
              fullName={selected}
              initialProjectId={initialProjectId}
              provider={provider}
              onBack={() => setSelected(null)}
              onStarted={onStarted}
            />
          ) : (
            <ListStep includePrivate={status.includePrivate} onPick={setSelected} />
          )}
        </div>
      </div>
    </div>
  );
}

function ConnectPrompt({ reauth }: { reauth: boolean }) {
  return (
    <div className="space-y-3 text-sm text-slate-700">
      {reauth ? (
        <Alert tone="warning" title="GitHub 연결이 만료되었습니다 — 다시 연결" />
      ) : (
        <p>
          GitHub 계정을 연결하면 내 저장소(기본은 공개 저장소만, 읽기 전용)의 설명·README 앞부분·언어·의존성·내 커밋 메시지를 읽어 프로젝트를
          정리합니다. 저장소 원본은 복제하지 않습니다.
        </p>
      )}
      <form method="post" action="/api/github/connect">
        <input type="hidden" name="next" value="/app/graph?github=pick" />
        <Button type="submit" size="sm">
          {reauth ? "다시 연결" : "GitHub 연결"}
        </Button>
      </form>
    </div>
  );
}

function ListStep({ includePrivate, onPick }: { includePrivate: boolean; onPick: (fullName: string) => void }) {
  const [repos, setRepos] = useState<GithubRepoListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("pushed");
  const [showOwned, setShowOwned] = useState(true);
  const [showContributed, setShowContributed] = useState(true);
  const [showPrivate, setShowPrivate] = useState(true);
  const [manual, setManual] = useState("");
  const [manualError, setManualError] = useState<string | null>(null);

  useEffect(() => {
    githubApi.repos().then(
      (r) => setRepos(r.repos),
      (e: Error) => setError(e.message),
    );
  }, []);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (repos ?? []).filter(
      (r) =>
        (r.source === "owned" ? showOwned : showContributed) &&
        (showPrivate || !r.private) &&
        (!q || r.fullName.toLowerCase().includes(q) || (r.description ?? "").toLowerCase().includes(q)),
    );
    return [...list].sort((a, b) =>
      sort === "name" ? a.fullName.localeCompare(b.fullName) : sort === "stars" ? b.stars - a.stars : (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""),
    );
  }, [repos, query, sort, showOwned, showContributed, showPrivate]);

  function submitManual() {
    const parsed = parseFullName(manual);
    if (!parsed) {
      setManualError("owner/repo 형식으로 입력해 주세요. 예: octocat/hello-world");
      return;
    }
    setManualError(null);
    onPick(`${parsed.owner}/${parsed.repo}`);
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="github-repo-search" className="sr-only">
          저장소 검색
        </label>
        <input
          id="github-repo-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="저장소 검색"
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-sm"
        />
        <label htmlFor="github-repo-sort" className="sr-only">
          정렬
        </label>
        <select id="github-repo-sort" value={sort} onChange={(e) => setSort(e.target.value as Sort)} className="h-8 rounded-lg border border-slate-300 bg-white px-2 text-sm">
          <option value="pushed">최근 반영</option>
          <option value="name">이름</option>
          <option value="stars">별</option>
        </select>
      </div>
      <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-700">
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={showOwned} onChange={(e) => setShowOwned(e.target.checked)} /> 내 저장소
        </label>
        <label className="inline-flex items-center gap-1">
          <input type="checkbox" checked={showContributed} onChange={(e) => setShowContributed(e.target.checked)} /> 기여한 저장소
        </label>
        {includePrivate && (
          <label className="inline-flex items-center gap-1">
            <input type="checkbox" checked={showPrivate} onChange={(e) => setShowPrivate(e.target.checked)} /> 비공개 포함
          </label>
        )}
      </div>
      {error ? (
        <Alert tone="error">{error}</Alert>
      ) : repos === null ? (
        <div className="flex justify-center py-6">
          <Spinner label="저장소 목록을 불러오는 중" />
        </div>
      ) : shown.length === 0 ? (
        <p className="py-4 text-center text-sm text-slate-500">보이는 저장소가 없습니다. 아래에 owner/repo를 직접 입력할 수도 있어요.</p>
      ) : (
        <ul className="max-h-80 divide-y divide-slate-100 overflow-y-auto rounded-lg border border-slate-200">
          {shown.map((r) => (
            <li key={r.id}>
              <button type="button" onClick={() => onPick(r.fullName)} className="w-full px-3 py-2 text-left hover:bg-slate-50 focus:bg-slate-50 focus:outline-none">
                <span className="flex flex-wrap items-center gap-1.5">
                  <span className="text-sm font-medium break-all text-slate-900">{r.fullName}</span>
                  {r.private && <Badge tone="warning">비공개</Badge>}
                  {r.fork && <Badge>포크</Badge>}
                  {r.archived && <Badge>보관됨</Badge>}
                  {r.source === "contributed" && <Badge tone="info">기여</Badge>}
                  {r.linkedProjectId && <Badge tone="positive">이미 연결된 프로젝트</Badge>}
                </span>
                {r.description && <span className="mt-0.5 block text-xs break-words text-slate-600">{r.description}</span>}
                <span className="mt-0.5 block text-xs text-slate-400">
                  {[r.language, `별 ${r.stars}`, r.pushedAt ? `최근 반영 ${relativeTime(Date.parse(r.pushedAt))}` : null].filter(Boolean).join(" · ")}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="flex flex-wrap items-center gap-2 border-t border-slate-100 pt-3"
        onSubmit={(e) => {
          e.preventDefault();
          submitManual();
        }}
      >
        <label htmlFor="github-repo-manual" className="text-xs text-slate-600">
          owner/repo 직접 입력
        </label>
        <input
          id="github-repo-manual"
          value={manual}
          onChange={(e) => setManual(e.target.value)}
          placeholder="octocat/hello-world"
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 px-2 text-sm"
        />
        <Button type="submit" size="sm" variant="secondary" disabled={!manual.trim()}>
          불러오기
        </Button>
        {manualError && <p className="w-full text-xs text-red-600">{manualError}</p>}
      </form>
    </div>
  );
}

function RepoStep({
  fullName,
  initialProjectId,
  provider,
  onBack,
  onStarted,
}: {
  fullName: string;
  initialProjectId?: string;
  provider: string | null;
  onBack: () => void;
  onStarted: (r: StartResult) => void;
}) {
  const [detail, setDetail] = useState<GithubRepoDetailView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [projects, setProjects] = useState<{ id: string; name: string }[]>([]);
  const [choice, setChoice] = useState<string | null>(initialProjectId ?? null);
  const [other, setOther] = useState("");
  const [busy, setBusy] = useState<"sync" | "start" | null>(null);

  useEffect(() => {
    let alive = true;
    githubApi.repo(fullName).then(
      (d) => {
        if (!alive) return;
        setDetail(d);
        setChoice((c) => c ?? d.match?.autoNodeId ?? d.match?.candidates[0]?.nodeId ?? "new");
      },
      (e: Error) => alive && setError(e.message),
    );
    fetchGraph().then(
      (g) => alive && setProjects(g.nodes.filter((n) => n.label === "Project").map((n) => ({ id: n.id, name: nodeDisplayName(n) }))),
      () => {},
    );
    return () => {
      alive = false;
    };
  }, [fullName]);

  async function sync() {
    setBusy("sync");
    setError(null);
    try {
      setDetail(await githubApi.sync(fullName));
    } catch (e) {
      setError(e instanceof GithubClientError ? e.message : "다시 읽지 못했습니다.");
    }
    setBusy(null);
  }

  const projectNodeId = choice === "other" ? other : choice;

  async function start() {
    if (!projectNodeId) return;
    setBusy("start");
    setError(null);
    try {
      onStarted(await githubApi.startImport({ fullName: detail?.repo.fullName ?? fullName, projectNodeId, provider }));
    } catch (e) {
      setError(e instanceof GithubClientError ? e.message : "시작하지 못했습니다.");
      setBusy(null);
    }
  }

  const candidates = detail?.match?.candidates ?? [];
  const candidateIds = new Set(candidates.map((c) => c.nodeId));
  // 처음 고른 프로젝트(프로젝트 상세에서 열었을 때)가 후보에 없으면 그 프로젝트도 보이게 한다.
  const preset = initialProjectId && !candidateIds.has(initialProjectId) ? projects.find((p) => p.id === initialProjectId) : undefined;

  return (
    <div className="space-y-4">
      <button type="button" onClick={onBack} className="text-xs text-slate-600 underline underline-offset-2">
        ← 저장소 목록
      </button>
      {error && <Alert tone="error">{error}</Alert>}
      {!detail ? (
        !error && (
          <div className="flex justify-center py-8">
            <Spinner label="저장소 정보를 읽는 중(최대 30초)" />
          </div>
        )
      ) : (
        <>
          <div className="space-y-1">
            <p className="flex flex-wrap items-center gap-1.5">
              <a href={detail.repo.htmlUrl} target="_blank" rel="noreferrer" className="text-sm font-semibold break-all text-indigo-700 underline underline-offset-2">
                {detail.repo.fullName}
              </a>
              {detail.repo.private && <Badge tone="warning">비공개 — AI에 보내집니다</Badge>}
              {detail.repo.fork && <Badge>포크</Badge>}
            </p>
            {detail.repo.description && <p className="text-sm break-words text-slate-700">{detail.repo.description}</p>}
            <p className="text-xs text-slate-500">
              {[
                detail.repo.language,
                `별 ${detail.repo.stars}`,
                detail.myCommits !== null ? `내 커밋 ${detail.myCommits}회` : null,
                `정보 읽은 시각 ${relativeTime(detail.repo.fetchedAt)}`,
              ]
                .filter(Boolean)
                .join(" · ")}{" "}
              <button type="button" className="underline" onClick={sync} disabled={busy !== null}>
                {busy === "sync" ? "다시 읽는 중…" : "다시 동기화"}
              </button>
            </p>
          </div>
          {detail.warnings.length > 0 && (
            <Alert tone="warning">
              <ul className="list-disc pl-4">
                {detail.warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </ul>
            </Alert>
          )}
          <details className="rounded-lg border border-slate-200">
            <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-slate-600">
              AI에 보낼 저장소 정보 미리보기({detail.briefChars.toLocaleString()}자)
            </summary>
            <pre className="max-h-60 overflow-auto px-3 pb-3 text-xs whitespace-pre-wrap break-words text-slate-700">{detail.briefPreview}</pre>
          </details>
          <fieldset className="space-y-1.5">
            <legend className="mb-1 text-sm font-medium text-slate-800">어느 프로젝트에 정리할까요?</legend>
            {detail.match === null && <p className="text-xs text-slate-500">경험 그래프를 읽지 못해 후보를 찾지 못했습니다.</p>}
            {[...candidates.map((c) => ({ id: c.nodeId, name: c.name, note: c.reason })), ...(preset ? [{ id: preset.id, name: preset.name, note: "고른 프로젝트" }] : [])].map(
              (c) => (
                <label key={c.id} className="flex items-start gap-2 text-sm text-slate-800">
                  <input type="radio" name="github-project" className="mt-1" checked={choice === c.id} onChange={() => setChoice(c.id)} />
                  <span>
                    {c.name} <span className="text-xs text-slate-500">({c.note})</span>
                  </span>
                </label>
              ),
            )}
            {projects.length > 0 && (
              <label className="flex flex-wrap items-center gap-2 text-sm text-slate-800">
                <input type="radio" name="github-project" checked={choice === "other"} onChange={() => setChoice("other")} />
                <span>다른 프로젝트</span>
                <select
                  aria-label="다른 프로젝트 고르기"
                  value={other}
                  onChange={(e) => {
                    setOther(e.target.value);
                    setChoice("other");
                  }}
                  className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm"
                >
                  <option value="">고르기</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="flex items-center gap-2 text-sm text-slate-800">
              <input type="radio" name="github-project" checked={choice === "new"} onChange={() => setChoice("new")} />
              <span>새 프로젝트로 만들기</span>
            </label>
          </fieldset>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <p className="mr-auto text-xs text-slate-500">AI가 변경안과 후속 질문을 만들고, 확인한 것만 경험 그래프에 적용됩니다.</p>
            <Button onClick={start} loading={busy === "start"} disabled={!projectNodeId || busy !== null}>
              AI와 정리 시작
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
