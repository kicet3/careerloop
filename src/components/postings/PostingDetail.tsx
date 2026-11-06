"use client";
/**
 * 공고 상세: 핵심 정보 그리드, 구역 카드(포지션 개요·주요 업무·자격 요건·우대 사항·기술 스택·근무 조건·복지·채용 절차·
 * 제출 서류/지원 방법·회사 소개·기타), 원문(접힘), 메모, 메타·상태 편집, 구역 편집·AI로 다시 정리,
 * 다음 행동(이 공고로 진단 · 이 공고용 이력서 · 지원 기록 추가), 이 공고로 만든 진단·이력서·지원 기록.
 * '내 경력과 대조' 카드는 페이지가 matchCard로 넣는다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import { DIAGNOSIS_STATUS_VIEW, formatDateTime } from "@/components/app/stages";
import { Alert } from "@/components/ui/Alert";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { APPLICATION_STAGE_LABELS, type JobApplication } from "@/lib/domain/applications";
import { STRUCTURE_SOURCE_LABELS, type StructureSource } from "@/lib/domain/posting-structure";
import {
  isPostingImportActive,
  POSTING_IMPORT_STATUS_LABELS,
  POSTING_STATUS_LABELS,
  POSTING_STATUSES,
  type JobPosting,
  type PostingStatus,
} from "@/lib/domain/postings";
import type { DiagnosisStatus } from "@/lib/domain/schemas";
import { detectPostingMilitaryService } from "@/lib/postings/military-service";
import { hasStructureContent, isStructureStale, postingJdForPrompt } from "@/lib/postings/structure";
import { platformLabel } from "@/lib/postings/url";
import { saveDiagnosisPrefill } from "@/lib/resumes/prefill";
import { formatKstDate } from "@/lib/time/kst";
import { PostingCaptureButton } from "./PostingCapture";
import { PostingForm } from "./PostingForm";
import { MilitaryServiceBadges } from "./MilitaryServiceBadges";
import { KeyFacts, PostingSections } from "./PostingSections";
import { PostingSectionsEditor } from "./PostingSectionsEditor";
import { usePostingImports } from "./import-jobs";
import { inputClass, PostingStatusBadge, readApiError, useNow } from "./shared";
import { SourceLink } from "./SourceLink";

export interface PostingLinksView {
  diagnoses: { id: string; title: string; status: string; createdAt: number }[];
  resumes: { id: string; title: string; company: string; roleTitle: string; updatedAt: number }[];
}

const SOURCE_TONES: Record<StructureSource, BadgeTone> = { llm: "info", regex: "neutral", user: "accent" };

export function PostingDetail({
  posting: initial,
  links,
  serverNow,
  matchCard,
  aiAvailable = false,
  autoStructure = false,
  sharedVisible = true,
}: {
  posting: JobPosting;
  links: PostingLinksView;
  serverNow: number;
  matchCard?: React.ReactNode;
  /** AI 엔진을 쓸 수 있는가('AI로 다시 정리'·폼의 'AI로 섹션 정리'). */
  aiAvailable?: boolean;
  /** 열리자마자 AI로 구역을 정리한다(직접 추가 직후). */
  autoStructure?: boolean;
  /** 연결된 공용 공고를 공고 찾기에서 열 수 있는가(관리자가 숨겼으면 false). */
  sharedVisible?: boolean;
}) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [posting, setPosting] = useState(initial);
  // 원문 캡처는 URL로 만든 공용 공고에만 있다(직접 입력 공용 공고는 capture 없음). 수정 응답에는 capture가 실리지 않으므로 처음 값으로 정한다.
  const [capturable] = useState(() => !!initial.capture);
  const [editing, setEditing] = useState<"meta" | "sections" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"status" | "delete" | null>(null);
  const [structuring, setStructuring] = useState(false);
  const [structureError, setStructureError] = useState<string | null>(null);

  const restructure = useCallback(async () => {
    setStructureError(null);
    setStructuring(true);
    try {
      const res = await fetch(`/api/postings/${initial.id}/structure`, { method: "POST" });
      if (!res.ok) setStructureError((await readApiError(res, "AI로 구역을 정리하지 못했습니다.")).error);
      else setPosting(((await res.json()) as { posting: JobPosting }).posting);
    } catch {
      setStructureError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setStructuring(false);
    }
  }, [initial.id]);

  // '다시 가져오기'(링크로 가져온 공고): 페이지를 다시 읽어 공용 공고와 이 공고를 최신 내용으로 맞춘다(상태·메모는 그대로).
  const imports = usePostingImports({
    onCompleted: async (job) => {
      try {
        const res = await fetch(`/api/postings/${encodeURIComponent(job.postingId ?? initial.id)}`, { cache: "no-store" });
        if (res.ok) setPosting(((await res.json()) as { posting: JobPosting }).posting);
      } catch {
        // 새로고침하면 보인다.
      }
    },
  });
  const refetchJob = imports.jobs[0];
  const refetching = !!refetchJob && isPostingImportActive(refetchJob.status);
  async function refetch() {
    if (!window.confirm("공고 페이지를 다시 읽어 최신 내용으로 바꿀까요? 하루 가져오기 횟수 1회를 쓰고, 직접 고친 구역·JD는 새 내용으로 바뀝니다(상태·메모는 그대로).")) return;
    setError(null);
    const result = await imports.start(posting.url, { refresh: true });
    if (!result.ok) setError(result.error.error);
  }

  // 직접 추가 직후(?structure=1): 한 번만 정리를 시작하고 주소에서 표시를 지운다(새로고침해도 다시 돌지 않게).
  const autoStarted = useRef(false);
  useEffect(() => {
    if (!autoStructure || autoStarted.current) return;
    autoStarted.current = true;
    router.replace(`/app/postings/${initial.id}`, { scroll: false });
    const timer = setTimeout(() => void restructure(), 0);
    return () => clearTimeout(timer);
  }, [autoStructure, initial.id, restructure, router]);

  async function changeStatus(status: PostingStatus) {
    setError(null);
    setBusy("status");
    try {
      const res = await fetch(`/api/postings/${posting.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ status }),
      });
      if (!res.ok) setError((await readApiError(res, "상태를 바꾸지 못했습니다.")).error);
      else setPosting(((await res.json()) as { posting: JobPosting }).posting);
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setBusy(null);
    }
  }

  async function onDelete() {
    if (!window.confirm("이 공고를 지울까요? 이 공고로 만든 진단·이력서·지원 기록은 남고 공고 연결만 끊깁니다.")) return;
    setError(null);
    setBusy("delete");
    try {
      const res = await fetch(`/api/postings/${posting.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        setError((await readApiError(res, "공고를 지우지 못했습니다.")).error);
        setBusy(null);
        return;
      }
      router.push("/app/postings");
      router.refresh();
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
      setBusy(null);
    }
  }

  function startDiagnosis() {
    // 이력서는 진단 화면에서 넣는다. 직무·JD·공고 id만 넘긴다(URL에 JD를 싣지 않는다).
    saveDiagnosisPrefill({
      resumeText: "",
      targetRole: posting.roleTitle,
      jdText: postingJdForPrompt(posting),
      postingId: posting.id,
      postingLabel: `${posting.company} · ${posting.roleTitle}`,
    });
    router.push("/app/new");
  }

  const structure = posting.structured;
  const salary = structure?.conditions.salary ?? "";
  const rawText = posting.sourceText || posting.jdText;
  const hasSections = !!structure && hasStructureContent(structure);
  const stale = isStructureStale(posting);
  // URL로 가져온 공고의 jdText를 사용자가 고친 상태(구조로 조합되지 않음): 고친 JD를 원문과 따로 보여 준다.
  const editedJd = !!posting.sourceText && !!structure && !structure.jdComposed && !!posting.jdText.trim() && posting.jdText !== posting.sourceText ? posting.jdText : "";
  // 구역 편집 중에는 AI 정리를 막는다(편집기가 이전 구조로 저장해 새 결과를 덮어쓰지 않게).
  const editingSections = editing === "sections";
  const canRestructure = aiAvailable && !structuring && !editingSections;
  const meta: [string, string][] = [
    ["출처", posting.platform ? platformLabel(posting.platform) : posting.url ? "링크" : "직접 입력"],
    ["추가 방식", posting.extractedBy === "manual" ? "직접 입력" : "링크에서 AI 정리"],
    ["최근 수정", formatDateTime(posting.updatedAt)],
  ];

  return (
    <div className="space-y-6">
      <Link href="/app/postings" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 공고 보관함
      </Link>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-500">{posting.company}</p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight break-words text-slate-900">{posting.roleTitle}</h1>
          <MilitaryServiceBadges
            tags={detectPostingMilitaryService({ roleTitle: posting.roleTitle, jdText: posting.jdText, structured: posting.structured })}
            className="mt-2"
          />
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PostingStatusBadge status={posting.status} />
            <SourceLink url={posting.url} className="max-w-full" />
            {posting.sharedPostingId && capturable && (
              <PostingCaptureButton
                key={posting.capture?.capturedAt ?? posting.capture?.status ?? "none"}
                apiBase={`/api/postings/${encodeURIComponent(posting.id)}`}
                initial={posting.capture}
                sourceUrl={posting.url}
                title={`${posting.company} · ${posting.roleTitle}`}
              />
            )}
            {posting.url && posting.extractedBy !== "manual" && (
              <button
                type="button"
                onClick={() => void refetch()}
                disabled={refetching || busy !== null}
                className="text-sm font-medium text-indigo-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50"
              >
                다시 가져오기
              </button>
            )}
            {posting.sharedPostingId && sharedVisible && (
              <Link href={`/app/postings/explore/${posting.sharedPostingId}`} className="text-sm text-slate-500 hover:text-slate-800 hover:underline">
                공고 찾기에서 보기
              </Link>
            )}
          </div>
        </div>
        <div className="flex w-full flex-wrap gap-2 sm:w-auto">
          <label htmlFor="posting-status-select" className="sr-only">
            공고 상태
          </label>
          <select
            id="posting-status-select"
            value={posting.status}
            disabled={busy !== null}
            onChange={(e) => void changeStatus(e.target.value as PostingStatus)}
            className={cn(inputClass, "mt-0 h-10 w-auto py-0")}
          >
            {POSTING_STATUSES.map((s) => (
              <option key={s} value={s}>
                {POSTING_STATUS_LABELS[s]}
              </option>
            ))}
          </select>
          <Button variant="secondary" onClick={() => setEditing((e) => (e === "meta" ? null : "meta"))} aria-expanded={editing === "meta"}>
            {editing === "meta" ? "수정 닫기" : "수정"}
          </Button>
          <Button variant="danger" onClick={() => void onDelete()} loading={busy === "delete"}>
            삭제
          </Button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}
      {refetchJob && (
        <div
          className={cn(
            "flex items-center gap-2 rounded-lg border px-3 py-2 text-sm",
            refetchJob.status === "failed" ? "border-red-200 bg-red-50 text-red-800" : "border-indigo-200 bg-indigo-50 text-indigo-800",
          )}
          role="status"
        >
          {refetching && <Spinner size="sm" />}
          다시 가져오기: {POSTING_IMPORT_STATUS_LABELS[refetchJob.status]}
          {refetchJob.status === "completed" && " — 최신 내용으로 바꿨습니다."}
          {refetchJob.error && ` — ${refetchJob.error}`}
        </div>
      )}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button onClick={startDiagnosis}>이 공고로 진단</Button>
        <Link href={`/app/resumes/new?postingId=${encodeURIComponent(posting.id)}`} className={buttonClass("secondary", "md")}>
          이 공고용 이력서
        </Link>
        <Link href={`/app/applications?new=1&postingId=${encodeURIComponent(posting.id)}`} className={buttonClass("secondary", "md")}>
          지원 기록 추가
        </Link>
      </div>

      {editing === "meta" && (
        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-base font-semibold text-slate-900">공고 수정</h2>
          <PostingForm
            posting={posting}
            aiAvailable={aiAvailable}
            onCancel={() => setEditing(null)}
            onSaved={(p, opts) => {
              setPosting(p);
              setEditing(null);
              if (opts.structure) void restructure();
            }}
          />
        </Card>
      )}

      <Card>
        <CardHeader title="핵심 정보" />
        <CardBody>
          <KeyFacts posting={posting} salary={salary} now={now} />
        </CardBody>
      </Card>

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
        <div className="min-w-0 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <h2 className="text-base font-semibold text-slate-900">공고 내용</h2>
              {structure && hasSections && <Badge tone={SOURCE_TONES[structure.source]}>{STRUCTURE_SOURCE_LABELS[structure.source]}</Badge>}
            </div>
            {rawText.trim() && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => void restructure()}
                  disabled={!canRestructure}
                  loading={structuring}
                  title={!aiAvailable ? "AI 엔진을 연결하면 쓸 수 있습니다." : editingSections ? "구역 편집을 닫은 뒤 쓸 수 있습니다." : undefined}
                >
                  AI로 다시 정리
                </Button>
                {structure && (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => setEditing((e) => (e === "sections" ? null : "sections"))}
                    aria-expanded={editing === "sections"}
                    disabled={structuring}
                  >
                    {editing === "sections" ? "편집 닫기" : "구역 편집"}
                  </Button>
                )}
              </div>
            )}
          </div>
          {structuring && (
            <div className="flex items-center gap-2 rounded-lg border border-indigo-200 bg-indigo-50 px-3 py-2 text-sm text-indigo-800" role="status">
              <Spinner size="sm" /> AI가 공고 원문을 구역별로 정리하고 있습니다…
            </div>
          )}
          {structureError && <Alert tone="error">{structureError}</Alert>}
          {stale && !structuring && (
            <Alert tone="warning">
              원문이 바뀌었습니다. 구역 내용이 이전 원문 기준입니다.{" "}
              {aiAvailable ? (
                <button
                  type="button"
                  className="font-medium underline disabled:cursor-not-allowed disabled:opacity-50"
                  onClick={() => void restructure()}
                  disabled={!canRestructure}
                >
                  다시 정리
                </button>
              ) : (
                "구역 편집으로 고쳐 주세요."
              )}
            </Alert>
          )}
          {structure?.translatedFrom && (
            <p className="text-xs text-slate-500" data-testid="posting-translated-hint">
              {structure.translatedFrom === "en" ? "영문" : "외국어"} 공고를 한국어로 옮겨 저장했습니다.
              {posting.sourceText ? " 아래 '원문 보기'에서 원래 공고를 확인할 수 있습니다." : ""}
            </p>
          )}
          {structure?.source === "llm" && hasSections && (
            <p className="text-xs text-slate-500">AI가 원문 문구를 구역별로 옮겼습니다. 지원 전에 원문에서 조건과 마감 시각을 확인하세요.</p>
          )}

          {editing === "sections" && structure ? (
            <Card className="p-5 sm:p-6">
              <h2 className="mb-4 text-base font-semibold text-slate-900">구역 편집</h2>
              <PostingSectionsEditor
                key={structure.extractedAt}
                postingId={posting.id}
                structure={structure}
                onCancel={() => setEditing(null)}
                onSaved={(p) => {
                  setPosting(p);
                  setEditing(null);
                }}
              />
            </Card>
          ) : hasSections && structure ? (
            <PostingSections structure={structure} aiSummary={structure.source === "llm"} />
          ) : rawText.trim() ? (
            <Card>
              <CardBody>
                <p className="text-sm text-slate-500">
                  자격 요건·우대 사항 같은 구역 제목을 찾지 못했습니다. {aiAvailable ? "'AI로 다시 정리'로 구역을 나눠 보세요." : "아래 원문을 확인하세요."}
                </p>
              </CardBody>
            </Card>
          ) : (
            <Card>
              <CardHeader title="JD" />
              <CardBody>
                <p className="text-sm text-slate-500">JD 원문이 없습니다. 공고의 업무·자격 요건을 붙여넣으면 진단과 경력 대조가 정확해집니다.</p>
                <Button variant="secondary" size="sm" className="mt-3" onClick={() => setEditing("meta")}>
                  JD 붙여넣기
                </Button>
              </CardBody>
            </Card>
          )}

          {editedJd && <TextBlock title="JD(수정본)" text={editedJd} defaultOpen={stale} />}
          {rawText.trim() && (
            <TextBlock title={posting.sourceText ? (structure?.translatedFrom ? "원문 보기(번역 전)" : "가져온 원문") : "JD 원문"} text={rawText} defaultOpen={!hasSections && editing !== "sections"} />
          )}
        </div>
        <div className="min-w-0 space-y-6">
          {posting.note && (
            <Card>
              <CardHeader title="메모" />
              <CardBody className="pt-3">
                <p className="text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800">{posting.note}</p>
              </CardBody>
            </Card>
          )}
          {matchCard}
          <Card>
            <CardBody>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-3">
                {meta.map(([k, v]) => (
                  <div key={k} className="flex gap-3 sm:block">
                    <dt className="w-20 shrink-0 text-slate-500 sm:w-auto">{k}</dt>
                    <dd className="min-w-0 font-medium break-words text-slate-900 sm:mt-0.5">{v}</dd>
                  </div>
                ))}
              </dl>
            </CardBody>
          </Card>
          <RelatedCard postingId={posting.id} links={links} />
        </div>
      </div>
    </div>
  );
}

