import type { Metadata } from "next";
import Link from "next/link";
import { after } from "next/server";
import { formatDateTime } from "@/components/app/stages";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { SourceLink } from "@/components/postings/SourceLink";
import { DraftJobsStrip } from "@/components/resumes/DraftJobsStrip";
import { ResumeListStatus } from "@/components/resumes/ResumeListStatus";
import { ResumeStatusBadge } from "@/components/resumes/ResumeStatusControl";
import { cn } from "@/components/ui/cn";
import { requireUser } from "@/lib/auth/session";
import { RESUME_APPLY_STATUS_LABELS, RESUME_TEMPLATES } from "@/lib/domain/resumes";
import { listVisibleDraftJobs } from "@/lib/resumes/draft-jobs";
import { sweepStaleAgentJobs } from "@/lib/resume-agent/jobs";
import { listResumePostingLinks, listResumes, parseResumeStatusFilter } from "@/lib/resumes/service";
import type { ResumeListItem, ResumeListStatusFilter, ResumePostingLink } from "@/lib/resumes/types";

export const metadata: Metadata = { title: "이력서" };
export const dynamic = "force-dynamic";

type Search = Promise<{ [key: string]: string | string[] | undefined }>;

const FILTER_LABELS: Record<ResumeListStatusFilter, string> = {
  all: "전체",
  draft: RESUME_APPLY_STATUS_LABELS.draft,
  applying: RESUME_APPLY_STATUS_LABELS.applying,
  submitted: RESUME_APPLY_STATUS_LABELS.submitted,
  general: "공용",
};

function matches(item: ResumeListItem, f: ResumeListStatusFilter): boolean {
  if (f === "all") return true;
  if (f === "general") return item.kind === "general";
  return item.kind !== "general" && item.applyStatus === f;
}

