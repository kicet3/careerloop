import { cn } from "@/components/ui/cn";
import { BUSINESS } from "@/lib/brand";

const FIELDS: [string, string][] = [
  ["대표자", BUSINESS.representative],
  ["사업자등록번호", BUSINESS.registrationNumber],
  ["주소", BUSINESS.address],
  ["이메일", BUSINESS.email],
  ["전화", BUSINESS.phone],
];

/** 사업자 정보 + 저작권 표기. 값이 빈 항목은 그리지 않는다. 서버·클라이언트 어디서든 쓸 수 있는 표시 전용 컴포넌트. */
export function BusinessInfo({ className, compact = false }: { className?: string; compact?: boolean }) {
  const year = new Date().getFullYear();
  const items: [string, string][] = [["상호", BUSINESS.name], ...FIELDS.filter(([, v]) => v.trim() !== "")];
  return (
    <div className={cn("text-xs leading-relaxed text-slate-500", className)}>
      <p className={cn("flex flex-wrap gap-x-3 gap-y-0.5", compact && "flex-col gap-x-0")}>
        {items.map(([label, value]) => (
          <span key={label} className="break-words">
            {label}: {value}
          </span>
        ))}
      </p>
      {/* 연도는 렌더 시각 기준이라 서버(UTC)와 브라우저(KST)가 1월 1일 0~9시(KST)에 다를 수 있다 — 그 차이만 허용한다. */}
      <p className="mt-1" suppressHydrationWarning>
        © {year} {BUSINESS.name}. All rights reserved.
      </p>
    </div>
  );
}
