"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { type CareerGraph, type GraphOp, NODE_LABEL_META, NODE_LABELS, PERSON_ID } from "@/lib/domain/graph";
import { emitGraphChanged, fetchGraph, GRAPH_CHANGED_EVENT, postGraphOps } from "./api";
import { EdgeForm } from "./EdgeForm";
import { GraphCanvas } from "./GraphCanvas";
import { GraphList } from "./GraphList";
import { NEW_NODE_REF } from "./model";
import { NodeDetail } from "./NodeDetail";
import { NodeForm } from "./NodeForm";
import { LABEL_STYLE } from "./styles";

type Panel = { kind: "none" } | { kind: "detail"; id: string } | { kind: "add" } | { kind: "edit"; id: string } | { kind: "link"; id: string };

const ZOOMS = [1, 1.5, 2, 3];

/**
 * 경력 그래프 보기·편집. 관계도(SVG)·목록 두 보기, 선택한 항목의 상세, 추가·수정·삭제·연결 폼.
 * 그래프 채팅이 변경안을 적용하면 window 이벤트(career-graph:changed)를 받아 다시 불러온다.
 */
export function CareerGraphView({ initialGraph, initialError }: { initialGraph: CareerGraph | null; initialError: string | null }) {
  const [graph, setGraph] = useState<CareerGraph | null>(initialGraph);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [view, setView] = useState<"graph" | "list">("graph");
  const [zoomIdx, setZoomIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const g = await fetchGraph();
      setGraph(g);
      setLoadError(null);
      // 지워진 항목을 보고 있었다면 닫는다.
      setPanel((p) => ("id" in p && p.id !== PERSON_ID && !g.nodes.some((n) => n.id === p.id) ? { kind: "none" } : p));
    } catch (err) {
      setLoadError(err instanceof Error ? err.message : "그래프를 불러오지 못했습니다.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    const onChanged = (ev: Event) => {
      const source = (ev as CustomEvent<{ source?: string } | undefined>).detail?.source;
      if (source !== "editor") void refresh();
    };
    window.addEventListener(GRAPH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GRAPH_CHANGED_EVENT, onChanged);
  }, [refresh]);

  useEffect(() => {
    if (panel.kind !== "none") panelRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [panel]);

  /** 변경을 서버에 보내고 응답의 그래프로 바꾼다. 실패하면 서버 문구로 던진다(폼이 보인다). */
  const apply = useCallback(async (ops: GraphOp[]) => {
    const res = await postGraphOps(ops);
    setGraph(res.graph);
    emitGraphChanged("editor");
    const first = ops[0];
    const createdId = res.created[NEW_NODE_REF];
    if (createdId) setPanel({ kind: "detail", id: createdId });
    else if (first?.op === "deleteNode") setPanel({ kind: "none" });
    else if (first?.op === "updateNode") setPanel({ kind: "detail", id: first.id });
    else setPanel((p) => ("id" in p ? { kind: "detail", id: p.id } : p));
  }, []);

  if (!graph) {
    return (
      <Card className="p-5">
        <Alert tone="error" title="경력 그래프를 불러오지 못했습니다">
          {loadError ?? "잠시 후 다시 시도해 주세요."}
        </Alert>
        <Button variant="secondary" className="mt-4" onClick={() => void refresh()} loading={loading}>
          다시 시도
        </Button>
      </Card>
    );
  }

  const selectedId = panel.kind === "none" || panel.kind === "add" ? null : panel.id;
  const select = (id: string) => setPanel({ kind: "detail", id });
  const empty = graph.nodes.length === 0;
  const editing = panel.kind === "edit" ? graph.nodes.find((n) => n.id === panel.id) : undefined;

  return (
    <Card className="overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-100 px-4 py-3 sm:px-5">
        <div className="flex items-center gap-2 text-sm text-slate-500">
          <span>
            항목 {graph.nodes.length}개 · 연결 {graph.edges.length}개
          </span>
          {loading && <Spinner size="sm" />}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!empty && (
            <div role="tablist" aria-label="보기" className="inline-flex rounded-lg bg-slate-100 p-0.5">
              {(
                [
                  ["graph", "관계도"],
                  ["list", "목록"],
                ] as const
              ).map(([key, text]) => (
                <button
                  key={key}
                  type="button"
                  role="tab"
                  aria-selected={view === key}
                  onClick={() => setView(key)}
                  className={cn(
                    "rounded-md px-3 py-1 text-sm font-medium",
                    view === key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
                  )}
                >
                  {text}
                </button>
              ))}
            </div>
          )}
          <Button size="sm" onClick={() => setPanel({ kind: "add" })}>
            항목 추가
          </Button>
        </div>
      </div>

      {loadError && (
        <Alert tone="warning" className="m-4">
          최신 그래프를 불러오지 못했습니다: {loadError}
        </Alert>
      )}

      {empty && panel.kind === "none" ? (
        <div className="px-6 py-12 text-center">
          <p className="text-lg font-semibold text-slate-900">아직 정리된 경력이 없습니다</p>
          <p className="mx-auto mt-2 max-w-md text-sm text-slate-500">
            채팅에서 다닌 회사, 맡은 일, 프로젝트와 성과를 편하게 이야기하면 AI가 그래프로 정리할 변경안을 만들어 줍니다. 확인한 뒤
            적용하면 여기에 나타납니다. 직접 하나씩 추가해도 됩니다.
          </p>
          <div className="mt-6 flex flex-wrap justify-center gap-2">
            <a href="#graph-chat" className={buttonClass("primary", "md")}>
              채팅으로 시작하기
            </a>
            <Button variant="secondary" onClick={() => setPanel({ kind: "add" })}>
              직접 추가
            </Button>
          </div>
        </div>
      ) : (
        !empty && (
          <div className="p-3 sm:p-4">
            {view === "graph" ? (
              <>
                <GraphCanvas graph={graph} selectedId={selectedId} onSelect={select} zoom={ZOOMS[zoomIdx]!} />
                <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                  <ul className="flex flex-wrap gap-x-3 gap-y-1 text-xs text-slate-600" aria-label="범례">
                    {NODE_LABELS.filter((l) => graph.nodes.some((n) => n.label === l)).map((l) => (
                      <li key={l} className="inline-flex items-center gap-1">
                        <span className={cn("size-2.5 rounded-full", LABEL_STYLE[l].dot)} aria-hidden />
                        {NODE_LABEL_META[l].name}
                      </li>
                    ))}
                  </ul>
                  <div className="inline-flex items-center gap-1" aria-label="확대">
                    <Button variant="secondary" size="sm" onClick={() => setZoomIdx((z) => Math.max(0, z - 1))} disabled={zoomIdx === 0} aria-label="축소">
                      −
                    </Button>
                    <span className="w-12 text-center text-xs text-slate-500">{Math.round(ZOOMS[zoomIdx]! * 100)}%</span>
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => setZoomIdx((z) => Math.min(ZOOMS.length - 1, z + 1))}
                      disabled={zoomIdx === ZOOMS.length - 1}
                      aria-label="확대"
                    >
                      +
                    </Button>
                  </div>
                </div>
              </>
            ) : (
              <GraphList graph={graph} selectedId={selectedId} onSelect={select} />
            )}
          </div>
        )
      )}

      {panel.kind !== "none" && (
        <div ref={panelRef} className="scroll-mt-20 border-t border-slate-100 bg-slate-50/40 p-4 sm:p-5">
          {panel.kind === "detail" && (
            <NodeDetail
              key={panel.id}
              graph={graph}
              id={panel.id}
              onEdit={() => setPanel({ kind: "edit", id: panel.id })}
              onAddEdge={() => setPanel({ kind: "link", id: panel.id })}
              onApply={apply}
              onSelect={select}
              onClose={() => setPanel({ kind: "none" })}
            />
          )}
          {panel.kind === "add" && <NodeForm graph={graph} onSubmit={apply} onCancel={() => setPanel({ kind: "none" })} />}
          {panel.kind === "edit" && editing && (
            <NodeForm key={editing.id} graph={graph} node={editing} onSubmit={apply} onCancel={() => select(editing.id)} />
          )}
          {panel.kind === "link" && (
            <EdgeForm key={panel.id} graph={graph} sourceId={panel.id} onSubmit={apply} onCancel={() => select(panel.id)} />
          )}
        </div>
      )}
    </Card>
  );
}
