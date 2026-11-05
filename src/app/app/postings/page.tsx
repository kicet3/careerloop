import type { Metadata } from "next";
import { PostingsView } from "@/components/postings/PostingsView";
import { requireUser } from "@/lib/auth/session";
import { listRecentImports } from "@/lib/postings/imports";
import { listPostings } from "@/lib/postings/service";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "공고 보관함" };
export const dynamic = "force-dynamic";

/** 요청 시각(서버 컴포넌트는 요청마다 한 번 렌더된다). 마감 배지의 첫 렌더 기준. */
const requestTime = () => Date.now();

export default async function PostingsPage() {
  const user = await requireUser("/app/postings");
  const [items, imports, providers] = await Promise.all([listPostings(user.id), listRecentImports(user.id), listProviderOptions()]);
  // 마감 배지는 서버 시각으로 처음 그려 하이드레이션 결과가 같게 한다(브라우저에서 1분마다 갱신).
  return <PostingsView initialItems={items} initialImports={imports} serverNow={requestTime()} aiAvailable={pickDefault(providers) !== null} />;
}
