import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { DraftProgress } from "@/components/resumes/DraftProgress";
import { requireUser } from "@/lib/auth/session";
import { getDraftJob } from "@/lib/resumes/draft-jobs";

export const metadata: Metadata = { title: "AI 초안 만드는 중" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<{ fallback?: string | string[] }> };

/**
 * AI 이력서 초안 진행 화면('초안 만들기' 직후). 남의 작업·지워진 작업은 404. 끝나면 편집 화면으로 옮긴다. 제목은 DraftProgress가 상태에 맞춰 그린다.
 * ?fallback=agent: AI 에이전트를 골랐지만 쓸 수 없어 빠른 초안으로 만들었다(안내만 띄운다).
 */
export default async function ResumeDraftPage({ params, searchParams }: Props) {
  const { id } = await params;
  const { fallback } = await searchParams;
  const user = await requireUser(`/app/resumes/drafts/${id}`);
  const job = await getDraftJob(user.id, id.slice(0, 64));
  if (!job) notFound();
  return (
    <div>
      <Link href="/app/resumes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 이력서 목록
      </Link>
      <DraftProgress initialJob={job} agentFallback={fallback === "agent"} />
    </div>
  );
}
