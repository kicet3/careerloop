"use client";

import { cn } from "@/components/ui/cn";
import { type CareerGraph, NODE_LABEL_META, NODE_LABELS, nodeDisplayName } from "@/lib/domain/graph";
import { nodePeriod, sortNodesForList } from "./model";
import { LABEL_STYLE } from "./styles";

/** 라벨별 목록(최근 순). 좁은 화면에서는 관계도보다 이쪽이 읽기 쉽다. */
export function GraphList({
  graph,
  selectedId,
  onSelect,
}: {
  graph: CareerGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
}) {
  const degree = new Map<string, number>();
  for (const e of graph.edges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }
  const groups = NODE_LABELS.map((label) => ({ label, nodes: sortNodesForList(graph.nodes.filter((n) => n.label === label)) })).filter(
    (g) => g.nodes.length > 0,
  );

  return (
    <div className="space-y-5">
      {groups.map(({ label, nodes }) => (
        <section key={label}>
          <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
            <span className={cn("size-2.5 rounded-full", LABEL_STYLE[label].dot)} aria-hidden />
            {NODE_LABEL_META[label].name}
            <span className="font-normal text-slate-400">{nodes.length}</span>
          </h3>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {nodes.map((n) => {
              const period = nodePeriod(n);
              return (
                <li key={n.id}>
                  <button
                    type="button"
                    onClick={() => onSelect(n.id)}
                    aria-pressed={selectedId === n.id}
                    className={cn(
                      "w-full rounded-lg border px-3 py-2 text-left transition-colors",
                      selectedId === n.id ? "border-indigo-400 bg-indigo-50" : "border-slate-200 bg-white hover:border-indigo-300 hover:bg-indigo-50/30",
                    )}
                  >
                    <span className="block truncate text-sm font-medium text-slate-900">{nodeDisplayName(n)}</span>
                    <span className="mt-0.5 flex gap-2 text-xs text-slate-500">
                      {period && <span>{period}</span>}
                      <span>연결 {degree.get(n.id) ?? 0}</span>
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        </section>
      ))}
    </div>
  );
}
