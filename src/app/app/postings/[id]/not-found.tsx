import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";

export default function PostingNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">공고를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-slate-500">삭제되었거나 다른 계정의 공고입니다.</p>
      <Link href="/app/postings" className={buttonClass("primary", "md", "mt-6")}>
        공고 보관함으로
      </Link>
    </div>
  );
}
