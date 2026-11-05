import type { Metadata } from "next";
import Link from "next/link";
import { SensitiveInfoNotice } from "@/components/app/SensitiveInfoNotice";
import { NewResumeForm, type PostingPickOption } from "@/components/resumes/NewResumeForm";
import { requireUser } from "@/lib/auth/session";
import { graphEnabled } from "@/lib/graph/service";
import { getPosting, listPostings } from "@/lib/postings/service";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";
import { listRewriteCandidates } from "@/lib/resumes/draft";
import { listResumes } from "@/lib/resumes/service";

export const metadata: Metadata = { title: "새 이력서" };
export const dynamic = "force-dynamic";

type Search = { postingId?: string | string[]; from?: string | string[]; target?: string | string[] };

const one = (v: string | string[] | undefined) => (typeof v === "string" && v ? v.slice(0, 64) : null);

const pick = (p: PostingPickOption): PostingPickOption => ({
  id: p.id,
  company: p.company,
  roleTitle: p.roleTitle,
  status: p.status,
  deadline: p.deadline,
  updatedAt: p.updatedAt,
});

/**
 * 새 이력서. ?postingId=(공고 상세의 "이 공고용 이력서")면 그 공고를 미리 고르고, ?from=(이력서 목록의 "이 공고용으로 복제")면
 * 그 공용 이력서 내용으로 시작하게 둔다. ?target=general이면 공용 이력서로 시작한다. 남의 것·없는 것은 무시한다.
 */
export default async function NewResumePage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser("/app/resumes/new");
  const sp = await searchParams;
  const postingId = one(sp.postingId);
  const from = one(sp.from);
  const [found, postings, generals, providers, candidates] = await Promise.all([
    postingId ? getPosting(user.id, postingId) : Promise.resolve(null),
    listPostings(user.id),
    listResumes(user.id, { kind: "general" }),
    listProviderOptions(),
    listRewriteCandidates(user.id),
  ]);
  const generalResumes = generals.map((r) => ({ id: r.id, title: r.title, updatedAt: r.updatedAt }));
  const fromResume = from ? generalResumes.find((r) => r.id === from) : undefined;
  return (
    <div>
      <Link href="/app/resumes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 이력서 목록
      </Link>
      <h1 className="mt-3 text-2xl font-bold tracking-tight text-slate-900">새 이력서</h1>
      <p className="mt-1 mb-6 max-w-prose text-sm text-slate-500">
        지원할 공고를 고르거나(공용 이력서는 회사 지정 없음) 초안을 어디서 가져올지 정하세요. 만든 뒤 편집 화면에서 다듬고 버전으로 저장합니다.
      </p>
      {found && (
        <p className="-mt-3 mb-6 text-sm text-indigo-700">
          보관한 공고 <span className="font-medium">{found.company} · {found.roleTitle}</span>를 골랐습니다. 이 이력서는 공고에 연결됩니다.
        </p>
      )}
      {fromResume && (
        <p className="-mt-3 mb-6 text-sm text-indigo-700">
          공용 이력서 <span className="font-medium">{fromResume.title}</span>의 내용으로 시작합니다. 지원할 공고를 골라 주세요.
        </p>
      )}
      <SensitiveInfoNotice className="mb-6 max-w-3xl" />
      <NewResumeForm
        providers={providers}
        defaultProvider={pickDefault(providers)}
        graphAvailable={graphEnabled()}
        diagnoses={candidates}
        postings={postings.map(pick)}
        generalResumes={generalResumes}
        posting={found ? pick(found) : null}
        sourceResumeId={fromResume?.id ?? null}
        initialTarget={one(sp.target) === "general" ? "general" : undefined}
      />
    </div>
  );
}
