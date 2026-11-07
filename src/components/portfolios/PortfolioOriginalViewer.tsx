/**
 * 보관한 포트폴리오 원본을 그대로 보여 준다(서버·클라이언트 공용, 상태 없음). 내용은 소유자만 읽는 GET /api/portfolios/[id]/original.
 * - PDF: 브라우저 PDF 보기(iframe). 모바일처럼 iframe PDF를 그리지 못하는 기기는 새 탭·내려받기 안내(PortfolioPdfFrame). 이미지: img. DOCX: 서버가 바꾼 HTML을 sandbox iframe(스크립트 불가)으로.
 * - HWP·HWPX·HTML·TXT·MD: 화면에 원본을 그리지 않는다(뽑은 글은 상세 화면이 따로 보인다) — 원본 내려받기만.
 */
import { buttonClass } from "@/components/ui/Button";
import type { PortfolioOriginalInfo } from "@/lib/domain/portfolios";
import { PortfolioPdfFrame } from "./PortfolioPdfFrame";

// FileDrop.formatBytes와 같은 꼴(그 모듈은 클라이언트 전용이라 서버 화면에서 부를 수 없다).
function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 원본 주소. version(수정 시각)을 붙여 내용을 바꾼 뒤 iframe·img가 옛 응답을 다시 쓰지 않게 한다. */
export function portfolioOriginalUrl(portfolioId: string, opts: { download?: boolean; html?: boolean; version?: number } = {}): string {
  const q = new URLSearchParams();
  if (opts.download) q.set("download", "1");
  else if (opts.html) q.set("view", "html");
  if (opts.version) q.set("v", String(opts.version));
  const qs = q.toString();
  return `/api/portfolios/${encodeURIComponent(portfolioId)}/original${qs ? `?${qs}` : ""}`;
}

export function PortfolioOriginalViewer({
  portfolioId,
  fileName,
  original,
  version,
  /** 보기 칸 높이(PDF·DOCX). 목록 카드에서는 낮게. */
  height = "80vh",
}: {
  portfolioId: string;
  fileName: string | null;
  original: PortfolioOriginalInfo;
  /** 포트폴리오 수정 시각(주소에 붙인다). */
  version?: number;
  height?: string;
}) {
  const name = fileName ?? "포트폴리오";
  const src = portfolioOriginalUrl(portfolioId, { version });
  return (
    <div className="space-y-2">
      {original.view === "pdf" && (
        <PortfolioPdfFrame src={src} downloadHref={portfolioOriginalUrl(portfolioId, { download: true, version })} title={`${name} 원본`} height={height} />
      )}
      {original.view === "image" && (
        // 소유자만 읽는 같은 출처 라우트라 next/image 최적화(공개 캐시)를 쓰지 않는다.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt={`${name} 원본`} className="mx-auto block h-auto max-w-full rounded-lg border border-slate-200 bg-white" />
      )}
      {original.view === "docx" && (
        <iframe
          src={portfolioOriginalUrl(portfolioId, { html: true, version })}
          title={`${name} 미리보기`}
          sandbox=""
          className="w-full rounded-lg border border-slate-200 bg-white"
          style={{ height }}
          referrerPolicy="no-referrer"
        />
      )}
      {(original.view === "text" || original.view === "download") && (
        <p className="text-sm text-slate-600">
          이 형식은 화면에서 원본 그대로 열지 않습니다. 원본을 내려받아 확인해 주세요{original.view === "text" ? " — 뽑아 둔 글은 아래에 있습니다" : ""}.
        </p>
      )}
      <div className="flex flex-wrap items-center gap-2 text-xs text-slate-500">
        <a href={portfolioOriginalUrl(portfolioId, { download: true, version })} className={buttonClass("secondary", "sm")}>
          원본 내려받기
        </a>
        {(original.view === "pdf" || original.view === "image") && (
          <a href={src} target="_blank" rel="noopener noreferrer" className={buttonClass("ghost", "sm")}>
            새 탭에서 열기
          </a>
        )}
        <span>
          {name} · {formatBytes(original.size)}
        </span>
      </div>
    </div>
  );
}
