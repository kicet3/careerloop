import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { CreationWarnings } from "@/components/app/CreationWarnings";
import { DiagnosisView } from "@/components/app/DiagnosisView";
import { ReportActions } from "@/components/app/ReportActions";
import { Alert } from "@/components/ui/Alert";
import { Report } from "@/components/report/Report";
import { requireUser } from "@/lib/auth/session";
import { getDiagnosisForUser, markStaleRunsFailed } from "@/lib/diagnoses/service";
import { buildReportModel, reportAvailability } from "@/lib/report/model";

type Props = { params: Promise<{ id: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser(`/app/d/${id}`);
  const found = await getDiagnosisForUser(id, user.id);
  return { title: found?.diagnosis.title ?? "진단" };
}

export default async function DiagnosisPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser(`/app/d/${id}`);
  await markStaleRunsFailed(user.id);
  const found = await getDiagnosisForUser(id, user.id);
  if (!found) notFound();
  const { diagnosis, stages } = found;

  const warningAlert = <CreationWarnings id={diagnosis.id} />;

  const back = (
    <Link href="/app" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 print:hidden">
      <span aria-hidden>←</span> 내 진단
    </Link>
  );

  const avail = reportAvailability(diagnosis.status, stages);
  if (avail.show && !avail.partial) {
    const report = buildReportModel(diagnosis, stages);
    return (
      <div className="space-y-4">
        {back}
        {warningAlert}
        <Report
          report={report}
          reviewerChat={{ diagnosisId: diagnosis.id }}
          actions={<ReportActions id={diagnosis.id} shareToken={diagnosis.shareToken} />}
        />
      </div>
    );
  }

  const startedTimes = stages
    .map((s) => s.startedAt?.getTime())
    .filter((t): t is number => typeof t === "number");
  const startedAt = startedTimes.length ? Math.min(...startedTimes) : diagnosis.createdAt.getTime();

  return (
    <div className="space-y-4">
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
      {avail.partial && (
        <>
          <Alert tone="warning" title="부분 보고서">
            일부 단계가 실패해 아래 보고서에 {avail.missing.join(", ")} 결과가 빠져 있습니다. 심사위원 7명의 판정과 JD
            적합도는 그대로 볼 수 있고, 위의 재시도로 빠진 부분을 채울 수 있습니다.
          </Alert>
          {(() => {
            const report = buildReportModel(diagnosis, stages);
            return (
              <Report
                report={report}
                reviewerChat={{ diagnosisId: diagnosis.id }}
                actions={
                  <ReportActions id={diagnosis.id} shareToken={diagnosis.shareToken} partial hasRewrite={!!report.rewrite} />
                }
              />
            );
          })()}
        </>
      )}
    </div>
  );
}
