import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { PostingCaptureButton } from "@/components/postings/PostingCapture";
import { KeyFacts, PostingSections } from "@/components/postings/PostingSections";
import { SharedPostingActions } from "@/components/postings/SharedPostingActions";
import { SourceLink } from "@/components/postings/SourceLink";
import { Card, CardBody, CardHeader } from "@/components/ui/Card";
import { requireUser } from "@/lib/auth/session";
import { hasStructureContent } from "@/lib/postings/structure";
import { getSharedPosting } from "@/lib/postings/shared";
import { platformLabel } from "@/lib/postings/url";
import { formatKstDate, kstDate } from "@/lib/time/kst";

export const metadata: Metadata = { title: "공고 찾기" };
export const dynamic = "force-dynamic";

const requestTime = () => Date.now();

export default async function SharedPostingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/app/postings/explore/${encodeURIComponent(id)}`);
  const isAdmin = user.role === "admin";
  // 관리자는 숨긴 공고도 열어 '다시 공개'할 수 있다.
  const posting = await getSharedPosting(id.slice(0, 64), user.id, { includeHidden: isAdmin });
  if (!posting) notFound();
  const now = requestTime();
  const s = posting.structured;
  const raw = posting.sourceText || posting.jdText;
  // 직접 입력으로 만든 공용 공고: 원문 주소가 없다(원문 링크·캡처·다시 가져오기 없음).
  const manual = !posting.url;
  return (
    <div className="space-y-6">
      <Link href="/app/postings/explore" className="inline-flex items-center gap-1 text-sm text-slate-500 hover:text-slate-800">
        <span aria-hidden>←</span> 공고 찾기
      </Link>
      {posting.hidden && (
        <p role="status" className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900">
          관리자가 숨긴 공고입니다. 다른 사용자에게는 보이지 않고, 같은 링크를 가져와도 재사용되지 않습니다.
        </p>
      )}

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium text-slate-500">{posting.company}</p>
          <h1 className="mt-0.5 text-2xl font-bold tracking-tight break-words text-slate-900">{posting.roleTitle}</h1>
          <p className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-slate-500">
            {posting.platform && <span>{platformLabel(posting.platform)}</span>}
            <span>{formatKstDate(kstDate(posting.fetchedAt), { withYear: true })} 기준</span>
            {posting.importerCount > 0 && <span>{posting.importerCount}명이 담음</span>}
            {manual && <span>직접 입력한 공고</span>}
            <SourceLink url={posting.url} />
            {posting.url && (
              <PostingCaptureButton
                apiBase={`/api/shared-postings/${encodeURIComponent(posting.id)}`}
                initial={posting.capture}
                sourceUrl={posting.url}
                title={`${posting.company} · ${posting.roleTitle}`}
              />
            )}
          </p>
        </div>
        <SharedPostingActions
          sharedId={posting.id}
          url={posting.url}
          myPostingId={posting.myPostingId}
          isAdmin={isAdmin}
          hidden={!!posting.hidden}
        />
      </div>

      <Card>
        <CardHeader title="핵심 정보" />
        <CardBody>
          <KeyFacts posting={posting} salary={s?.conditions.salary ?? ""} now={now} />
        </CardBody>
      </Card>

      <div className="space-y-4">
        <h2 className="text-base font-semibold text-slate-900">공고 내용</h2>
        {s && hasStructureContent(s) ? (
          <PostingSections structure={s} aiSummary={s.source === "llm"} />
        ) : (
          <p className="text-sm text-slate-500">구역으로 정리된 내용이 없습니다. 원문을 확인하세요.</p>
        )}
        <p className="text-xs text-slate-500">
          {manual
            ? "사용자가 직접 입력한 공고입니다. 지원 전에 회사 채용 페이지에서 조건과 마감 시각을 확인하세요."
            : <>AI가 원문 문구를 구역별로 옮긴 내용입니다. 지원 전에 원문에서 조건과 마감 시각을 확인하세요. 오래된 내용이면 &lsquo;다시 가져오기&rsquo;로 갱신할 수 있습니다.</>}
        </p>
        {raw.trim() && (
          <details className="rounded-xl border border-slate-200 bg-white p-4 text-sm shadow-sm">
            <summary className="cursor-pointer font-medium text-slate-800">{manual ? "공고 본문 보기" : "가져온 원문 보기"}</summary>
            <p className="mt-3 max-h-[480px] overflow-auto leading-relaxed break-words whitespace-pre-wrap text-slate-700">{raw}</p>
          </details>
        )}
      </div>
    </div>
  );
}
