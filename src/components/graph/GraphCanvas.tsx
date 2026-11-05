"use client";

import { useMemo } from "react";
import { cn } from "@/components/ui/cn";
import { type CareerGraph, NODE_LABEL_META, nodeDisplayName, PERSON_ID, REL_RULES } from "@/lib/domain/graph";
import { layoutGraph, NODE_RADIUS } from "./layout";
import { LABEL_STYLE } from "./styles";

const shorten = (s: string, max = 9) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/**
 * 방사형 관계도(SVG). 노드를 누르면 onSelect. 선택한 노드의 관계는 진하게, 관계 이름도 함께 보인다.
 * zoom 1은 상자 폭에 맞춤, 그보다 크면 가로·세로 스크롤로 본다(좁은 화면에서 확대해 보기).
 */
export function GraphCanvas({
  graph,
  selectedId,
  onSelect,
  zoom,
}: {
  graph: CareerGraph;
  selectedId: string | null;
  onSelect: (id: string) => void;
  zoom: number;
}) {
  const layout = useMemo(() => layoutGraph(graph), [graph]);
  const vb = layout.viewBox;
  const personLabel = graph.person.name ? shorten(graph.person.name, 6) : "나";
  const connected = useMemo(() => {
    const set = new Set<string>();
    if (!selectedId) return set;
    for (const e of graph.edges) {
      if (e.from === selectedId) set.add(e.to);
      if (e.to === selectedId) set.add(e.from);
    }
    return set;
  }, [graph.edges, selectedId]);

  const select = (id: string) => (ev: React.KeyboardEvent) => {
    if (ev.key === "Enter" || ev.key === " ") {
      ev.preventDefault();
      onSelect(id);
    }
  };

  return (
    <div className="max-h-[70vh] overflow-auto rounded-lg bg-slate-50/60">
      <svg
        viewBox={`${vb.x} ${vb.y} ${vb.width} ${vb.height}`}
        style={{ width: `${zoom * 100}%`, minWidth: Math.min(vb.width, 320) * zoom, maxWidth: zoom === 1 ? vb.width * 1.6 : undefined }}
        className="mx-auto block h-auto select-none"
        role="group"
        aria-label="경력 그래프 관계도"
      >
        {layout.radii.map((r) => (
          <circle key={r} r={r} className="fill-none stroke-slate-200" strokeDasharray="4 6" />
        ))}

        {graph.edges.map((e) => {
          const a = layout.positions.get(e.from);
          const b = layout.positions.get(e.to);
          if (!a || !b) return null;
          const active = selectedId !== null && (e.from === selectedId || e.to === selectedId);
          // 관계 이름은 선 가운데에서 수직으로 조금 비켜 노드 이름과 덜 겹치게 둔다.
          const len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
          const lx = (a.x + b.x) / 2 + ((a.y - b.y) / len) * 10;
          const ly = (a.y + b.y) / 2 + ((b.x - a.x) / len) * 10;
          return (
            <g key={e.id}>
              <line
                x1={a.x}
                y1={a.y}
                x2={b.x}
                y2={b.y}
                className={cn(active ? "stroke-indigo-500" : "stroke-slate-300", selectedId && !active && "opacity-40")}
                strokeWidth={active ? 2 : 1.2}
              />
              {active && (
                <text
                  x={lx}
                  y={ly}
                  textAnchor="middle"
                  dy="0.35em"
                  className="fill-indigo-700 text-[10px] font-medium"
                  paintOrder="stroke"
                  stroke="white"
                  strokeWidth={3}
                >
                  {REL_RULES[e.type].name}
                </text>
              )}
            </g>
          );
        })}

        {/* 본인 */}
        <g
          role="button"
          tabIndex={0}
          aria-label="나"
          aria-pressed={selectedId === PERSON_ID}
          onClick={() => onSelect(PERSON_ID)}
          onKeyDown={select(PERSON_ID)}
          className="cursor-pointer outline-none focus-visible:[&>circle]:stroke-[4px]"
        >
          <circle r={NODE_RADIUS + 8} className={cn(LABEL_STYLE.Person.node, selectedId === PERSON_ID && "stroke-[4px]")} strokeWidth={2} />
          <text textAnchor="middle" dy="0.35em" className="fill-white text-[12px] font-semibold">
            {personLabel}
          </text>
        </g>

        {graph.nodes.map((n) => {
          const p = layout.positions.get(n.id);
          if (!p) return null;
          const name = nodeDisplayName(n);
          const selected = n.id === selectedId;
          const dim = selectedId !== null && !selected && !connected.has(n.id);
          return (
            <g
              key={n.id}
              transform={`translate(${p.x} ${p.y})`}
              role="button"
              tabIndex={0}
              aria-label={`${NODE_LABEL_META[n.label].name}: ${name}`}
              aria-pressed={selected}
              onClick={() => onSelect(n.id)}
              onKeyDown={select(n.id)}
              className={cn("cursor-pointer outline-none focus-visible:[&>circle]:stroke-[4px]", dim && "opacity-45")}
            >
              <title>{`${NODE_LABEL_META[n.label].name}: ${name}`}</title>
              <circle r={NODE_RADIUS} className={LABEL_STYLE[n.label].node} strokeWidth={selected ? 4 : 1.5} />
              <text textAnchor="middle" dy="0.35em" className="fill-slate-600 text-[10px] font-semibold">
                {NODE_LABEL_META[n.label].name.slice(0, 2)}
              </text>
              <text
                y={NODE_RADIUS + 14}
                textAnchor="middle"
                className={cn("text-[11px]", selected ? "fill-indigo-800 font-semibold" : "fill-slate-800")}
                paintOrder="stroke"
                stroke="white"
                strokeWidth={3}
              >
                {shorten(name)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