function RelatedCard({ postingId, links }: { postingId: string; links: PostingLinksView }) {
  const [apps, setApps] = useState<JobApplication[] | null>(null);
  const [appsError, setAppsError] = useState(false);
  useEffect(() => {
    let cancelled = false;
    fetch(`/api/applications?postingId=${encodeURIComponent(postingId)}`, { cache: "no-store" })
      .then(async (res) => {
        if (!res.ok) throw new Error(String(res.status));
        const data = (await res.json()) as { items?: JobApplication[] };
        if (!cancelled) setApps(data.items ?? []);
      })
      .catch(() => {
        if (!cancelled) setAppsError(true);
      });
    return () => {
      cancelled = true;
    };
  }, [postingId]);

  return (
    <Card>
      <CardHeader title="이 공고로 한 일" description="이 공고로 만든 진단·이력서와 지원 기록입니다." />
      <CardBody className="space-y-5">
        <RelatedList title="지원 기록" empty={appsError ? "지원 기록을 불러오지 못했습니다." : apps === null ? "불러오는 중…" : "아직 없습니다."}>
          {apps?.map((a) => (
            <li key={a.id}>
              <Link href="/app/applications" className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                <span className="min-w-0 truncate text-slate-800">
                  {a.appliedAt ? `${formatKstDate(a.appliedAt)} 지원` : "지원 전"}
                  {a.resumeLabel && <span className="text-slate-500"> · {a.resumeLabel}</span>}
                </span>
                <Badge tone="accent">{APPLICATION_STAGE_LABELS[a.stage]}</Badge>
              </Link>
            </li>
          ))}
        </RelatedList>
        <RelatedList title="진단" empty="아직 없습니다.">
          {links.diagnoses.map((d) => {
            const view = DIAGNOSIS_STATUS_VIEW[d.status as DiagnosisStatus];
            return (
              <li key={d.id}>
                <Link href={`/app/d/${d.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                  <span className="min-w-0 truncate text-slate-800">{d.title}</span>
                  {view && <Badge tone={view.tone}>{view.label}</Badge>}
                </Link>
              </li>
            );
          })}
        </RelatedList>
        <RelatedList title="이력서" empty="아직 없습니다.">
          {links.resumes.map((r) => (
            <li key={r.id}>
              <Link href={`/app/resumes/${r.id}`} className="flex flex-wrap items-center justify-between gap-2 rounded-lg px-2 py-1.5 hover:bg-slate-50">
                <span className="min-w-0 truncate text-slate-800">{r.title}</span>
                <span className="text-xs text-slate-500">{formatDateTime(r.updatedAt)}</span>
              </Link>
            </li>
          ))}
        </RelatedList>
      </CardBody>
    </Card>
  );
}

function RelatedList({ title, empty, children }: { title: string; empty: string; children: React.ReactNode }) {
  const items = Array.isArray(children) ? children.filter(Boolean) : children ? [children] : [];
  return (
    <section>
      <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
      {items.length > 0 ? <ul className="mt-1 -mx-2 space-y-0.5 text-sm">{children}</ul> : <p className="mt-1 text-sm text-slate-500">{empty}</p>}
    </section>
  );
}

/** 접을 수 있는 원문 블록. */
function TextBlock({ title, text, defaultOpen = false }: { title: string; text: string; defaultOpen?: boolean }) {
  return (
    <details open={defaultOpen || undefined} className="group rounded-xl border border-slate-200 bg-white shadow-sm">
      <summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-4 py-3 text-sm font-semibold text-slate-900 sm:px-5">
        <span>{title}</span>
        <span aria-hidden className="text-slate-400 transition-transform group-open:rotate-180">
          ▾
        </span>
      </summary>
      <pre className="max-h-[32rem] overflow-auto border-t border-slate-100 px-4 py-3 font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800 sm:px-5">
        {text}
      </pre>
    </details>
  );
}
