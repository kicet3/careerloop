"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { Badge, type BadgeTone } from "@/components/ui/Badge";
import { buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { experienceCategory } from "@/lib/domain/experience-categories";
import type { CareerGraph } from "@/lib/domain/graph";
import {
  assessExperienceChecklist,
  type CategoryBest,
  type CategoryState,
  type CategoryStatus,
  categoryAskMessage,
} from "@/lib/graph/completeness";
import { askGraphChat, graphChatHref } from "./api";

const STATE_BADGE: Record<CategoryState, { tone: BadgeTone; text: string }> = {
  missing: { tone: "neutral", text: "없음" },
  partial: { tone: "warning", text: "일부" },
  done: { tone: "positive", text: "완료" },
};

/**
 * 경험 체크리스트: 자소서·이력서에 꼭 필요한 경험 카테고리를 그래프가 최소한으로 채웠는지 보여 준다.
 * 그래프 상태는 CareerGraphView가 갖고 있어 편집·채팅 적용 뒤 자동으로 다시 계산된다.
 * '채팅으로 채우기'는 같은 화면의 채팅 입력을 바로 채운다(없으면 ?ask= 주소로 이동). 보내기는 사용자가 누른다.
 * 필수가 남은 동안 추천 항목은 접어 두고(작은 화면에서 그래프·채팅을 밀어내지 않게), 다 채우면 전체를 접는다.
 */
export function ExperienceChecklist({ graph, onFix }: { graph: CareerGraph; onFix: (best: CategoryBest) => void }) {
  const checklist = useMemo(() => assessExperienceChecklist(graph), [graph]);
  const [expanded, setExpanded] = useState(false);
  const [showRecommended, setShowRecommended] = useState(false);
  const required = checklist.categories.filter((c) => c.required);
  const recommended = checklist.categories.filter((c) => !c.required);
  const collapsed = checklist.complete && !expanded;
  const recommendedVisible = checklist.complete || showRecommended;
  const valuesDone = checklist.categories.find((c) => c.id === "values")?.state === "done";

  return (
    <Card id="experience-checklist" className="scroll-mt-20 overflow-hidden">
      <section aria-labelledby="experience-checklist-title">
        <div className="space-y-3 px-4 py-4 sm:px-5">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div className="min-w-0">
              <h2 id="experience-checklist-title" className="text-base font-semibold text-slate-900">
                경험 체크리스트
              </h2>
              <p className="mt-0.5 text-sm text-slate-500">
                {checklist.complete
                  ? `자소서·이력서에 필요한 필수 경험을 모두 채웠어요.${valuesDone ? "" : " 성장과정 문항이 있다면 추천의 ‘성장과정·가치관’도 채워 두세요."}`
                  : "자소서와 이력서에 꼭 필요한 경험이에요. 필수 항목은 최소한 채워 주세요."}
              </p>
            </div>
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium whitespace-nowrap text-slate-700">
                필수 경험 {checklist.requiredDone}/{checklist.requiredTotal} · 추천 {checklist.recommendedDone}/{checklist.recommendedTotal}
              </span>
              {checklist.complete && (
                <button
                  type="button"
                  onClick={() => setExpanded((v) => !v)}
                  aria-expanded={expanded}
                  aria-controls="experience-checklist-body"
                  className="text-sm font-medium text-indigo-700 hover:underline"
                >
                  {expanded ? "접기" : "펼치기"}
                </button>
              )}
            </div>
          </div>
          <div
            className="h-2 overflow-hidden rounded-full bg-slate-100"
            role="progressbar"
            aria-label="필수 경험 진행률"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={checklist.progress}
          >
            <div
              className={cn("h-full rounded-full transition-[width]", checklist.complete ? "bg-emerald-500" : "bg-indigo-500")}
              style={{ width: `${checklist.progress}%` }}
            />
          </div>
        </div>

        {!collapsed && (
          <div
            id="experience-checklist-body"
            className={cn("grid gap-px border-t border-slate-100 bg-slate-100", recommendedVisible && "lg:grid-cols-2")}
          >
            <Group title="필수" items={required} onFix={onFix} />
            {recommendedVisible && <Group title="추천" items={recommended} onFix={onFix} />}
          </div>
        )}
        {!checklist.complete && (
          <div className="border-t border-slate-100 px-4 py-2 sm:px-5">
            <button
              type="button"
              onClick={() => setShowRecommended((v) => !v)}
              aria-expanded={showRecommended}
              aria-controls="experience-checklist-body"
              className="text-sm font-medium text-indigo-700 hover:underline"
            >
              {showRecommended ? "추천 항목 접기" : `추천 ${recommended.length}개 보기 (${checklist.recommendedDone}/${checklist.recommendedTotal} 완료)`}
            </button>
          </div>
        )}
      </section>
    </Card>
  );
}

function Group({ title, items, onFix }: { title: string; items: CategoryStatus[]; onFix: (best: CategoryBest) => void }) {
  const done = items.filter((c) => c.state === "done").length;
  return (
    <div className="bg-white">
      <h3 className="px-4 pt-3 text-xs font-semibold tracking-wide text-slate-500 sm:px-5">
        {title} {done}/{items.length}
      </h3>
      <ul className="divide-y divide-slate-100">
        {items.map((s) => (
          <Row key={s.id} status={s} onFix={onFix} />
        ))}
      </ul>
    </div>
  );
}

function Row({ status: s, onFix }: { status: CategoryStatus; onFix: (best: CategoryBest) => void }) {
  const cat = experienceCategory(s.id);
  const badge = STATE_BADGE[s.state];
  const ask = categoryAskMessage(s);
  const done = s.state === "done";
  return (
    <li className="px-4 py-3 sm:px-5">
      <div className="flex items-start gap-2">
        <Badge tone={badge.tone} className="mt-0.5 shrink-0">
          {badge.text}
        </Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold break-words text-slate-900">{cat.name}</p>
          {!done && <p className="text-sm text-slate-600">{cat.description}</p>}
          {!done && <p className="mt-0.5 hidden text-xs text-slate-400 sm:block">쓰이는 문항: {cat.coverLetterItems.join(", ")}</p>}
          <p className={cn("mt-1 text-xs break-words", done ? "text-emerald-700" : "text-slate-600")}>{s.hint}</p>
          {!done && (
            <div className="mt-2 flex flex-wrap items-center gap-2">
              {s.best && (
                <button
                  type="button"
                  onClick={() => onFix(s.best!)}
                  className="max-w-full truncate rounded-md border border-slate-200 px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                  title={s.best.fix === "link" ? "연결 추가 열기" : "편집 열기"}
                >
                  {s.best.fix === "link" ? "연결하기" : "편집"}: {s.best.nodeName}
                </button>
              )}
              <Link
                href={graphChatHref(ask)}
                onClick={(e) => {
                  if (askGraphChat(ask)) e.preventDefault();
                }}
                className={buttonClass("secondary", "sm")}
              >
                채팅으로 채우기
              </Link>
            </div>
          )}
        </div>
      </div>
    </li>
  );
}
