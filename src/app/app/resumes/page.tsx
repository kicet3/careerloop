import type { Metadata } from "next";
import Link from "next/link";
import { formatDateTime } from "@/components/app/stages";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/session";
import { RESUME_TEMPLATES } from "@/lib/domain/resumes";
import { listResumes } from "@/lib/resumes/service";
import type { ResumeListItem } from "@/lib/resumes/types";

export const metadata: Metadata = { title: "이력서" };
export const dynamic = "force-dynamic";

export default async function ResumesPage() {
  const user = await requireUser("/app/resumes");
  const items = await listResumes(user.id);
  const generals = items.filter((i) => i.kind === "general");
  const companies = items.filter((i) => i.kind !== "general");

  return (
    <div className="space-y-8">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">이력서</h1>
          <p className="mt-1 text-sm text-slate-500">공용 이력서를 다듬어 두고, 지원하는 공고마다 맞춘 이력서를 만들어 버전을 관리합니다. {items.length}개</p>
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

      {items.length === 0 ? (
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

          <section aria-labelledby="company-resumes" className="space-y-3">
            <h2 id="company-resumes" className="text-base font-semibold text-slate-900">
              지원처별 이력서 <span className="font-normal text-slate-500">{companies.length}개</span>
            </h2>
            {companies.length === 0 ? (
              <Card className="px-5 py-6 text-sm text-slate-500">
                아직 지원처별 이력서가 없습니다.{" "}
                <Link href="/app/resumes/new" className="font-medium text-indigo-700 hover:underline">
                  공고를 골라 만들기
                </Link>
              </Card>
            ) : (
              <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
                {companies.map((item) => (
                  <li key={item.id}>
                    <ResumeRow item={item} />
                  </li>
                ))}
              </ul>
            )}
          </section>
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
          <Badge tone="accent">{template?.name ?? item.templateId}</Badge>
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

function ResumeRow({ item }: { item: ResumeListItem }) {
  const template = RESUME_TEMPLATES[item.templateId];
  return (
    <Link
      href={`/app/resumes/${item.id}`}
      className="block h-full rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{item.company}</p>
          <p className="mt-0.5 truncate text-sm text-slate-500">{item.roleTitle}</p>
        </div>
        <Badge tone="accent">{template?.name ?? item.templateId}</Badge>
      </div>
      <VersionMeta item={item} />
    </Link>
  );
}
