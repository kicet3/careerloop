"use client";
/**
 * 그래프 화면: 위에 "경험 정리하기"(경험 대화·이력서 가져오기 → 변경안) | "경험 질문하기"(그래프 근거 Q&A, 출처 표기) 탭,
 * 아래 왼쪽에 고른 탭의 채팅, 오른쪽(aside)에 그래프 요소. 좁은 화면에서는 채팅 아래로 내려간다.
 * 두 패널을 모두 마운트한 채 hidden으로 숨긴다 — 입력·폴링 상태가 유지되고, 그래프 만들기의 GRAPH_CHAT_ASK_EVENT 리스너도 살아 있다.
 * 체크리스트·그래프에 묻기의 '채우기' 버튼(askGraphChat)이 오면 그래프 만들기 탭으로 바꾼다.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import type { UploadLimits } from "@/lib/ingest/upload-limits";
import { GRAPH_CHAT_ASK_EVENT } from "./api";
import { GraphChatPanel } from "./GraphChatPanel";
import { GraphQaPanel } from "./GraphQaPanel";

export type AssistantTab = "build" | "qa";

const TABS: [AssistantTab, string][] = [
  ["build", "경험 정리하기"],
  ["qa", "경험 질문하기"],
];

export function GraphAssistantPanel({
  initialMessage,
  initialTab,
  uploadLimits,
  aside,
}: {
  aside?: ReactNode;
  initialMessage?: string;
  initialTab?: AssistantTab;
  uploadLimits?: UploadLimits;
}) {
  const [tab, setTab] = useState<AssistantTab>(initialMessage ? "build" : (initialTab ?? "build"));

  useEffect(() => {
    const onAsk = () => setTab("build");
    window.addEventListener(GRAPH_CHAT_ASK_EVENT, onAsk);
    return () => window.removeEventListener(GRAPH_CHAT_ASK_EVENT, onAsk);
  }, []);

  return (
    <div className="min-w-0 space-y-4">
      <div role="tablist" aria-label="경력 그래프 도우미" className="flex gap-1 border-b border-slate-200">
        {TABS.map(([key, text]) => (
          <button
            key={key}
            id={`graph-assistant-tab-${key}`}
            type="button"
            role="tab"
            aria-selected={tab === key}
            aria-controls={`graph-assistant-panel-${key}`}
            onClick={() => setTab(key)}
            className={cn(
              "-mb-px border-b-2 px-4 py-2.5 text-sm font-semibold",
              tab === key ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-900",
            )}
          >
            {text}
          </button>
        ))}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(30rem,46%)_minmax(0,1fr)] xl:items-start">
        <div className="min-w-0">
          <div id="graph-assistant-panel-build" role="tabpanel" aria-labelledby="graph-assistant-tab-build" hidden={tab !== "build"}>
            <GraphChatPanel initialMessage={initialMessage} uploadLimits={uploadLimits} />
          </div>
          <div id="graph-assistant-panel-qa" role="tabpanel" aria-labelledby="graph-assistant-tab-qa" hidden={tab !== "qa"}>
            <GraphQaPanel />
          </div>
        </div>
        {aside && <div className="min-w-0 space-y-6">{aside}</div>}
      </div>
    </div>
  );
}
