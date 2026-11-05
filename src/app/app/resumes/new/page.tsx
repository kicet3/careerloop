import type { Metadata } from "next";
import Link from "next/link";
import { NewResumeForm } from "@/components/resumes/NewResumeForm";
import { requireUser } from "@/lib/auth/session";
import { graphEnabled } from "@/lib/graph/service";
import { getPosting } from "@/lib/postings/service";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";
import { listRewriteCandidates } from "@/lib/resumes/draft";
import { MAX_RESUME_JD_CHARS, MAX_RESUME_META_CHARS } from "@/lib/resumes/types";

export const metadata: Metadata = { title: "새 이력서" };
export const dynamic = "force-dynamic";

export default async function NewResumePage({ searchParams }: { searchParams: Promise<{ postingId?: string | string[] }> }) {
  const user = await requireUser("/app/resumes/new");
  const { postingId } = await searchParams;
  // 공고 보관함의 "이 공고용 이력서"(?postingId=): 내 공고면 회사·직무·JD를 채운다. 남의 공고·없는 공고는 무시한다.
  const found = typeof postingId === "string" && postingId ? await getPosting(user.id, postingId.slice(0, 64)) : null;
  const posting = found
    ? {
        id: found.id,
        company: found.company.slice(0, MAX_RESUME_META_CHARS),
        roleTitle: found.roleTitle.slice(0, MAX_RESUME_META_CHARS),
        jdText: found.jdText.slice(0, MAX_RESUME_JD_CHARS),
      }
    : null;
  const [providers, candidates] = await Promise.all([listProviderOptions(), listRewriteCandidates(user.id)]);
  return (
    <div>
      <Link href="/app/resumes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 이력서 목록
      </Link>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">새 이력서</h1>
      <p className="mt-1 mb-6 max-w-prose text-sm text-slate-500">
        지원할 회사와 직무, 양식을 고르고 초안을 어디서 가져올지 정하세요. 만든 뒤 편집 화면에서 다듬고 버전으로 저장합니다.
      </p>
      {found && (
        <p className="-mt-3 mb-6 text-sm text-indigo-700">
          보관한 공고 <span className="font-medium">{found.company} · {found.roleTitle}</span>의 정보를 채웠습니다. 이 이력서는 공고에 연결됩니다.
        </p>
      )}
      <NewResumeForm
        providers={providers}
        defaultProvider={pickDefault(providers)}
        graphAvailable={graphEnabled()}
        diagnoses={candidates}
        posting={posting}
      />
    </div>
  );
}
