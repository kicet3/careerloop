"use client";
/**
 * 그래프 화면 오른쪽 패널: "그래프 만들기"(경험 대화·이력서 가져오기 → 변경안) | "그래프에 묻기"(그래프 근거 Q&A, 출처 표기) 탭.
 * 두 패널을 모두 마운트한 채 hidden으로 숨긴다 — 입력·폴링 상태가 유지되고, 그래프 만들기의 GRAPH_CHAT_ASK_EVENT 리스너도 살아 있다.
 * 체크리스트·그래프에 묻기의 '채우기' 버튼(askGraphChat)이 오면 그래프 만들기 탭으로 바꾼다.
 */
import { useEffect, useState } from "react";
import { cn } from "@/components/ui";
import type { UploadLimits } from "@/lib/ingest/upload-limits";
import { GRAPH_CHAT_ASK_EVENT } from "./api";
import { GraphChatPanel } from "./GraphChatPanel";
import { GraphQaPanel } from "./GraphQaPanel";

export type AssistantTab = "build" | "qa";

const TABS: [AssistantTab, string][] = [
  ["build", "그래프 만들기"],
  ["qa", "그래프에 묻기"],
];

export function GraphAssistantPanel({
  initialMessage,
  initialTab,
  uploadLimits,
}: {
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
    <div className="min-w-0 space-y-3">
      <div role="tablist" aria-label="그래프 도우미" className="inline-flex rounded-lg bg-slate-100 p-0.5">
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
              "rounded-md px-3 py-1.5 text-sm font-medium",
              tab === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
            )}
          >
            {text}
          </button>
        ))}
      </div>
      <div id="graph-assistant-panel-build" role="tabpanel" aria-labelledby="graph-assistant-tab-build" hidden={tab !== "build"}>
        <GraphChatPanel initialMessage={initialMessage} uploadLimits={uploadLimits} />
      </div>
      <div id="graph-assistant-panel-qa" role="tabpanel" aria-labelledby="graph-assistant-tab-qa" hidden={tab !== "qa"}>
        <GraphQaPanel />
      </div>
    </div>
  );
}
