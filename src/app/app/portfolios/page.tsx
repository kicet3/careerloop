import type { Metadata } from "next";
import Link from "next/link";
import { NewPortfolioPanel } from "@/components/portfolios/NewPortfolioPanel";
import { PortfolioItem } from "@/components/portfolios/PortfolioItem";
import { Badge } from "@/components/ui/Badge";
import { requireUser } from "@/lib/auth/session";
import { listVisibleGraphPortfolioJobs } from "@/lib/portfolios/graph-jobs";
import { portfolioUploadLimits } from "@/lib/portfolios/http";
import { listPortfolios } from "@/lib/portfolios/service";
import { listPostings } from "@/lib/postings/service";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "포트폴리오" };
export const dynamic = "force-dynamic";

type Search = { new?: string | string[] };

/**
 * 포트폴리오 보관함: 파일·링크로 포트폴리오를 모아 두거나 경험 그래프로 만들고, 이력서마다 하나를 골라 붙인다.
 * ?new=graph면 '경험 그래프로 만들기' 폼을 열어 둔다(경험 그래프 화면의 '포트폴리오 만들기').
 */
export default async function PortfoliosPage({ searchParams }: { searchParams: Promise<Search> }) {
  const user = await requireUser("/app/portfolios");
  const sp = await searchParams;
  const wantGraph = sp.new === "graph";
  const [items, jobs, postings, providers] = await Promise.all([
    listPortfolios(user.id),
    listVisibleGraphPortfolioJobs(user.id),
    listPostings(user.id),
    listProviderOptions(),
  ]);
  const { config: upload } = portfolioUploadLimits();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">포트폴리오</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          포트폴리오를 파일이나 링크로 모아 두거나 경험 그래프로 만들고, 이력서마다 하나씩 골라 붙입니다. 붙인 포트폴리오는 면접 연습 질문과 진단에 함께
          쓰입니다. 올린 파일은 원본 그대로 보관해 화면에 보여 주고, 질문·진단에는 파일에서 뽑은 글을 씁니다. {items.length}개
        </p>
      </div>

      <NewPortfolioPanel
        upload={upload}
        count={items.length}
        startOpen={items.length === 0 || wantGraph}
        initialMode={wantGraph ? "graph" : "file"}
        postings={postings.map((p) => ({ id: p.id, company: p.company, roleTitle: p.roleTitle }))}
        providers={providers}
        defaultProvider={pickDefault(providers)}
      />

      {jobs.length > 0 && (
        <ul className="grid gap-2" aria-label="경험 그래프 포트폴리오 작업">
          {jobs.map((j) => (
            <li key={j.id}>
              <Link
                href={`/app/portfolios/drafts/${j.id}`}
                className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2.5 text-sm hover:border-indigo-300"
              >
                <Badge tone={j.status === "failed" ? "negative" : "info"}>{j.status === "failed" ? "실패" : "만드는 중"}</Badge>
                <span className="min-w-0 truncate font-medium text-slate-900">{j.label}</span>
                <span className="text-xs text-slate-500">
                  {j.status === "failed" ? (j.error ?? "다시 시도해 주세요.") : j.regenerate ? "다시 만드는 중 — 진행 화면 보기" : "AI가 쓰는 중 — 진행 화면 보기"}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">아직 보관한 포트폴리오가 없습니다.</p>
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2">
          {items.map((p) => (
            <li key={p.id}>
              <PortfolioItem portfolio={p} upload={upload} variant="card" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
