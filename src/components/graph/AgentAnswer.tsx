"use client";
/**
 * 경험 질문하기(에이전트) 답: 문장 묶음(segment)마다 인용 번호와 출처 라벨(그래프 노드·GitHub 저장소 요약·가져온 문서·포트폴리오)을 붙인다.
 * 확인한 사실(fact)과 일반 조언(advice)을 구분해 보이고, 삭제·변경된 출처는 흐리게 표시한다(서버가 볼 때마다 다시 확인한 exists).
 * 노드 출처를 누르면 같은 화면의 그래프 보기가 그 노드를 고른다.
 */
import { useState } from "react";
import { cn } from "@/components/ui/cn";
import type { GraphAgentAnswerData, GraphAgentCitation } from "@/lib/domain/chat";
import { focusGraphNode } from "./api";

const SOURCE_LABEL: Record<NonNullable<GraphAgentCitation["sourceType"]>, string> = {
  "repo-brief": "GitHub 저장소 요약",
  "document-import": "가져온 문서",
  "portfolio-text": "포트폴리오",
};

function citationLabel(c: GraphAgentCitation): string {
  if (c.sourceType) return SOURCE_LABEL[c.sourceType];
  return c.label;
}

function CitationMark({ c }: { c: GraphAgentCitation }) {
  const gone = c.exists === false;
  const canFocus = !gone && c.kind === "node" && !!c.nodeId;
  return (
    <button
      type="button"
      disabled={!canFocus}
      onClick={() => canFocus && focusGraphNode(c.nodeId!, [])}
      title={`${citationLabel(c)} · ${c.name}${gone ? " (삭제되었거나 바뀐 출처)" : ""}`}
      aria-label={`출처 ${c.n}: ${citationLabel(c)} ${c.name}`}
      className={cn(
        "ml-0.5 rounded px-0.5 align-super text-[0.7rem] font-semibold text-indigo-700 hover:bg-indigo-100 disabled:cursor-default disabled:hover:bg-transparent",
        gone && "text-slate-400 line-through",
      )}
    >
      [{c.n}]
    </button>
  );
}

export function AgentAnswer({ data }: { data: GraphAgentAnswerData }) {
  const byN = new Map(data.citations.map((c) => [c.n, c]));
  return (
    <div className="space-y-2">
      <div className="space-y-1.5 rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2">
        {data.segments.map((s, i) => (
          <p key={i} className={cn("text-sm break-words whitespace-pre-wrap", s.kind === "fact" ? "text-slate-800" : "text-slate-600")}>
            {s.kind === "advice" && <span className="mr-1 rounded bg-white px-1 text-[0.65rem] text-slate-500">일반 조언</span>}
            {s.text}
            {s.citations.map((n) => {
              const c = byN.get(n);
              return c ? <CitationMark key={n} c={c} /> : null;
            })}
          </p>
        ))}
      </div>
      {data.citations.length > 0 && (
        <div className="space-y-1">
          <p className="text-xs font-medium text-slate-500">출처</p>
          <ul className="space-y-1">
            {data.citations.map((c) => (
              <li key={c.n} className={cn("rounded-lg border border-slate-200 bg-white px-2 py-1 text-xs", c.exists === false && "opacity-60")}>
                <span className="font-semibold text-slate-500">[{c.n}]</span> <span className="text-slate-500">{citationLabel(c)}</span>{" "}
                <span className={cn("font-medium text-slate-800", c.exists === false && "line-through")}>{c.name}</span>
                {c.exists === false && <span className="text-slate-500"> (삭제되었거나 바뀐 출처)</span>}
                {c.exists !== false && (c.pathText || c.snippet) && <p className="mt-0.5 break-words text-slate-500">{c.pathText ?? c.snippet}</p>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.indexStale && <ReindexHint />}
    </div>
  );
}

/** 문서 색인이 최신이 아닐 때: 본인 문서 다시 색인(하루 3회). */
function ReindexHint() {
  const [state, setState] = useState<"idle" | "busy" | "done" | "error">("idle");
  const [message, setMessage] = useState<string | null>(null);
  async function run() {
    setState("busy");
    setMessage(null);
    try {
      const res = await fetch("/api/graph/qa/reindex", { method: "POST" });
      const body = (await res.json().catch(() => ({}))) as { error?: string; done?: boolean };
      if (!res.ok) {
        setState("error");
        setMessage(body.error ?? "다시 색인하지 못했어요.");
        return;
      }
      if (body.done === false) {
        setState("error");
        setMessage("일부만 색인했어요. 잠시 뒤 다시 시도해 주세요.");
        return;
      }
      setState("done");
      setMessage("문서를 다시 색인했어요. 다시 질문해 보세요.");
    } catch {
      setState("error");
      setMessage("다시 색인하지 못했어요.");
    }
  }
  return (
    <p className="text-xs text-slate-500">
      문서 색인이 최신이 아닐 수 있어요.{" "}
      {state !== "done" && (
        <button type="button" onClick={run} disabled={state === "busy"} className="font-semibold text-indigo-700 underline disabled:opacity-60">
          {state === "busy" ? "색인 중…" : "문서 다시 색인"}
        </button>
      )}
      {message && <span className={cn("ml-1", state === "error" && "text-red-600")}>{message}</span>}
    </p>
  );
}
