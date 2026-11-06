import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PostingsView } from "@/components/postings/PostingsView";
import { requireUser } from "@/lib/auth/session";
import { parsePostingSearchParams, postingSearchParams } from "@/lib/postings/filter";
import { listRecentImports } from "@/lib/postings/imports";
import { listPostingsPage } from "@/lib/postings/service";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "공고 보관함" };
export const dynamic = "force-dynamic";

/** 요청 시각(서버 컴포넌트는 요청마다 한 번 렌더된다). 마감 배지·마감 임박 정렬의 기준. */
const requestTime = () => Date.now();

/** 공고 보관함: 검색·상태·정렬·마감 임박·쪽(?q=&status=&sort=&soon=1&page=)을 주소로 받아 한 쪽 12개를 서버에서 읽는다. */
export default async function PostingsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser("/app/postings");
  const { filters, sort, page } = parsePostingSearchParams(await searchParams);
  const now = requestTime();
  const [list, imports, providers] = await Promise.all([
    listPostingsPage(user.id, { filters, sort, page, now }),
    listRecentImports(user.id),
    listProviderOptions(),
  ]);
  // 쪽 수를 넘는 ?page=는 마지막 쪽 주소로 맞춘다(목록은 이미 마지막 쪽으로 읽었다).
  if (list.page !== page) {
    const qs = postingSearchParams(filters, sort, list.page);
    redirect(`/app/postings${qs ? `?${qs}` : ""}`);
  }
  // 마감 배지는 서버 시각으로 처음 그려 하이드레이션 결과가 같게 한다(브라우저에서 1분마다 갱신).
  return (
    <PostingsView
      list={list}
      filters={filters}
      sort={sort}
      initialImports={imports}
      serverNow={now}
      aiAvailable={pickDefault(providers) !== null}
    />
  );
}
