import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DiagnosisView } from "@/components/app/DiagnosisView";
import { ReportActions } from "@/components/app/ReportActions";
import { Alert } from "@/components/ui/Alert";
import { Report } from "@/components/report/Report";
import { requireUser } from "@/lib/auth/session";
import { getDiagnosisForUser, markStaleRunsFailed } from "@/lib/diagnoses/service";
import { buildReportModel } from "@/lib/report/model";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

/** 생성 직후 전달된 경고(`?w=` JSON 배열). 형식이 틀리면 무시하고, 길이를 제한한다. */
function parseWarnings(raw: string | string[] | undefined): string[] {
  if (typeof raw !== "string" || raw.length > 2000) return [];
  try {
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").slice(0, 5).map((x) => x.slice(0, 200)) : [];
  } catch {
    return [];
  }
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser(`/app/d/${id}`);
  const found = await getDiagnosisForUser(id, user.id);
  return { title: found?.diagnosis.title ?? "진단" };
}

export default async function DiagnosisPage({ params, searchParams }: Props) {
  const { id } = await params;
  const warnings = parseWarnings((await searchParams).w);
  const user = await requireUser(`/app/d/${id}`);
  await markStaleRunsFailed(user.id);
  const found = await getDiagnosisForUser(id, user.id);
  if (!found) notFound();
  const { diagnosis, stages } = found;

  const warningAlert =
    warnings.length > 0 ? (
      <Alert tone="warning" title="입력 확인">
        <ul className="list-disc space-y-0.5 pl-4">
          {warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      </Alert>
    ) : null;

  const back = (
    <Link href="/app" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
      <span aria-hidden>←</span> 내 진단
    </Link>
  );

  if (diagnosis.status === "done") {
    const report = buildReportModel(diagnosis, stages);
    return (
      <div className="space-y-4">
        {back}
        {warningAlert}
        <Report report={report} actions={<ReportActions id={diagnosis.id} shareToken={diagnosis.shareToken} />} />
      </div>
    );
  }

  const startedTimes = stages
    .map((s) => s.startedAt?.getTime())
    .filter((t): t is number => typeof t === "number");
  const startedAt = startedTimes.length ? Math.min(...startedTimes) : diagnosis.createdAt.getTime();

  return (
    <div className="mx-auto max-w-3xl space-y-4">
      {back}
      <div>
        <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900">{diagnosis.title}</h1>
        <p className="mt-1 text-sm text-slate-500">
          {diagnosis.targetRole}
          {diagnosis.jdText ? " · JD 기준 심사" : " · JD 없음(직무명으로 요건 추정)"}
        </p>
      </div>
      {warningAlert}
      <DiagnosisView
        id={diagnosis.id}
        initial={{
          status: diagnosis.status,
          error: diagnosis.error,
          startedAt,
          stages: stages.map((s) => ({ stage: s.stage, status: s.status, error: s.error })),
        }}
      />
    </div>
  );
}
