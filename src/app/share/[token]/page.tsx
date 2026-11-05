import type { Metadata } from "next";
import { headers } from "next/headers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Logo } from "@/components/app/Logo";
import { Report } from "@/components/report/Report";
import { buttonClass } from "@/components/ui/Button";
import { clientIp, shareLimiter } from "@/lib/auth/rate-limit";
import { getDiagnosisByShareToken } from "@/lib/diagnoses/service";
import { buildReportModel } from "@/lib/report/model";

type Props = { params: Promise<{ token: string }> };

export const metadata: Metadata = {
  title: "공유된 진단 보고서",
  robots: { index: false, follow: false, nocache: true },
  referrer: "no-referrer",
};

export default async function SharedReportPage({ params }: Props) {
  const { token } = await params;
  // 공개 링크라 로그인 없이 누구나 부를 수 있다. IP당 요청 수를 제한한다.
  if (!shareLimiter.hit(clientIp({ headers: await headers() })).ok) {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center text-sm text-slate-600">
        요청이 너무 많습니다. 잠시 후 다시 열어 주세요.
      </main>
    );
  }
  const found = await getDiagnosisByShareToken(token);
  if (!found || found.diagnosis.status !== "done") notFound();
  const report = buildReportModel(found.diagnosis, found.stages);

  return (
    <>
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="flex h-14 items-center justify-between gap-3 px-4 sm:px-6 lg:px-8">
          <Logo />
          <Link href="/signup" className={buttonClass("secondary", "sm")}>
            내 이력서도 진단받기
          </Link>
        </div>
      </header>
      <main className="w-full min-w-0 flex-1 px-4 py-6 sm:px-6 lg:px-8 lg:py-8 print:p-0">
        <p className="mb-4 rounded-lg border border-slate-200 bg-white px-4 py-2.5 text-sm text-slate-600 print:hidden">
          링크로 공유된 읽기 전용 보고서입니다.
        </p>
        <Report
          report={report}
          actions={
            <a href={`/api/share/${token}/pdf`} className={buttonClass("primary", "md")} download>
              PDF 다운로드
            </a>
          }
        />
      </main>
    </>
  );
}
