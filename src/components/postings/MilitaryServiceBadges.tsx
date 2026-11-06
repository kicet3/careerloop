import { Badge } from "@/components/ui/Badge";
import { cn } from "@/components/ui/cn";
import { militaryServiceLabels, type MilitaryServiceTag } from "@/lib/domain/military-service";

/** 병역특례 태그("전문연 가능", "산업기능요원 가능(보충역)", "병역특례 가능"). 태그가 없으면 그리지 않는다. */
export function MilitaryServiceBadges({ tags, className }: { tags: readonly MilitaryServiceTag[] | null | undefined; className?: string }) {
  const labels = militaryServiceLabels(tags);
  if (labels.length === 0) return null;
  return (
    <ul className={cn("flex flex-wrap gap-1.5", className)} aria-label="병역특례">
      {labels.map((l) => (
        <li key={l}>
          <Badge tone="info" className="max-w-full">
            <span className="min-w-0 truncate" title={`${l} — 공고 본문의 병역특례 문구로 자동 판단했습니다. 지원 전에 회사에 확인하세요.`}>
              {l}
            </span>
          </Badge>
        </li>
      ))}
    </ul>
  );
}
