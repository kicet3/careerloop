/**
 * 경험 그래프 방사형 레이아웃(순수 함수, 외부 라이브러리 없음).
 * 본인(Person)을 가운데 두고 라벨을 동심원 3개에 나눈다:
 *   1층 회사·학력·경험·자격증(본인에 바로 붙는 것) → 2층 직무·프로젝트 → 3층 기술·성과.
 * 바깥 층 노드는 이미 놓인 이웃 노드들의 각도 평균 쪽으로 정렬해 선이 덜 엇갈리게 한다.
 * 결정적이다(같은 그래프면 같은 좌표) — 새로고침해도 위치가 튀지 않는다.
 */
import type { CareerGraph, NodeLabel } from "@/lib/domain/graph";
import { PERSON_ID } from "@/lib/domain/graph";

export const RINGS: readonly (readonly NodeLabel[])[] = [
  ["Company", "Education", "Experience", "Certification"],
  ["Role", "Project"],
  ["Skill", "Achievement"],
];

/** 같은 원 위 이웃 노드 중심 사이의 최소 간격(px), 원 사이 최소 간격. */
const MIN_GAP = 76;
const RING_STEP = 95;
const FIRST_RADIUS = 100;
export const NODE_RADIUS = 20;
/** 노드 아래 이름(최대 9자)까지 들어가는 여백. */
const MARGIN_X = 64;
const MARGIN_Y = 48;
/** 노드가 적어도 너무 확대되지 않게 하는 최소 viewBox 크기. */
const MIN_VIEW = 300;

export interface Point {
  x: number;
  y: number;
}

export interface GraphLayout {
  positions: Map<string, Point>;
  /** 노드를 모두 담는 viewBox(본인이 원점). 노드가 몰려 있으면 그만큼 작아져 화면에서 크게 보인다. */
  viewBox: { x: number; y: number; width: number; height: number };
  radii: number[];
}

const TAU = Math.PI * 2;

function circularMean(angles: number[]): number | null {
  if (angles.length === 0) return null;
  let sx = 0;
  let sy = 0;
  for (const a of angles) {
    sx += Math.cos(a);
    sy += Math.sin(a);
  }
  if (Math.abs(sx) < 1e-9 && Math.abs(sy) < 1e-9) return angles[0]!;
  return (Math.atan2(sy, sx) + TAU) % TAU;
}

export function layoutGraph(graph: CareerGraph): GraphLayout {
  const positions = new Map<string, Point>([[PERSON_ID, { x: 0, y: 0 }]]);
  const angles = new Map<string, number>();
  const neighbors = new Map<string, string[]>();
  for (const e of graph.edges) {
    (neighbors.get(e.from) ?? neighbors.set(e.from, []).get(e.from)!).push(e.to);
    (neighbors.get(e.to) ?? neighbors.set(e.to, []).get(e.to)!).push(e.from);
  }

  const radii: number[] = [];
  let radius = 0;
  let firstRing = true;
  for (const ring of RINGS) {
    const nodes = graph.nodes.filter((n) => ring.includes(n.label));
    if (nodes.length === 0) continue;
    radius = Math.max(firstRing ? FIRST_RADIUS : radius + RING_STEP, (nodes.length * MIN_GAP) / TAU);
    firstRing = false;
    radii.push(radius);

    // 원하는 각도: 이미 놓인 이웃(본인 제외)의 평균. 없으면 라벨 순서·생성 순서대로 뒤에 둔다.
    const wanted = nodes.map((n, i) => {
      const placed = (neighbors.get(n.id) ?? []).filter((id) => angles.has(id)).map((id) => angles.get(id)!);
      const mean = circularMean(placed);
      return { n, mean, tie: ring.indexOf(n.label) * 100000 + i };
    });
    const anchored = wanted.filter((w) => w.mean !== null).sort((a, b) => a.mean! - b.mean! || a.tie - b.tie);
    const free = wanted.filter((w) => w.mean === null).sort((a, b) => a.tie - b.tie);
    const ordered = [...anchored, ...free];

    // 균등 간격 슬롯에 순서대로 앉힌다. 시작 각도는 첫 고정 노드의 원하는 각도에 맞춘다(없으면 12시 방향).
    const step = TAU / ordered.length;
    const start = anchored.length ? anchored[0]!.mean! : -Math.PI / 2;
    ordered.forEach((w, i) => {
      const a = (start + i * step + TAU) % TAU;
      angles.set(w.n.id, a);
      positions.set(w.n.id, { x: Math.round(Math.cos(a) * radius), y: Math.round(Math.sin(a) * radius) });
    });
  }

  const xs = [...positions.values()].map((p) => p.x);
  const ys = [...positions.values()].map((p) => p.y);
  let minX = Math.min(...xs) - MARGIN_X;
  let maxX = Math.max(...xs) + MARGIN_X;
  let minY = Math.min(...ys) - MARGIN_Y;
  let maxY = Math.max(...ys) + MARGIN_Y + 14; // 아래쪽은 이름 한 줄
  const growX = Math.max(0, MIN_VIEW - (maxX - minX)) / 2;
  const growY = Math.max(0, MIN_VIEW * 0.75 - (maxY - minY)) / 2;
  minX -= growX;
  maxX += growX;
  minY -= growY;
  maxY += growY;
  return { positions, viewBox: { x: Math.floor(minX), y: Math.floor(minY), width: Math.ceil(maxX - minX), height: Math.ceil(maxY - minY) }, radii };
}
