"use client";
/**
 * 경험 그래프 화면 배치: 경험 체크리스트(전체 폭) → 경험 정리하기 | 경험 질문하기 탭(전체 폭) →
 * 왼쪽 채팅(넓게) · 오른쪽 탭(경험 그래프 / 부족한 기술, 하나씩 본다). 좁은 화면에서는 오른쪽이 채팅 아래로 내려간다.
 * 그래프 상태는 CareerGraphView가 갖고, 채팅 탭 상태는 GraphAssistantPanel이 갖는다.
 */
import { SkillGapPanel } from "@/components/match/SkillGapPanel";
import type { CareerGraph } from "@/lib/domain/graph";
import type { UploadLimits } from "@/lib/ingest/upload-limits";
import { CareerGraphView } from "./CareerGraphView";
import { GraphAssistantPanel, type AssistantTab } from "./GraphAssistantPanel";

export function GraphWorkspace({
  initialGraph,
  initialError,
  initialMessage,
  initialTab,
  uploadLimits,
}: {
  initialGraph: CareerGraph | null;
  initialError: string | null;
  initialMessage?: string;
  initialTab?: AssistantTab;
  uploadLimits?: UploadLimits;
}) {
  return (
    <GraphAssistantPanel initialMessage={initialMessage} initialTab={initialTab} uploadLimits={uploadLimits}>
      {({ tabs, panels }) => (
        <CareerGraphView
          initialGraph={initialGraph}
          initialError={initialError}
          chatTabs={tabs}
          chat={panels}
          sideTabs={[{ key: "skills", label: "부족한 기술", content: <SkillGapPanel /> }]}
        />
      )}
    </GraphAssistantPanel>
  );
}
