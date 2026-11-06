import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { ExploreView } from "@/components/postings/ExploreView";
import { requireUser } from "@/lib/auth/session";
import { COMPANY_OPTIONS_DEFAULT_LIMIT } from "@/lib/domain/company";
import { exploreSearchParams, parseExploreSearchParams } from "@/lib/domain/shared-postings";
import { listRecentImports } from "@/lib/postings/imports";
import { listSharedCompanyOptions, listSharedPostingsPage } from "@/lib/postings/shared";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "공고 찾기" };
export const dynamic = "force-dynamic";

/** 요청 시각(마감 배지의 첫 렌더 기준). */
const requestTime = () => Date.now();

/**
 * 공고 찾기: 검색 조건·쪽(?q=&company=키&company=키&role=&tech=&deadline=&military=&page=)을 주소로 받아 한 쪽 12개를 서버에서 읽는다.
 * '회사' 필터의 처음 목록(숨기지 않은 공용 공고의 회사 중 공고 수 많은 것 + 고른 회사)도 함께 읽는다 — 입력해 찾는 것은 GET /api/shared-postings/companies.
 * 최근 가져오기·AI 엔진은 '공고 추가'(보관함과 같은 추가 입력)용이다.
 */
export default async function ExplorePage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const user = await requireUser("/app/postings/explore");
  const isAdmin = user.role === "admin";
  const parsed = parseExploreSearchParams(await searchParams);
  // 숨긴 공고 목록은 관리자만(일반 사용자의 hidden=only는 무시한다).
  const filters = isAdmin ? parsed.filters : { ...parsed.filters, hiddenOnly: undefined };
  const now = requestTime();
  const [list, companyOptions, imports, providers] = await Promise.all([
    listSharedPostingsPage({ ...filters, hidden: filters.hiddenOnly ? "only" : undefined, page: parsed.page, viewerId: user.id, now }),
    listSharedCompanyOptions({ limit: COMPANY_OPTIONS_DEFAULT_LIMIT, include: filters.companies }),
    listRecentImports(user.id),
    listProviderOptions(),
  ]);
  if (list.page !== parsed.page) {
    const qs = exploreSearchParams(filters, list.page);
    redirect(`/app/postings/explore${qs ? `?${qs}` : ""}`);
  }
  return (
    <ExploreView
      list={list}
      filters={filters}
      companyOptions={companyOptions}
      serverNow={now}
      isAdmin={isAdmin}
      initialImports={imports}
      aiAvailable={pickDefault(providers) !== null}
    />
  );
}
