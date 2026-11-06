"use client";

import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { type CareerGraph, type GraphOp, NODE_LABEL_META, nodeDisplayName, PERSON_ID, REL_RULES } from "@/lib/domain/graph";
import { openProjectChat } from "./api";
import { displayProps, edgesOf, endpointLabel, endpointName, nodePeriod } from "./model";
import { LABEL_STYLE } from "./styles";

/** 선택한 노드(또는 본인)의 속성·관계와 수정·삭제·연결 버튼. */
export function NodeDetail({
  graph,
  id,
  onEdit,
  onAddEdge,
  onApply,
  onSelect,
  onClose,
}: {
  graph: CareerGraph;
  id: string;
  onEdit: () => void;
  onAddEdge: () => void;
  /** 삭제 연산을 서버에 보낸다. 실패하면 오류 문구를 던진다. */
  onApply: (ops: GraphOp[]) => Promise<void>;
  onSelect: (id: string) => void;
  onClose: () => void;
}) {
  const node = id === PERSON_ID ? null : graph.nodes.find((n) => n.id === id);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  if (id !== PERSON_ID && !node) return null;

  const label = endpointLabel(graph, id) ?? "Person";
  const props = node ? displayProps(node) : [];
  const basicProps = props.filter((p) => p.group !== "story");
  const storyProps = props.filter((p) => p.group === "story");
  const edges = edgesOf(graph, id);

  async function run(key: string, ops: GraphOp[]) {
    setBusy(key);
    setError(null);
    try {
      await onApply(ops);
    } catch (err) {
      setError(err instanceof Error ? err.message : "처리하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <span className={cn("inline-flex rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset", LABEL_STYLE[label].chip)}>
            {node ? NODE_LABEL_META[node.label].name : "본인"}
          </span>
          <h3 className="mt-1.5 text-lg font-semibold break-words text-slate-900">{node ? nodeDisplayName(node) : endpointName(graph, id)}</h3>
          {node && nodePeriod(node) && <p className="text-sm text-slate-500">{nodePeriod(node)}</p>}
        </div>
        <Button variant="ghost" size="sm" onClick={onClose} aria-label="상세 닫기">
          닫기
        </Button>
      </div>

      {basicProps.length > 0 && <PropList items={basicProps} />}
      {storyProps.length > 0 && (
        <div>
          <h4 className="mb-2 text-sm font-semibold text-slate-700">자소서 소재(STAR)</h4>
          <PropList items={storyProps} />
        </div>
      )}

      <div>
        <h4 className="text-sm font-semibold text-slate-700">연결 {edges.length}개</h4>
        {edges.length === 0 ? (
          <p className="mt-1 text-sm text-slate-500">아직 연결이 없습니다.</p>
        ) : (
          <ul className="mt-2 divide-y divide-slate-100 rounded-lg border border-slate-200">
            {edges.map(({ edge, otherId, outgoing }) => (
              <li key={edge.id} className="flex items-center gap-2 px-3 py-2 text-sm">
                <span className="shrink-0 text-xs text-slate-500">
                  {REL_RULES[edge.type].name} {outgoing ? "→" : "←"}
                </span>
                <button
                  type="button"
                  onClick={() => onSelect(otherId)}
                  className="min-w-0 flex-1 truncate text-left font-medium text-indigo-700 hover:underline"
                >
                  {endpointName(graph, otherId)}
                </button>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-slate-500 hover:text-red-700"
                  loading={busy === edge.id}
                  disabled={busy !== null}
                  onClick={() => run(edge.id, [{ op: "deleteEdge", type: edge.type, from: edge.from, to: edge.to }])}
                  aria-label={`연결 해제: ${REL_RULES[edge.type].name} ${endpointName(graph, otherId)}`}
                >
                  해제
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>

      {node?.label === "Project" && (
        <div className="flex flex-wrap items-center gap-2 rounded-lg border border-indigo-100 bg-indigo-50/60 px-3 py-2.5">
          <p className="min-w-0 flex-1 text-sm text-indigo-900">
            AI가 이 프로젝트의 배경·역할·한 일·기술·성과를 하나씩 물어보며 그래프로 정리해 줍니다.
          </p>
          <Button
            size="sm"
            onClick={() => {
              if (!openProjectChat(node.id)) setError("이 화면에서는 대화를 열 수 없습니다. 경험 그래프 화면에서 다시 시도해 주세요.");
            }}
          >
            이 프로젝트 대화로 구조화하기
          </Button>
        </div>
      )}

      {error && <Alert tone="error">{error}</Alert>}

      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" size="sm" onClick={onAddEdge} disabled={busy !== null}>
          연결 추가
        </Button>
        {node && (
          <Button variant="secondary" size="sm" onClick={onEdit} disabled={busy !== null}>
            수정
          </Button>
        )}
        {node &&
          (confirming ? (
            <span className="inline-flex flex-wrap items-center gap-2">
              <span className="text-sm text-red-700">연결까지 모두 지울까요?</span>
              <Button variant="danger" size="sm" loading={busy === "delete"} onClick={() => run("delete", [{ op: "deleteNode", id: node.id }])}>
                삭제
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy !== null}>
                취소
              </Button>
            </span>
          ) : (
            <Button variant="danger" size="sm" onClick={() => setConfirming(true)} disabled={busy !== null}>
              삭제
            </Button>
          ))}
      </div>
    </div>
  );
}

function PropList({ items }: { items: { key: string; label: string; value: string }[] }) {
  return (
    <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[8rem_1fr]">
      {items.map((p) => (
        <div key={p.key} className="contents">
          <dt className="font-medium text-slate-500">{p.label}</dt>
          <dd className="mb-1 break-words whitespace-pre-wrap text-slate-800 sm:mb-0">{p.value}</dd>
        </div>
      ))}
    </dl>
  );
}
