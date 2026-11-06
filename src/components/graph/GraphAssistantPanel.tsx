"use client";
/**
 * 그래프 화면의 채팅 도우미: "경험 정리하기"(경험 대화·이력서 가져오기 → 변경안) | "경험 질문하기"(그래프 근거 Q&A, 출처 표기) 탭.
 * 배치는 children(render prop)이 정한다 — GraphWorkspace가 탭 줄은 위 전체 폭에, 탭 내용은 왼쪽 열에 둔다.
 * 두 패널을 모두 마운트한 채 hidden으로 숨긴다 — 입력·폴링 상태가 유지되고, 그래프 만들기의 GRAPH_CHAT_ASK_EVENT 리스너도 살아 있다.
 * 체크리스트·그래프에 묻기의 '채우기' 버튼(askGraphChat), 프로젝트 상세의 '대화로 구조화하기'(openProjectChat)가 오면 그래프 만들기 탭으로 바꾼다.
 */
import { useEffect, useState, type ReactNode } from "react";
import { cn } from "@/components/ui";
import type { UploadLimits } from "@/lib/ingest/upload-limits";
import { GRAPH_CHAT_ASK_EVENT, GRAPH_CHAT_PROJECT_EVENT } from "./api";
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
  children,
}: {
  initialMessage?: string;
  initialTab?: AssistantTab;
  uploadLimits?: UploadLimits;
  /** 탭 줄과 탭 내용을 받아 화면에 배치한다(그래프 화면: 위 탭, 왼쪽 채팅). 주지 않으면 탭 위·내용 아래로 쌓는다. */
  children?: (parts: { tabs: ReactNode; panels: ReactNode }) => ReactNode;
}) {
  const [tab, setTab] = useState<AssistantTab>(initialMessage ? "build" : (initialTab ?? "build"));

  useEffect(() => {
    const onAsk = () => setTab("build");
    window.addEventListener(GRAPH_CHAT_ASK_EVENT, onAsk);
    window.addEventListener(GRAPH_CHAT_PROJECT_EVENT, onAsk);
    return () => {
      window.removeEventListener(GRAPH_CHAT_ASK_EVENT, onAsk);
      window.removeEventListener(GRAPH_CHAT_PROJECT_EVENT, onAsk);
    };
  }, []);

  const tabs = (
    <div role="tablist" aria-label="경험 그래프 도우미" className="flex gap-1 border-b border-slate-200">
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
  );
  const panels = (
    <>
      <div id="graph-assistant-panel-build" role="tabpanel" aria-labelledby="graph-assistant-tab-build" hidden={tab !== "build"}>
        <GraphChatPanel initialMessage={initialMessage} uploadLimits={uploadLimits} />
      </div>
      <div id="graph-assistant-panel-qa" role="tabpanel" aria-labelledby="graph-assistant-tab-qa" hidden={tab !== "qa"}>
        <GraphQaPanel />
      </div>
    </>
  );

  if (children) return <>{children({ tabs, panels })}</>;
  return (
    <div className="min-w-0 space-y-4">
      {tabs}
      {panels}
    </div>
  );
}
