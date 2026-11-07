import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { AgentProgress } from "@/components/resumes/agent/AgentProgress";
import { requireUser } from "@/lib/auth/session";
import { getAgentJob } from "@/lib/resume-agent/jobs";

export const metadata: Metadata = { title: "AI 에이전트가 이력서를 쓰는 중" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** 그래프 이력서 에이전트 진행 화면. 남의 작업·지워진 작업은 404. 끝나면 이력서 편집 화면(심사 리포트 펼침)으로 옮긴다. */
export default async function ResumeAgentPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser(`/app/resumes/agent/${id}`);
  const job = await getAgentJob(user.id, id.slice(0, 64));
  if (!job) notFound();
  return (
    <div>
      <Link href="/app/resumes" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 이력서 목록
      </Link>
      <AgentProgress initialJob={job} />
    </div>
  );
}
