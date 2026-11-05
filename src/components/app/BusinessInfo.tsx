import Link from "next/link";
import { cn } from "@/components/ui/cn";
import { BUSINESS, HOSTING_PROVIDER } from "@/lib/brand";

const FIELDS: [string, string][] = [
  ["대표자", BUSINESS.representative],
  ["사업자등록번호", BUSINESS.registrationNumber],
  ["주소", BUSINESS.address],
  ["이메일", BUSINESS.email],
  ["전화", BUSINESS.phone],
  ["호스팅", HOSTING_PROVIDER],
];

/**
 * 약관·개인정보 처리방침 링크(처리방침은 굵게 — 법 제30조②·작성지침) + 사업자 정보(상호 표기는 빼고, 채워진 항목만) + 저작권 표기.
 * 서버·클라이언트 어디서든 쓸 수 있는 표시 전용 컴포넌트.
 */
export function BusinessInfo({ className, compact = false }: { className?: string; compact?: boolean }) {
  const year = new Date().getFullYear();
  const items = FIELDS.filter(([, v]) => v.trim() !== "");
  return (
    <div className={cn("text-xs leading-relaxed text-slate-500", className)}>
      <p className={cn("mb-1 flex flex-wrap gap-x-3", compact && "gap-x-2")}>
        <Link href="/terms" className="hover:text-slate-800 hover:underline">
          이용약관
        </Link>
        <Link href="/privacy" className="font-bold text-slate-700 hover:text-slate-900 hover:underline">
          개인정보 처리방침
        </Link>
      </p>
      {items.length > 0 && (
        <p className={cn("mb-1 flex flex-wrap gap-x-3 gap-y-0.5", compact && "flex-col gap-x-0")}>
          {items.map(([label, value]) => (
            <span key={label} className="break-words">
              {label}: {value}
            </span>
          ))}
        </p>
      )}
      {/* 연도는 렌더 시각 기준이라 서버(UTC)와 브라우저(KST)가 1월 1일 0~9시(KST)에 다를 수 있다 — 그 차이만 허용한다. */}
      <p suppressHydrationWarning>
        © {year} {BUSINESS.name}. All rights reserved.
      </p>
    </div>
  );
}
