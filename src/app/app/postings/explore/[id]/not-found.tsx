import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";

export default function SharedPostingNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">공고를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-slate-500">공고 찾기에서 내려간 공고입니다.</p>
      <Link href="/app/postings/explore" className={buttonClass("primary", "md", "mt-6")}>
        공고 찾기로
      </Link>
    </div>
  );
}
