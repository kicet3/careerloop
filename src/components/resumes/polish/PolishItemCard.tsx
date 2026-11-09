"use client";

import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import {
  polishItemAnchorMatches,
  polishItemFieldValue,
  type PolishItemState,
  type PolishItemSuggestion,
  polishItemValueText,
  samePolishItemValue,
} from "@/lib/domain/resume-polish";
import { DiffView } from "./DiffView";

/**
 * 항목 제안 카드: 프로젝트·경력 하나의 여러 칸을 한 번에 고치기(칸마다 전/후, 체크를 풀면 그 칸은 빼고 적용) 또는 새 항목 추가(새 항목 미리보기).
 * 적용 버튼 하나로 새 버전 하나를 만든다(서버가 고칠 칸 전부를 확인한다 — 하나라도 바뀌었으면 409).
 */
export function PolishItemCard({
  suggestion: s,
  state,
  current,
  excluded,
  onToggleField,
  dirty,
  applying,
  onApply,
  selected,
  onToggleSelect,
}: {
  suggestion: PolishItemSuggestion;
  state: PolishItemState;
  /** 고치기: 대상 항목의 저장된 지금 값(칸마다 바뀌었는지 본다). */
  current?: unknown;
  /** 체크를 푼 칸. */
  excluded: readonly string[];
  onToggleField?: (field: string) => void;
  dirty: boolean;
  applying: boolean;
  onApply: () => void;
  /** 전체 이력서 모드의 '선택 적용' 체크(없으면 체크 상자를 그리지 않는다). */
  selected?: boolean;
  onToggleSelect?: () => void;
}) {
  const isAdd = s.kind === "item-add";
  const live = state === "live";
  // 같은 자리에 다른 항목이 왔으면(순서 바꾸기·앞에 추가) 어느 칸도 적용할 수 없다.
  const anchored = isAdd || polishItemAnchorMatches(current, s.anchor);
  const fieldLive = (field: string, before: PolishItemSuggestion["changes"][number]["before"]) =>
    isAdd || (anchored && samePolishItemValue(polishItemFieldValue(current, field), before));
  const active = s.changes.filter((c) => isAdd || !excluded.includes(c.field));
  // 고치기는 바뀐 칸의 체크를 풀면 나머지를 적용할 수 있다(서버도 고를 칸만 확인한다).
  const someLive = s.changes.some((c) => fieldLive(c.field, c.before));
  const canApply = (isAdd ? live : state !== "applied") && active.length > 0 && active.every((c) => fieldLive(c.field, c.before));
  const blockedTitle = dirty ? "새 버전으로 저장하지 않은 변경이 있어요. 먼저 저장(새 버전)해 주세요." : undefined;
  return (
    <div
      className={cn("space-y-2 rounded-lg border px-3 py-2", selected ? "border-indigo-500 ring-2 ring-indigo-500/20" : "border-slate-200", !live && "opacity-70")}
      data-testid="polish-item-card"
    >
      <div className="flex items-start justify-between gap-2">
        <label className="flex items-start gap-2 text-xs font-medium text-slate-700">
          {onToggleSelect && (
            <input type="checkbox" className="mt-0.5" checked={!!selected} disabled={!canApply} onChange={onToggleSelect} aria-label={`${s.label} 선택`} />
          )}
          <span>
            <Badge tone={isAdd ? "positive" : "neutral"}>{isAdd ? "새 항목 추가" : `${s.changes.length}칸 한 번에`}</Badge> {s.label}
          </span>
        </label>
      </div>

      {isAdd ? (
        <dl className="grid gap-1 rounded-md border border-emerald-200 bg-emerald-50/40 px-3 py-2 text-sm">
          {s.changes.map((c) => (
            <div key={c.field} className="grid grid-cols-[5.5rem_1fr] gap-2">
              <dt className="text-[11px] font-medium text-slate-500">{c.label}</dt>
              <dd className="whitespace-pre-wrap text-slate-900">{polishItemValueText(c.after)}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <div className="space-y-2">
          {s.changes.map((c) => {
            const off = excluded.includes(c.field);
            const changed = !fieldLive(c.field, c.before);
            return (
              <div key={c.field} className={cn("space-y-1", off && "opacity-50")}>
                <label className="flex items-center gap-2 text-[11px] font-medium text-slate-600">
                  {onToggleField && s.changes.length > 1 && (
                    <input type="checkbox" checked={!off} disabled={state === "applied"} onChange={() => onToggleField(c.field)} aria-label={`${c.label} 적용`} />
                  )}
                  {c.label}
                  {changed && state !== "applied" && <span className="text-amber-700">제안 뒤 바뀐 칸</span>}
                  {c.flagged.length > 0 && <span className="text-amber-700">근거 확인 필요: {c.flagged.join(", ")}</span>}
                </label>
                <DiffView before={polishItemValueText(c.before)} after={polishItemValueText(c.after)} />
              </div>
            );
          })}
        </div>
      )}

      {s.reason && <p className="text-xs text-slate-500">{s.reason}</p>}
      <div className="flex flex-wrap items-center justify-between gap-1">
        <span className="flex flex-wrap gap-1">
          {state === "applied" && <Badge tone="positive">{isAdd ? "추가함" : "적용함"}</Badge>}
          {state === "stale" && (
            <Badge tone="neutral">{someLive && s.changes.length > 1 ? "제안 뒤 바뀐 칸이 있어요 — 그 칸을 빼면 적용할 수 있어요" : "제안 뒤 바뀐 항목 — 적용할 수 없어요"}</Badge>
          )}
          {state === "full" && <Badge tone="neutral">항목 수 상한이라 추가할 수 없어요</Badge>}
          {isAdd && s.flagged.length > 0 && <Badge tone="warning">근거 확인 필요 {s.flagged.join(", ")}</Badge>}
        </span>
        <Button size="sm" variant="secondary" disabled={!canApply || dirty || applying} title={blockedTitle} onClick={onApply}>
          {isAdd ? "추가(새 버전 저장)" : `적용(${active.length}칸 · 새 버전 저장)`}
        </Button>
      </div>
    </div>
  );
}
