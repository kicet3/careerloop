import type { Metadata } from "next";
import { NewPortfolioPanel } from "@/components/portfolios/NewPortfolioPanel";
import { PortfolioItem } from "@/components/portfolios/PortfolioItem";
import { requireUser } from "@/lib/auth/session";
import { MAX_PORTFOLIOS_PER_USER } from "@/lib/domain/portfolios";
import { portfolioUploadLimits } from "@/lib/portfolios/http";
import { listPortfolios } from "@/lib/portfolios/service";

export const metadata: Metadata = { title: "포트폴리오" };
export const dynamic = "force-dynamic";

/** 포트폴리오 보관함: 파일·링크로 포트폴리오를 모아 두고, 이력서마다 하나를 골라 붙인다. */
export default async function PortfoliosPage() {
  const user = await requireUser("/app/portfolios");
  const items = await listPortfolios(user.id);
  const { perFile } = portfolioUploadLimits();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">포트폴리오</h1>
        <p className="mt-1 max-w-3xl text-sm text-slate-500">
          포트폴리오를 파일이나 링크로 모아 두고 이력서마다 하나씩 골라 붙입니다. 붙인 포트폴리오는 면접 연습 질문과 진단에 함께 쓰입니다. 파일은 글만 뽑아
          저장하고 원본은 보관하지 않습니다. {items.length}/{MAX_PORTFOLIOS_PER_USER}개
        </p>
      </div>

      <NewPortfolioPanel maxBytes={perFile} count={items.length} startOpen={items.length === 0} />

      {items.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-300 px-4 py-8 text-center text-sm text-slate-500">아직 보관한 포트폴리오가 없습니다.</p>
      ) : (
        <ul className="grid gap-4 xl:grid-cols-2">
          {items.map((p) => (
            <li key={p.id}>
              <PortfolioItem portfolio={p} maxBytes={perFile} variant="card" />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
