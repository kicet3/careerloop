import type { Metadata } from "next";
import Link from "next/link";
import { NewDiagnosisForm } from "@/components/app/NewDiagnosisForm";
import { SensitiveInfoNotice } from "@/components/app/SensitiveInfoNotice";
import { requireUser } from "@/lib/auth/session";
import { uploadLimitsFor } from "@/lib/ingest/upload-limits";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "새 진단" };
export const dynamic = "force-dynamic";

export default async function NewDiagnosisPage() {
  await requireUser("/app/new");
  const options = await listProviderOptions();
  return (
    <div>
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">새 진단</h1>
      <p className="mt-1 max-w-prose text-sm text-slate-500">
        이력서와 지원할 공고를 넣으면 심사위원 7명의 판정, JD 적합도, 개선 방향, 다시 쓴 이력서를 한 보고서로 드립니다.
      </p>
      <p className="mt-1 mb-6 max-w-prose text-sm text-slate-500">
        경력 그래프의 ‘경험 체크리스트’를 채워 두면 이력서 초안과 자소서 소재로 바로 쓸 수 있어요 →{" "}
        <Link href="/app/graph" className="font-medium text-indigo-700 hover:underline">
          경력 그래프
        </Link>
      </p>
      <SensitiveInfoNotice className="mb-6 max-w-3xl" />
      <NewDiagnosisForm providers={options} defaultProvider={pickDefault(options)} uploadLimits={uploadLimitsFor()} />
    </div>
  );
}
