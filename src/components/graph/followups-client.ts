"use client";
/**
 * 후속 질문(graph_followups) 브라우저 도우미: 열린 질문 수 읽기(목록·프로젝트 상세의 '후속 질문 n개'), 상태 바꾸기, 바뀜 알림 이벤트.
 * 채팅 패널이 질문을 쌓거나(답변 도착) 상태를 바꾸면 FOLLOWUPS_CHANGED_EVENT를 보내고, 수를 보이는 쪽이 다시 읽는다.
 */
import { useCallback, useEffect, useState } from "react";
import type { FollowupCounts, FollowupStatus, GraphFollowup } from "@/lib/domain/followups";
import { GRAPH_CHANGED_EVENT } from "./api";
import { chatApi } from "./chat-client";

export const FOLLOWUPS_CHANGED_EVENT = "graph-followups:changed";

export function emitFollowupsChanged(): void {
  window.dispatchEvent(new CustomEvent(FOLLOWUPS_CHANGED_EVENT));
}

export async function patchFollowup(
  id: string,
  patch: { status?: FollowupStatus; projectNodeId?: string | null },
): Promise<{ followup: GraphFollowup; counts: FollowupCounts }> {
  const r = await chatApi<{ followup: GraphFollowup; counts: FollowupCounts }>(`/api/graph/chat/followups/${encodeURIComponent(id)}`, {
    method: "PATCH",
    json: patch,
  });
  emitFollowupsChanged();
  return r;
}

/** 그 프로젝트의 열린 후속 질문(오래된 것부터). */
export async function fetchProjectFollowups(projectNodeId: string): Promise<GraphFollowup[]> {
  const r = await chatApi<{ items?: GraphFollowup[] }>(`/api/graph/chat/followups?projectNodeId=${encodeURIComponent(projectNodeId)}`);
  return r.items ?? [];
}

/** 열린 후속 질문 수. 읽지 못하면 null(배지를 숨긴다). 질문·그래프가 바뀌면 다시 읽는다. */
export function useFollowupCounts(): FollowupCounts | null {
  const [counts, setCounts] = useState<FollowupCounts | null>(null);
  const load = useCallback(() => {
    chatApi<{ counts: FollowupCounts }>("/api/graph/chat/followups").then(
      (r) => setCounts(r.counts),
      () => {},
    );
  }, []);
  useEffect(() => {
    load();
    window.addEventListener(FOLLOWUPS_CHANGED_EVENT, load);
    window.addEventListener(GRAPH_CHANGED_EVENT, load);
    return () => {
      window.removeEventListener(FOLLOWUPS_CHANGED_EVENT, load);
      window.removeEventListener(GRAPH_CHANGED_EVENT, load);
    };
  }, [load]);
  return counts;
}
