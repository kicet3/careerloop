"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { cn } from "@/components/ui/cn";
import { Spinner } from "@/components/ui/Spinner";
import { type CareerGraph, type GraphOp, NODE_LABEL_META, NODE_LABELS, type NodeLabel, PERSON_ID } from "@/lib/domain/graph";
import { emitGraphChanged, fetchGraph, GRAPH_CHANGED_EVENT, GRAPH_FOCUS_EVENT, type GraphFocusDetail, openProjectChat, postGraphOps } from "./api";
import { useFollowupCounts } from "./followups-client";
import { EdgeForm } from "./EdgeForm";
import { ExperienceChecklist } from "./ExperienceChecklist";
import { GraphCanvas } from "./GraphCanvas";
import { GraphList } from "./GraphList";
import { NEW_NODE_REF } from "./model";
import { NodeDetail } from "./NodeDetail";
import { NodeForm } from "./NodeForm";
import { LABEL_STYLE } from "./styles";

type Panel =
  { kind: "none" } | { kind: "detail"; id: string } | { kind: "add" } | { kind: "edit"; id: string } | { kind: "link"; id: string; targetLabels?: NodeLabel[] };

const ZOOMS = [1, 1.5, 2, 3];

/**
 * 경험 그래프 보기·편집. 관계도(SVG)·목록 두 보기, 선택한 항목의 상세, 추가·수정·삭제·연결 폼.
 * 화면 배치도 맡는다: 경험 체크리스트(전체 폭) → chatTabs(전체 폭) → 왼쪽 chat · 오른쪽 카드 하나
 * (탭: 관계도 / 목록 / sideTabs, 탭 줄 오른쪽에 항목 추가). 넓은 화면에서 오른쪽 카드는 채팅 카드 높이에 맞추고 안에서 스크롤한다.
 * 그래프 채팅이 변경안을 적용하면 window 이벤트(career-graph:changed)를 받아 다시 불러온다.
 * 그래프에 묻기의 출처 칩은 window 이벤트(career-graph:focus)로 노드를 고르고 본인에서의 경로를 강조한다.
 */
export interface SideTab {
  key: string;
  label: string;
  content: ReactNode;
}

const GRAPH_TAB = "graph";
const LIST_TAB = "list";

