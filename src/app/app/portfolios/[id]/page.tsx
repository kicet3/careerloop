import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { GraphPortfolioView } from "@/components/portfolios/GraphPortfolioView";
import { PortfolioItem } from "@/components/portfolios/PortfolioItem";
import { PortfolioOriginalViewer } from "@/components/portfolios/PortfolioOriginalViewer";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/session";
import { findActiveRegenerateJob } from "@/lib/portfolios/graph-jobs";
import { portfolioUploadLimits } from "@/lib/portfolios/http";
import { getPortfolio, getPortfolioText } from "@/lib/portfolios/service";
import { listPostings } from "@/lib/postings/service";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

type Props = { params: Promise<{ id: string }> };

export const dynamic = "force-dynamic";

/** 상세 화면에 보이는 뽑은 글 앞부분(글자). */
const DETAIL_PREVIEW_CHARS = 8000;

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { id } = await params;
  const user = await requireUser(`/app/portfolios/${id}`);
  const p = await getPortfolio(user.id, id);
  return { title: p?.title ?? "포트폴리오" };
}

/**
 * 포트폴리오 상세: 정보·붙인 이력서·고치기, 올린 원본 그대로 보기(PDF·이미지·DOCX, 그 밖은 내려받기)와 뽑아 둔 글.
 * 경험 그래프로 만든 것은 A4 미리보기·본문 고치기·다시 만들기.
 */
export default async function PortfolioPage({ params }: Props) {
  const { id } = await params;
  const user = await requireUser(`/app/portfolios/${id}`);
  const [portfolio, got] = await Promise.all([getPortfolio(user.id, id), getPortfolioText(user.id, id)]);
  if (!portfolio || !got) notFound();
  const text = got.text ?? "";
  const { config: upload } = portfolioUploadLimits();

  if (portfolio.kind === "graph") {
    const [postings, providers, regenerating] = await Promise.all([
      listPostings(user.id),
      listProviderOptions(),
      findActiveRegenerateJob(user.id, portfolio.id),
    ]);
    return (
      <div className="space-y-4">
        <Link href="/app/portfolios" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800 print:hidden">
          <span aria-hidden>←</span> 포트폴리오 목록
        </Link>
        <div className="print:hidden">
          <PortfolioItem portfolio={portfolio} upload={upload} variant="detail" />
        </div>
        {/* 본문이 없어도(저장소 객체 유실 등) 같은 화면에서 다시 만들기·직접 쓰기로 이 포트폴리오를 채운다(붙인 이력서가 그대로 이어진다). */}
        <GraphPortfolioView
          key={regenerating?.id ?? "idle"}
          portfolio={portfolio}
          text={text}
          regeneratingJobId={regenerating?.id ?? null}
          postings={postings.map((p) => ({ id: p.id, company: p.company, roleTitle: p.roleTitle }))}
          providers={providers}
          defaultProvider={pickDefault(providers)}
        />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Link href="/app/portfolios" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 포트폴리오 목록
      </Link>
      <PortfolioItem portfolio={portfolio} upload={upload} variant="detail" />

      {portfolio.kind === "file" && (
        <Card>
          <CardHeader title="원본 파일" description="올린 파일을 그대로 보여 줍니다. 나만 볼 수 있습니다." />
          <CardBody>
            {portfolio.original ? (
              <PortfolioOriginalViewer
                portfolioId={portfolio.id}
                fileName={portfolio.fileName}
                original={portfolio.original}
                version={portfolio.updatedAt}
              />
            ) : (
              <p className="text-sm text-slate-600">
                이 포트폴리오는 원본 보관 기능 전에 올려 원본 파일이 없습니다. ‘내용 바꾸기’로 파일을 다시 올리면 원본을 그대로 볼 수 있습니다.
              </p>
            )}
          </CardBody>
        </Card>
      )}

      {portfolio.kind === "file" && (portfolio.original?.view !== "image" || text) && (
        <Card>
          <CardHeader
            title="뽑아 둔 글"
            description={
              text
                ? `${text.length.toLocaleString("ko-KR")}자${text.length > DETAIL_PREVIEW_CHARS ? ` 중 앞부분 ${DETAIL_PREVIEW_CHARS.toLocaleString("ko-KR")}자` : ""}. 면접 질문·진단에는 이 글이 들어갑니다.`
                : undefined
            }
          />
          <CardBody>
            {text ? (
              <pre className="max-h-[32rem] overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-700">
                {text.slice(0, DETAIL_PREVIEW_CHARS)}
              </pre>
            ) : (
              <p className="text-sm text-slate-500">
                {portfolio.original
                  ? "이 파일에서는 AI가 읽을 글을 뽑지 못했습니다(스캔본·이미지 등). 원본은 위에서 그대로 볼 수 있고, 설명에 역할·결과를 적으면 면접 질문·진단에 반영됩니다."
                  : "저장된 글이 없습니다. \u2018내용 바꾸기\u2019로 파일을 다시 올려 주세요."}
              </p>
            )}
          </CardBody>
        </Card>
      )}
    </div>
  );
}
