"use client";

import { useId, useMemo, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { type CareerGraph, type GraphOp, NODE_LABEL_META, type NodeLabel } from "@/lib/domain/graph";
import { connectableTargets, describeEdge, endpointLabel, endpointName, relationsBetween } from "./model";
import { inputClass, labelClass } from "./styles";

/**
 * 선택한 노드(또는 본인)에서 다른 끝점으로 관계를 하나 추가하는 폼. 허용 방향의 관계만 고를 수 있다.
 * targetLabels가 오면(경험 체크리스트의 '연결하기') 그 라벨의 대상만 보인다(본인 제외).
 */
export function EdgeForm({
  graph,
  sourceId,
  targetLabels,
  onSubmit,
  onCancel,
}: {
  graph: CareerGraph;
  sourceId: string;
  targetLabels?: readonly NodeLabel[];
  onSubmit: (ops: GraphOp[]) => Promise<void>;
  onCancel: () => void;
}) {
  const uid = useId();
  const targets = useMemo(() => {
    const all = connectableTargets(graph, sourceId);
    if (!targetLabels) return all;
    return all.filter((id) => {
      const l = endpointLabel(graph, id);
      return l !== null && l !== "Person" && targetLabels.includes(l);
    });
  }, [graph, sourceId, targetLabels]);
  const [targetId, setTargetId] = useState(targets[0] ?? "");
  const relations = useMemo(() => (targetId ? relationsBetween(graph, sourceId, targetId) : []), [graph, sourceId, targetId]);
  const [relIdx, setRelIdx] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const targetText = (id: string) => {
    const l = endpointLabel(graph, id);
    const kind = l && l !== "Person" ? `${NODE_LABEL_META[l].name} · ` : "";
    return `${kind}${endpointName(graph, id)}`;
  };

  async function submit(ev: React.FormEvent) {
    ev.preventDefault();
    const rel = relations[relIdx];
    if (!rel) {
      setError("연결할 대상을 골라 주세요.");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onSubmit([{ op: "addEdge", type: rel.type, from: rel.from, to: rel.to }]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "저장하지 못했습니다.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-4">
      <h3 className="text-base font-semibold text-slate-900">연결 추가 — {endpointName(graph, sourceId)}</h3>
      {targets.length === 0 ? (
        <Alert tone="info">더 연결할 수 있는 항목이 없습니다. 먼저 회사·프로젝트·기술 같은 항목을 추가해 보세요.</Alert>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor={`${uid}-target`} className={labelClass}>
              대상
            </label>
            <select
              id={`${uid}-target`}
              className={inputClass}
              value={targetId}
              onChange={(e) => {
                setTargetId(e.target.value);
                setRelIdx(0);
              }}
            >
              {targets.map((id) => (
                <option key={id} value={id}>
                  {targetText(id)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label htmlFor={`${uid}-rel`} className={labelClass}>
              관계
            </label>
            <select id={`${uid}-rel`} className={inputClass} value={relIdx} onChange={(e) => setRelIdx(Number(e.target.value))}>
              {relations.map((r, i) => (
                <option key={`${r.type}:${r.from}:${r.to}`} value={i}>
                  {describeEdge(graph, r)}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="ghost" onClick={onCancel} disabled={busy}>
          취소
        </Button>
        <Button type="submit" loading={busy} disabled={relations.length === 0}>
          연결
        </Button>
      </div>
    </form>
  );
}
