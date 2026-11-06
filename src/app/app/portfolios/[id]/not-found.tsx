import Link from "next/link";
import { buttonClass } from "@/components/ui/Button";

export default function PortfolioNotFound() {
  return (
    <div className="mx-auto max-w-md py-16 text-center">
      <h1 className="text-xl font-bold text-slate-900">포트폴리오를 찾을 수 없습니다</h1>
      <p className="mt-2 text-sm text-slate-500">삭제되었거나 다른 계정의 포트폴리오입니다.</p>
      <Link href="/app/portfolios" className={buttonClass("primary", "md", "mt-6")}>
        포트폴리오 목록으로
      </Link>
    </div>
  );
}