export function CareerGraphView({
  initialGraph,
  initialError,
  chatTabs,
  chat,
  sideTabs = [],
}: {
  initialGraph: CareerGraph | null;
  initialError: string | null;
  chatTabs?: ReactNode;
  chat?: ReactNode;
  sideTabs?: SideTab[];
}) {
  const [sideTab, setSideTab] = useState<string>(GRAPH_TAB);
  const [graph, setGraph] = useState<CareerGraph | null>(initialGraph);
  const [loadError, setLoadError] = useState<string | null>(initialError);
  const [loading, setLoading] = useState(false);
  const [panel, setPanel] = useState<Panel>({ kind: "none" });
  const [zoomIdx, setZoomIdx] = useState(0);
  const panelRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  /** 그래프에 묻기 출처에서 온 강조 경로. 다른 항목을 고르면 지운다. */
  const [highlight, setHighlight] = useState<{ id: string; ids: ReadonlySet<string> } | null>(null);
  const [focusNotice, setFocusNotice] = useState<string | null>(null);
  const followupCounts = useFollowupCounts();
  const graphRef = useRef(graph);
  useEffect(() => {
    graphRef.current = graph;
  }, [graph]);

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

  // 그래프에 묻기의 출처 칩: 그 노드를 고르고 본인에서의 경로를 강조한 뒤 관계도로 스크롤한다.
  useEffect(() => {
    const onFocus = (ev: Event) => {
      const detail = (ev as CustomEvent<GraphFocusDetail | undefined>).detail;
      if (!detail?.id) return;
      ev.preventDefault();
      if (!graphRef.current?.nodes.some((n) => n.id === detail.id)) {
        setFocusNotice("그래프에서 찾을 수 없습니다. 삭제되었거나 아직 불러오지 않은 항목입니다.");
        return;
      }
      setFocusNotice(null);
      setSideTab(GRAPH_TAB);
      setPanel({ kind: "detail", id: detail.id });
      setHighlight({ id: detail.id, ids: new Set([...(detail.pathIds ?? []), detail.id]) });
      canvasRef.current?.scrollIntoView({ block: "start", behavior: "smooth" });
    };
    window.addEventListener(GRAPH_FOCUS_EVENT, onFocus);
    return () => window.removeEventListener(GRAPH_FOCUS_EVENT, onFocus);
  }, []);

  useEffect(() => {
    if (!focusNotice) return;
    const t = setTimeout(() => setFocusNotice(null), 4000);
    return () => clearTimeout(t);
  }, [focusNotice]);

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

  const errorCard = (
    <div className="p-5">
      <Alert tone="error" title="경험 그래프를 불러오지 못했습니다">
        {loadError ?? "잠시 후 다시 시도해 주세요."}
      </Alert>
      <Button variant="secondary" className="mt-4" onClick={() => void refresh()} loading={loading}>
        다시 시도
      </Button>
    </div>
  );

  const selectedId = panel.kind === "none" || panel.kind === "add" ? null : panel.id;
  const select = (id: string) => {
    if (highlight && highlight.id !== id) setHighlight(null);
    setPanel({ kind: "detail", id });
  };
  const highlightIds = highlight && selectedId === highlight.id ? highlight.ids : undefined;
  const empty = !graph || graph.nodes.length === 0;
  const editing = graph && panel.kind === "edit" ? graph.nodes.find((n) => n.id === panel.id) : undefined;

  const view: "graph" | "list" = sideTab === LIST_TAB ? "list" : "graph";
  const onGraphTab = sideTab === GRAPH_TAB || sideTab === LIST_TAB;
  const tabsList = [
    { key: GRAPH_TAB, label: "관계도" },
    { key: LIST_TAB, label: "목록" },
    ...sideTabs.map((t) => ({ key: t.key, label: t.label })),
  ];

  const graphBody = !graph ? (
    errorCard
  ) : (
    <div ref={canvasRef} className="scroll-mt-20">
      {focusNotice && (
        <Alert tone="warning" className="m-4">
          {focusNotice}
        </Alert>
      )}
      <div className="flex items-center gap-2 px-4 pt-3 text-sm text-slate-500 sm:px-5">
        <span>
          항목 {graph.nodes.length}개 · 연결 {graph.edges.length}개
        </span>
        {loading && <Spinner size="sm" />}
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
          <p className="mx-auto mt-2 max-w-md text-sm font-medium text-slate-700">
            자소서와 이력서에 꼭 필요한 경험 6가지를 위쪽 경험 체크리스트로 채워 보세요.
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
                <GraphCanvas graph={graph} selectedId={selectedId} onSelect={select} zoom={ZOOMS[zoomIdx]!} highlightIds={highlightIds} />
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
              <GraphList
                graph={graph}
                selectedId={selectedId}
                onSelect={select}
                followupCounts={followupCounts}
                onOpenFollowups={(projectId) => {
                  if (!openProjectChat(projectId, { followupId: "first" })) setFocusNotice("이 화면에서는 대화를 열 수 없습니다.");
                }}
              />
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
              followupCount={followupCounts?.byProject[panel.id] ?? 0}
            />
          )}
          {panel.kind === "add" && <NodeForm graph={graph} onSubmit={apply} onCancel={() => setPanel({ kind: "none" })} />}
          {panel.kind === "edit" && editing && (
            <NodeForm key={editing.id} graph={graph} node={editing} onSubmit={apply} onCancel={() => select(editing.id)} />
          )}
          {panel.kind === "link" && (
            <EdgeForm
              key={`${panel.id}:${panel.targetLabels?.join(",") ?? ""}`}
              graph={graph}
              sourceId={panel.id}
              targetLabels={panel.targetLabels}
              onSubmit={apply}
              onCancel={() => select(panel.id)}
            />
          )}
        </div>
      )}
    </div>
  );

  return (
    <div className="min-w-0 space-y-6">
      {graph && (
        <ExperienceChecklist
          graph={graph}
          onFix={(b) => {
            if (!onGraphTab) setSideTab(GRAPH_TAB);
            setPanel(b.fix === "link" ? { kind: "link", id: b.nodeId, targetLabels: b.linkTargets } : { kind: "edit", id: b.nodeId });
          }}
        />
      )}
      {chatTabs}
      <div className="grid gap-6 xl:grid-cols-[minmax(30rem,46%)_minmax(0,1fr)]">
        <div id="graph-chat" className="min-w-0 scroll-mt-20 xl:self-start">
          {chat}
        </div>
        {/* 넓은 화면: 이 칸의 높이는 채팅 카드가 정한다(absolute로 띄워 오른쪽 내용이 줄 높이를 늘리지 않게). */}
        <div className="relative min-w-0 min-h-[32rem]">
          <Card className="flex min-w-0 flex-col overflow-hidden xl:absolute xl:inset-0">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-100 px-3 py-2 sm:px-4">
              <div role="tablist" aria-label="그래프 보기" className="inline-flex rounded-lg bg-slate-100 p-0.5">
                {tabsList.map((t) => (
                  <button
                    key={t.key}
                    id={`graph-side-tab-${t.key}`}
                    type="button"
                    role="tab"
                    aria-selected={sideTab === t.key}
                    aria-controls={`graph-side-panel-${t.key === LIST_TAB ? GRAPH_TAB : t.key}`}
                    onClick={() => setSideTab(t.key)}
                    className={cn(
                      "rounded-md px-3 py-1.5 text-sm font-medium",
                      sideTab === t.key ? "bg-white text-slate-900 shadow-sm" : "text-slate-600 hover:text-slate-900",
                    )}
                  >
                    {t.label}
                  </button>
                ))}
              </div>
              {graph && (
                <Button
                  size="sm"
                  onClick={() => {
                    if (!onGraphTab) setSideTab(GRAPH_TAB);
                    setPanel({ kind: "add" });
                  }}
                >
                  항목 추가
                </Button>
              )}
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div id={`graph-side-panel-${GRAPH_TAB}`} role="tabpanel" aria-label="경험 그래프" hidden={!onGraphTab}>
                {graphBody}
              </div>
              {sideTabs.map((t) => (
                <div key={t.key} id={`graph-side-panel-${t.key}`} role="tabpanel" aria-labelledby={`graph-side-tab-${t.key}`} hidden={sideTab !== t.key}>
                  {t.content}
                </div>
              ))}
            </div>
          </Card>
        </div>
      </div>
    </div>
  );
}
