import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";

export default function ResumeNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">이력서를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-slate-500">삭제되었거나 다른 계정의 이력서입니다.</p>
      <Link href="/app/resumes" className={buttonClass("primary", "md", "mt-6")}>
        이력서 목록으로
      </Link>
    </div>
  );
}
