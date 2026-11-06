import type { Metadata } from "next";
import { ExploreView } from "@/components/postings/ExploreView";
import { requireUser } from "@/lib/auth/session";
import { listRecentImports } from "@/lib/postings/imports";
import { listSharedPostings } from "@/lib/postings/shared";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "공고 찾기" };
export const dynamic = "force-dynamic";

/** 요청 시각(마감 배지의 첫 렌더 기준). */
const requestTime = () => Date.now();

export default async function ExplorePage() {
  const user = await requireUser("/app/postings/explore");
  // 첫 화면은 기본 조건(마감 전)과 같게 읽는다 — 화면의 필터 기본값(EMPTY_EXPLORE_FILTERS)과 맞춘다.
  // 최근 가져오기·AI 엔진은 '공고 추가'(보관함과 같은 추가 입력)용이다.
  const [initial, imports, providers] = await Promise.all([
    listSharedPostings({ deadline: "open", viewerId: user.id }),
    listRecentImports(user.id),
    listProviderOptions(),
  ]);
  return (
    <ExploreView
      initial={initial}
      serverNow={requestTime()}
      isAdmin={user.role === "admin"}
      initialImports={imports}
      aiAvailable={pickDefault(providers) !== null}
    />
  );
}