export default async function ResumesPage({ searchParams }: { searchParams: Search }) {
  const user = await requireUser("/app/resumes");
  const sp = await searchParams;
  const filter = parseResumeStatusFilter(Array.isArray(sp.status) ? sp.status[0] : sp.status);
  // 개수를 함께 보여 주려고 한 번에 읽고 화면에서 거른다(사용자당 이력서 상한이 작다).
  const [all, draftJobs] = await Promise.all([listResumes(user.id), listVisibleDraftJobs(user.id)]);
  const postings = await listResumePostingLinks(user.id, all.map((i) => i.postingId));
  // 다음 단계를 기다리는 에이전트 작업이 오래 머물렀으면 이어 가기를 요청한다(서명 fetch만 — 응답 뒤, 렌더를 막지 않는다).
  if (draftJobs.some((j) => j.mode === "agent" && j.status === "running")) after(() => sweepStaleAgentJobs(user.id).then(() => undefined, () => undefined));
  const items = all.filter((i) => matches(i, filter));
  const generals = items.filter((i) => i.kind === "general");
  const companies = items.filter((i) => i.kind !== "general");
  const showGeneral = filter === "all" || filter === "general";
  const showCompany = filter !== "general";

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">이력서</h1>
          <p className="mt-1 text-sm text-slate-500">공용 이력서를 다듬어 두고, 지원하는 공고마다 맞춘 이력서를 만들어 버전을 관리합니다. {all.length}개</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Link href="/app/resumes/new?target=general" className={buttonClass("secondary", "md")}>
            공용 이력서 만들기
          </Link>
          <Link href="/app/resumes/new" className={buttonClass("primary", "md")}>
            새 이력서
          </Link>
        </div>
      </div>

      {/* 진행 중인(또는 최근 실패한) AI 초안 — 끝나면 목록을 새로 그린다. key로 서버 값이 바뀌면 다시 시작한다. */}
      <DraftJobsStrip key={draftJobs.map((j) => `${j.id}:${j.status}`).join(",")} initialJobs={draftJobs} />

      {all.length > 0 && (
        <nav aria-label="지원 상태로 거르기" className="flex flex-wrap gap-1.5">
          {(Object.keys(FILTER_LABELS) as ResumeListStatusFilter[]).map((f) => {
            const active = f === filter;
            const n = all.filter((i) => matches(i, f)).length;
            return (
              <Link
                key={f}
                href={f === "all" ? "/app/resumes" : `/app/resumes?status=${f}`}
                aria-current={active ? "page" : undefined}
                className={cn(
                  "rounded-full border px-3 py-1 text-sm font-medium transition-colors",
                  active ? "border-indigo-600 bg-indigo-600 text-white" : "border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
                )}
              >
                {FILTER_LABELS[f]} <span className={active ? "text-indigo-100" : "text-slate-400"}>{n}</span>
              </Link>
            );
          })}
        </nav>
      )}

      {all.length === 0 && draftJobs.some((j) => j.status === "running") ? (
        // 첫 이력서를 AI 초안으로 만드는 중 — 빈 목록 안내 대신 진행 중이라고만 알린다.
        <p className="text-sm text-slate-500">첫 이력서를 만드는 중입니다. 초안이 완성되면 이 목록에 나타납니다.</p>
      ) : all.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-lg font-semibold text-slate-900">아직 만든 이력서가 없습니다</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            회사 지정 없는 공용 이력서를 먼저 만들어 두면, 공고마다 &lsquo;이 공고용으로 복제&rsquo;해 빠르게 맞출 수 있습니다. 보관한 공고를 골라 바로 만들어도 됩니다.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <Link href="/app/resumes/new?target=general" className={buttonClass("secondary", "lg")}>
              공용 이력서 만들기
            </Link>
            <Link href="/app/resumes/new" className={buttonClass("primary", "lg")}>
              공고용 이력서 만들기
            </Link>
          </div>
        </Card>
      ) : (
        <>
          {showGeneral && (
          <section aria-labelledby="general-resumes" className="space-y-3">
            <div>
              <h2 id="general-resumes" className="text-base font-semibold text-slate-900">
                공용 이력서 <span className="font-normal text-slate-500">{generals.length}개</span>
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">회사 지정 없는 기본 이력서입니다. 공고에 맞춰 복제해 쓰세요.</p>
            </div>
            {generals.length === 0 ? (
              <Card className="px-5 py-6 text-sm text-slate-500">
                아직 공용 이력서가 없습니다.{" "}
                <Link href="/app/resumes/new?target=general" className="font-medium text-indigo-700 hover:underline">
                  공용 이력서 만들기
                </Link>
              </Card>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
                {generals.map((item) => (
                  <li key={item.id}>
                    <GeneralResumeCard item={item} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          )}

          {showCompany && (
          <section aria-labelledby="company-resumes" className="space-y-3">
            <h2 id="company-resumes" className="text-base font-semibold text-slate-900">
              지원처별 이력서 <span className="font-normal text-slate-500">{companies.length}개</span>
            </h2>
            {companies.length === 0 ? (
              filter === "all" ? (
                <Card className="px-5 py-6 text-sm text-slate-500">
                  아직 지원처별 이력서가 없습니다.{" "}
                  <Link href="/app/resumes/new" className="font-medium text-indigo-700 hover:underline">
                    공고를 골라 만들기
                  </Link>
                </Card>
              ) : (
                <Card className="px-5 py-6 text-sm text-slate-500">
                  &lsquo;{FILTER_LABELS[filter]}&rsquo; 상태인 이력서가 없습니다.{" "}
                  <Link href="/app/resumes" className="font-medium text-indigo-700 hover:underline">
                    전체 보기
                  </Link>
                </Card>
              )
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
                {companies.map((item) => (
                  <li key={item.id}>
                    <ResumeRow item={item} posting={item.postingId ? (postings.get(item.postingId) ?? null) : null} />
                  </li>
                ))}
              </ul>
            )}
          </section>
          )}
        </>
      )}
    </div>
  );
}

function VersionMeta({ item }: { item: ResumeListItem }) {
  return (
    <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
      <div className="flex gap-1.5">
        <dt className="text-slate-500">버전</dt>
        <dd className="font-medium text-slate-900">
          {item.currentVersionNo ? `v${item.currentVersionNo}` : "–"}
          <span className="font-normal text-slate-500"> / {item.versionCount}개</span>
        </dd>
      </div>
      {item.hasEditDraft && (
        <div className="flex" title="새 버전으로 저장하지 않은 작업본이 있습니다. 열면 이어서 고칠 수 있습니다.">
          <Badge tone="warning">임시 저장본 있음</Badge>
        </div>
      )}
      <div className="flex gap-1.5">
        <dt className="text-slate-500">최근 수정</dt>
        <dd className="text-slate-700">
          <time dateTime={new Date(item.updatedAt).toISOString()}>{formatDateTime(item.updatedAt)}</time>
        </dd>
      </div>
    </dl>
  );
}

/** 공용 이력서 카드: 열기 + '이 공고용으로 복제'(새 이력서 화면에서 공고를 고르면 이 내용으로 시작). */
function GeneralResumeCard({ item }: { item: ResumeListItem }) {
  const template = RESUME_TEMPLATES[item.templateId];
  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm sm:p-5">
      <Link href={`/app/resumes/${item.id}`} className="group block min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <p className="min-w-0 flex-1 truncate font-semibold text-slate-900 group-hover:text-indigo-700">{item.title}</p>
          <span className="flex gap-1">
            <ResumeStatusBadge kind="general" status={null} />
            <Badge tone="neutral">{template?.name ?? item.templateId}</Badge>
          </span>
        </div>
        <p className="mt-0.5 text-sm text-slate-500">공용 · 회사 지정 없음</p>
        <VersionMeta item={item} />
      </Link>
      <div className="mt-auto flex flex-wrap gap-2 pt-4">
        <Link href={`/app/resumes/new?from=${encodeURIComponent(item.id)}`} className={buttonClass("secondary", "sm")}>
          이 공고용으로 복제
        </Link>
      </div>
    </div>
  );
}

/** 지원처별 이력서 카드: 본문은 편집 화면 링크, 아래 줄에 지원 상태 빠른 변경·원문 공고 링크(링크 밖 형제라 카드 이동과 겹치지 않는다). */
function ResumeRow({ item, posting }: { item: ResumeListItem; posting: ResumePostingLink | null }) {
  const template = RESUME_TEMPLATES[item.templateId];
  return (
    <div className="flex h-full flex-col rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 sm:p-5">
      <Link href={`/app/resumes/${item.id}`} className="group block min-w-0">
        <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold text-slate-900 group-hover:text-indigo-700">{item.company}</p>
            <p className="mt-0.5 truncate text-sm text-slate-500">{item.roleTitle}</p>
          </div>
          <Badge tone="neutral">{template?.name ?? item.templateId}</Badge>
        </div>
        <VersionMeta item={item} />
      </Link>
      <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-3">
        <ResumeListStatus
          resumeId={item.id}
          kind={item.kind}
          status={item.applyStatus}
          hasPosting={!!posting}
          hasApplication={!!item.submittedApplicationId}
        />
        {posting && <SourceLink url={posting.url} variant="icon" />}
      </div>
    </div>
  );
}
