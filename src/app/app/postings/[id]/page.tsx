import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PostingMatchCard } from "@/components/match/PostingMatchCard";
import { PostingDetail } from "@/components/postings/PostingDetail";
import { requireUser } from "@/lib/auth/session";
import { getPosting, listPostingLinks } from "@/lib/postings/service";

export const metadata: Metadata = { title: "공고" };
export const dynamic = "force-dynamic";

/** 요청 시각(서버 컴포넌트는 요청마다 한 번 렌더된다). 마감 배지의 첫 렌더 기준. */
const requestTime = () => Date.now();

export default async function PostingPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const user = await requireUser(`/app/postings/${encodeURIComponent(id)}`);
  const posting = await getPosting(user.id, id);
  if (!posting) notFound();
  const links = await listPostingLinks(user.id, id);
  return (
    <PostingDetail
      posting={posting}
      links={links}
      serverNow={requestTime()}
      // '내 경력과 대조'(match 담당): 스스로 GET /api/postings/[id]/match를 부른다.
      matchCard={<PostingMatchCard postingId={posting.id} />}
    />
  );
}
