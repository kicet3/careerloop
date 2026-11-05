import type { Metadata } from "next";
import { NewDiagnosisForm } from "@/components/app/NewDiagnosisForm";
import { requireUser } from "@/lib/auth/session";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "새 진단" };
export const dynamic = "force-dynamic";

export default async function NewDiagnosisPage() {
  await requireUser("/app/new");
  const options = await listProviderOptions();
  return (
    <div className="mx-auto max-w-3xl">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">새 진단</h1>
      <p className="mt-1 mb-6 text-sm text-slate-500">
        이력서와 지원할 공고를 넣으면 심사위원 7명의 판정, JD 적합도, 개선 방향, 다시 쓴 이력서를 한 보고서로 드립니다.
      </p>
      <NewDiagnosisForm providers={options} defaultProvider={pickDefault(options)} />
    </div>
  );
}
