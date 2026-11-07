import type { Metadata, Viewport } from "next";
import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { after } from "next/server";
import { cache } from "react";
import { Logo } from "@/components/app/Logo";
import { ShareChatWidget } from "@/components/portfolio-share/ShareChatWidget";
import { PortfolioOriginalViewer } from "@/components/portfolios/PortfolioOriginalViewer";
import { PortfolioSheet } from "@/components/portfolios/PortfolioSheet";
import { Badge } from "@/components/ui/Badge";
import { clientIp, shareLimiter } from "@/lib/auth/rate-limit";
import { normalizeIpForLimit, SHARE_CHAT_LIMITS, sweepExpiredRateEvents } from "@/lib/auth/db-rate-limit";
import { shareChatAvailable } from "@/lib/portfolios/share-chat";
import { findActiveShareByToken, recordShareView, toPublicView } from "@/lib/portfolios/shares";

type Props = { params: Promise<{ token: string }> };

// 요청마다 DB에서 공개 여부를 다시 본다(공개를 끄면 바로 404 — 정적·ISR 캐시를 두지 않는다).
export const dynamic = "force-dynamic";
// 아이폰 홈 표시줄·노치 영역(env(safe-area-inset-*))을 챗봇 버튼이 피할 수 있게.
export const viewport: Viewport = { viewportFit: "cover" };

// generateMetadata와 화면이 한 요청에서 같은 조회를 나눠 쓴다.
const loadShare = cache((token: string) => findActiveShareByToken(token));

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { token } = await params;
  const share = await loadShare(token);
  if (!share) return { title: "볼 수 없는 링크", robots: { index: false, follow: false, nocache: true }, referrer: "no-referrer" };
  const view = toPublicView(share);
  return {
    title: view.title,
    description: (view.description ?? `${view.ownerLabel}의 포트폴리오`).replace(/\s+/g, " ").slice(0, 150),
    // 검색 노출은 소유자가 고른 경우에만. 링크(본문 안 주소)는 따라가지 않는다.
    robots: view.indexable ? { index: true, follow: false } : { index: false, follow: false, nocache: true },
    // 방문자가 본문 링크를 눌러도 공개 주소(토큰)가 Referer로 새지 않게.
    referrer: "no-referrer",
  };
}

const formatDate = (ms: number) => new Date(ms).toLocaleDateString("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" });

/**
 * 공개 포트폴리오(로그인 없음). 소유자가 공개한 공개본만 보여 준다 — 경험 그래프 포트폴리오는 A4 쪽 미리보기, 파일은 원본 보기(공개를 고른 경우 —
 * PDF는 화면 안 PDF 보기가 본문이고 뽑은 글은 접힌 '텍스트로 보기')와 뽑은 글, 링크는 링크 카드. 소유자가 켜 두면 오른쪽 아래 원형 버튼으로 챗봇을 연다.
 * 화면·응답에 내부 id(포트폴리오·회원·공유)와 이메일을 싣지 않는다. 없는 토큰·공개를 끈 것·바뀐 옛 토큰은 모두 같은 404.
 */
export default async function PublicPortfolioPage({ params }: Props) {
  const { token } = await params;
  if (!shareLimiter.hit(`p-page:${normalizeIpForLimit(clientIp({ headers: await headers() }))}`).ok) {
    return (
      <main className="mx-auto w-full max-w-xl flex-1 px-4 py-16 text-center text-sm text-slate-600">
        요청이 너무 많습니다. 잠시 후 다시 열어 주세요.
      </main>
    );
  }
  const share = await loadShare(token);
  if (!share) notFound();
  const view = toPublicView(share);
  const shareId = share.id;
  after(async () => {
    await recordShareView(shareId);
    // 방문자 IP 해시 기록 중 창이 지난 것을 지운다(챗봇 요청이 없을 때도 열람마다 정리된다).
    await sweepExpiredRateEvents(SHARE_CHAT_LIMITS);
  });
  const originalSrc = `/api/p/${encodeURIComponent(token)}/original`;
  const isPdf = view.original?.view === "pdf";

  return (
    <>
      <header className="border-b border-slate-200 bg-white print:hidden">
        <div className="mx-auto flex h-14 w-full max-w-5xl items-center justify-between gap-3 px-4 sm:px-6">
          <Logo />
          <span className="text-xs text-slate-500">공개 포트폴리오</span>
        </div>
      </header>
      <main className="mx-auto w-full max-w-5xl min-w-0 flex-1 space-y-5 px-4 py-6 pb-28 sm:px-6 lg:py-8 print:p-0">
        <div className="space-y-2 print:hidden">
          <Badge tone="accent">포트폴리오</Badge>
          <h1 className="text-2xl font-bold tracking-tight break-words text-slate-900 sm:text-3xl">{view.title}</h1>
          <p className="text-sm text-slate-500">
            {view.ownerLabel} · <time dateTime={new Date(view.publishedAt).toISOString()}>{formatDate(view.publishedAt)}</time> 공개
          </p>
          {view.description && <p className="max-w-3xl text-sm leading-relaxed whitespace-pre-wrap text-slate-700">{view.description}</p>}
        </div>

        {view.kind === "graph" && view.content && <PortfolioSheet source={view.content} />}

        {view.kind === "file" && view.original && (
          // PDF는 화면 안 PDF 보기(PdfViewer)가 본문이다 — 좁은 화면(360px)에서 쪽이 넓게 보이게 여백을 줄인다.
          <section
            aria-label="원본 파일"
            className={`rounded-xl border border-slate-200 bg-white print:hidden ${isPdf ? "p-2 sm:p-4" : "p-4 sm:p-5"}`}
          >
            <PortfolioOriginalViewer src={originalSrc} fileName="포트폴리오" original={view.original} version={view.publishedAt} height="85vh" />
          </section>
        )}

        {view.kind === "file" && view.content && (
          <details open={!view.original} className="rounded-xl border border-slate-200 bg-white p-4 sm:p-5">
            <summary className="cursor-pointer text-sm font-semibold text-slate-800">
              {!view.original ? "포트폴리오 내용" : isPdf ? "텍스트로 보기" : "파일에서 뽑은 글 보기"}
            </summary>
            <pre className="mt-3 max-h-[48rem] overflow-y-auto text-sm leading-relaxed whitespace-pre-wrap text-slate-700">{view.content}</pre>
          </details>
        )}

        {view.kind === "url" && view.url && (
          <a
            href={view.url}
            target="_blank"
            rel="noopener noreferrer nofollow ugc"
            className="block rounded-xl border border-slate-200 bg-white p-5 hover:border-indigo-300 hover:shadow-sm"
          >
            <span className="block text-xs font-medium text-slate-500">포트폴리오 링크 · 새 탭에서 열립니다</span>
            <span className="mt-1 block truncate text-base font-semibold text-indigo-700">{view.url}</span>
            <span className="mt-1 block text-xs text-slate-500">외부 사이트입니다. CareerLoop가 내용을 확인하지 않았습니다.</span>
          </a>
        )}

        <p className="text-xs leading-relaxed text-slate-400 print:hidden">
          작성자가 직접 공개한 포트폴리오입니다. 내용은 작성자가 쓴 것이며, 작성자가 공개를 끄면 이 주소는 더 이상 열리지 않습니다.
        </p>
      </main>
      {shareChatAvailable(share) && <ShareChatWidget token={token} title={view.title} />}
    </>
  );
}
