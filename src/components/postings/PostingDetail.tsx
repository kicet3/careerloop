"use client";
/**
 * 공고 상세: 메타·상태 편집, JD 원문/섹션 보기, 다음 행동(이 공고로 진단 · 이 공고용 이력서 · 지원 기록 추가),
 * 이 공고로 만든 진단·이력서·지원 기록. '내 경력과 대조' 카드는 페이지가 matchCard로 넣는다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { DIAGNOSIS_STATUS_VIEW, formatDateTime } from "@/components/app/stages";
import { SegmentedTabs } from "@/components/app/Tabs";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { APPLICATION_STAGE_LABELS, type JobApplication } from "@/lib/domain/applications";
import {
  CAREER_LEVEL_LABELS,
  EMPLOYMENT_TYPE_LABELS,
  POSTING_STATUS_LABELS,
  POSTING_STATUSES,
  WORK_TYPE_LABELS,
  type JobPosting,
  type PostingStatus,
} from "@/lib/domain/postings";
import type { DiagnosisStatus } from "@/lib/domain/schemas";
import { formatPostingDeadline } from "@/lib/postings/deadline";
import { analyzeJobDescription } from "@/lib/postings/jd-sections";
import { platformLabel } from "@/lib/postings/url";
import { saveDiagnosisPrefill } from "@/lib/resumes/prefill";
import { formatKstDate } from "@/lib/time/kst";
import { PostingForm } from "./PostingForm";
import { DeadlineBadge, inputClass, PostingStatusBadge, readApiError, useNow } from "./shared";

export interface PostingLinksView {
  diagnoses: { id: string; title: string; status: string; createdAt: number }[];
  resumes: { id: string; title: string; company: string; roleTitle: string; updatedAt: number }[];
}

export function PostingDetail({
  posting: initial,
  links,
  serverNow,
  matchCard,
}: {
  posting: JobPosting;
  links: PostingLinksView;
  serverNow: number;
  matchCard?: React.ReactNode;
}) {
  const router = useRouter();
  const now = useNow(serverNow);
  const [posting, setPosting] = useState(initial);
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"status" | "delete" | null>(null);

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
      jdText: posting.jdText,
      postingId: posting.id,
      postingLabel: `${posting.company} · ${posting.roleTitle}`,
    });
    router.push("/app/new");
  }

  const meta: [string, string][] = [
    ["마감", formatPostingDeadline(posting)],
    ["고용 형태", EMPLOYMENT_TYPE_LABELS[posting.employmentType]],
    ["경력 조건", CAREER_LEVEL_LABELS[posting.careerLevel]],
    ["근무 형태", WORK_TYPE_LABELS[posting.workType]],
    ["근무지", posting.location || "미확인"],
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
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <PostingStatusBadge status={posting.status} />
            <DeadlineBadge posting={posting} now={now} />
            {posting.url && (
              <a
                href={posting.url}
                target="_blank"
                rel="noopener noreferrer nofollow"
                className="max-w-full truncate text-sm text-indigo-700 hover:underline"
              >
                원문 공고 열기 ↗
              </a>
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
          <Button variant="secondary" onClick={() => setEditing((e) => !e)} aria-expanded={editing}>
            {editing ? "수정 닫기" : "수정"}
          </Button>
          <Button variant="danger" onClick={() => void onDelete()} loading={busy === "delete"}>
            삭제
          </Button>
        </div>
      </div>

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
        <Button onClick={startDiagnosis}>이 공고로 진단</Button>
        <Link href={`/app/resumes/new?postingId=${encodeURIComponent(posting.id)}`} className={buttonClass("secondary", "md")}>
          이 공고용 이력서
        </Link>
        <Link href={`/app/applications?new=1&postingId=${encodeURIComponent(posting.id)}`} className={buttonClass("secondary", "md")}>
          지원 기록 추가
        </Link>
      </div>

      {editing && (
        <Card className="p-5 sm:p-6">
          <h2 className="mb-4 text-base font-semibold text-slate-900">공고 수정</h2>
          <PostingForm
            posting={posting}
            onCancel={() => setEditing(false)}
            onSaved={(p) => {
              setPosting(p);
              setEditing(false);
            }}
          />
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] xl:items-start">
        <div className="min-w-0 space-y-6">
          <Card>
            <CardHeader title="공고 정보" />
            <CardBody>
              <dl className="grid grid-cols-1 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                {meta.map(([k, v]) => (
                  <div key={k} className="flex gap-3 sm:block">
                    <dt className="w-20 shrink-0 text-slate-500 sm:w-auto">{k}</dt>
                    <dd className="min-w-0 font-medium break-words text-slate-900 sm:mt-0.5">{v}</dd>
                  </div>
                ))}
              </dl>
              {posting.note && (
                <div className="mt-5 border-t border-slate-100 pt-4">
                  <p className="text-sm font-medium text-slate-500">메모</p>
                  <p className="mt-1 text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800">{posting.note}</p>
                </div>
              )}
            </CardBody>
          </Card>
          <JdCard jdText={posting.jdText} onEdit={() => setEditing(true)} />
        </div>
        <div className="min-w-0 space-y-6">
          {matchCard}
          <RelatedCard postingId={posting.id} links={links} />
        </div>
      </div>
    </div>
  );
}

function JdCard({ jdText, onEdit }: { jdText: string; onEdit: () => void }) {
  const [view, setView] = useState<"sections" | "raw">("sections");
  const sections = useMemo(() => analyzeJobDescription(jdText), [jdText]);
  const hasSections = sections.required.length + sections.preferred.length + sections.duties.length > 0;
  if (!jdText.trim()) {
    return (
      <Card>
        <CardHeader title="JD" />
        <CardBody>
          <p className="text-sm text-slate-500">JD 원문이 없습니다. 공고의 업무·자격 요건을 붙여넣으면 진단과 경력 대조가 정확해집니다.</p>
          <Button variant="secondary" size="sm" className="mt-3" onClick={onEdit}>
            JD 붙여넣기
          </Button>
        </CardBody>
      </Card>
    );
  }
  const groups: [string, string[]][] = [
    ["필수 요건", sections.required],
    ["우대 사항", sections.preferred],
    ["주요 업무", sections.duties],
  ];
  return (
    <Card>
      <CardHeader
        title="JD"
        action={
          <SegmentedTabs
            label="JD 보기 방식"
            value={hasSections ? view : "raw"}
            onChange={setView}
            options={[
              { value: "sections", label: "섹션" },
              { value: "raw", label: "원문" },
            ]}
          />
        }
      />
      <CardBody>
        {hasSections && view === "sections" ? (
          <div className="space-y-4">
            {groups
              .filter(([, lines]) => lines.length > 0)
              .map(([title, lines]) => (
                <section key={title}>
                  <h3 className="text-sm font-semibold text-slate-900">{title}</h3>
                  <ul className="mt-1.5 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700">
                    {lines.slice(0, 40).map((l, i) => (
                      <li key={i} className="break-words">
                        {l}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            {sections.keywords.length > 0 && (
              <section>
                <h3 className="text-sm font-semibold text-slate-900">기술·역량 키워드</h3>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  {sections.keywords.map((k) => (
                    <Badge key={k} tone="accent">
                      {k}
                    </Badge>
                  ))}
                </div>
              </section>
            )}
          </div>
        ) : (
          <>
            {!hasSections && <p className="mb-3 text-xs text-slate-500">자격 요건·우대 사항 제목을 찾지 못해 원문을 보여 줍니다.</p>}
            <pre className="max-h-[32rem] overflow-auto font-sans text-sm leading-relaxed break-words whitespace-pre-wrap text-slate-800">{jdText}</pre>
          </>
        )}
      </CardBody>
    </Card>
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
