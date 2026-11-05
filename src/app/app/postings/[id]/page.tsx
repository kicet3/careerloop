import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PostingMatchCard } from "@/components/match/PostingMatchCard";
import { PostingDetail } from "@/components/postings/PostingDetail";
import { requireUser } from "@/lib/auth/session";
import { getPosting, listPostingLinks } from "@/lib/postings/service";
import { isSharedPostingVisible } from "@/lib/postings/shared";
import { listProviderOptions, pickDefault } from "@/lib/providers/options";

export const metadata: Metadata = { title: "공고" };
export const dynamic = "force-dynamic";

/** 요청 시각(서버 컴포넌트는 요청마다 한 번 렌더된다). 마감 배지의 첫 렌더 기준. */
const requestTime = () => Date.now();

export default async function PostingPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ structure?: string | string[] }>;
}) {
  const { id } = await params;
  const { structure } = await searchParams;
  const user = await requireUser(`/app/postings/${encodeURIComponent(id)}`);
  const posting = await getPosting(user.id, id);
  if (!posting) notFound();
  const [links, providers, sharedVisible] = await Promise.all([
    listPostingLinks(user.id, id),
    listProviderOptions(),
    // 관리자가 숨긴 공용 공고면 '공고 찾기에서 보기' 링크를 숨긴다(관리자는 숨긴 공고도 열 수 있다).
    posting.sharedPostingId && user.role !== "admin" ? isSharedPostingVisible(posting.sharedPostingId) : Promise.resolve(true),
  ]);
  const aiAvailable = pickDefault(providers) !== null;
  return (
    <PostingDetail
      posting={posting}
      links={links}
      sharedVisible={sharedVisible}
      serverNow={requestTime()}
      aiAvailable={aiAvailable}
      // 직접 추가 폼의 'AI로 섹션 정리'(?structure=1): 상세 화면이 열리자마자 정리를 시작한다.
      autoStructure={aiAvailable && structure === "1"}
      // '내 경력과 대조'(match 담당): 스스로 GET /api/postings/[id]/match를 부른다.
      matchCard={<PostingMatchCard postingId={posting.id} />}
    />
  );
}
