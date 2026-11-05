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

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">이력서</h1>
          <p className="mt-1 text-sm text-slate-500">지원하는 회사별로 이력서를 만들고 버전을 관리합니다. {items.length}개</p>
        </div>
        <Link href="/app/resumes/new" className={buttonClass("primary", "md")}>
          새 이력서
        </Link>
      </div>

      {items.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-lg font-semibold text-slate-900">아직 만든 이력서가 없습니다</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            지원할 회사와 직무를 정하고, 경력 그래프나 진단에서 다시 쓴 이력서로 초안을 만든 뒤 양식에 맞춰 다듬어 보세요.
          </p>
          <Link href="/app/resumes/new" className={buttonClass("primary", "lg", "mt-6")}>
            첫 이력서 만들기
          </Link>
        </Card>
      ) : (
        <ul className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 min-[1920px]:grid-cols-4">
          {items.map((item) => (
            <li key={item.id}>
              <ResumeRow item={item} />
            </li>
          ))}
        </ul>
      )}
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
    </Link>
  );
}
