import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GraphPortfolioProgress } from "@/components/portfolios/GraphPortfolioProgress";
import { requireUser } from "@/lib/auth/session";
import { getGraphPortfolioJob } from "@/lib/portfolios/graph-jobs";

export const metadata: Metadata = { title: "포트폴리오 만드는 중" };
export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** 경험 그래프 포트폴리오 진행 화면. 남의 작업·지워진 작업은 404. 끝나면 포트폴리오 화면으로 옮긴다. */
export default async function GraphPortfolioDraftPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser(`/app/portfolios/drafts/${id}`);
  const job = await getGraphPortfolioJob(user.id, id.slice(0, 64));
  if (!job) notFound();
  return (
    <div>
      <Link href="/app/portfolios" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 포트폴리오 목록
      </Link>
      <GraphPortfolioProgress initialJob={job} />
    </div>
  );
}
