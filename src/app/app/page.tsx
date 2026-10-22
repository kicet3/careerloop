import type { Metadata } from "next";
import Link from "next/link";
import { DIAGNOSIS_STATUS_VIEW, formatDateTime } from "@/components/app/stages";
import { Badge } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/session";
import { listDiagnoses, markStaleRunsFailed, type DiagnosisListItem } from "@/lib/diagnoses/service";

export const metadata: Metadata = { title: "내 진단" };

export default async function DiagnosesPage() {
  const user = await requireUser("/app");
  await markStaleRunsFailed(user.id);
  const items = await listDiagnoses(user.id);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-slate-900">내 진단</h1>
          <p className="mt-1 text-sm text-slate-500">지금까지 받은 진단 {items.length}건</p>
        </div>
        <Link href="/app/new" className={buttonClass("primary", "md")}>
          새 진단 받기
        </Link>
      </div>

      {items.length === 0 ? (
        <Card className="px-6 py-14 text-center">
          <p className="text-lg font-semibold text-slate-900">아직 받은 진단이 없습니다</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            이력서와 지원할 공고(JD)를 넣으면 심사위원 7명이 떨어뜨릴 이유를 찾고, 고칠 방향과 다시 쓴 이력서를
            드립니다. 몇 분 정도 걸립니다.
          </p>
          <Link href="/app/new" className={buttonClass("primary", "lg", "mt-6")}>
            첫 진단 시작하기
          </Link>
        </Card>
      ) : (
        <ul className="grid gap-3">
          {items.map((item) => (
            <li key={item.id}>
              <DiagnosisRow item={item} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function DiagnosisRow({ item }: { item: DiagnosisListItem }) {
  const status = DIAGNOSIS_STATUS_VIEW[item.status];
  return (
    <Link
      href={`/app/d/${item.id}`}
      className="block rounded-xl border border-slate-200 bg-white p-4 shadow-sm transition-colors hover:border-indigo-300 hover:bg-indigo-50/30 sm:p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-semibold text-slate-900">{item.title}</p>
          <p className="mt-0.5 truncate text-sm text-slate-500">{item.subtitle}</p>
        </div>
        <Badge tone={status.tone}>{status.label}</Badge>
      </div>
      <dl className="mt-3 flex flex-wrap gap-x-6 gap-y-1 text-sm">
        <div className="flex gap-1.5">
          <dt className="text-slate-500">심사 통과</dt>
          <dd className="font-medium text-slate-900">
            {item.positiveCount === null ? "–" : `${item.positiveCount}/7`}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">JD 적합도</dt>
          <dd className="font-medium text-slate-900">
            {item.matchScore === null ? "–" : `${item.matchScore}점`}
          </dd>
        </div>
        <div className="flex gap-1.5">
          <dt className="text-slate-500">요청</dt>
          <dd className="text-slate-700">
            <time dateTime={new Date(item.createdAt).toISOString()}>{formatDateTime(item.createdAt)}</time>
          </dd>
        </div>
      </dl>
    </Link>
  );
}
