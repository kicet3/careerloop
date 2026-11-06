import { describe, expect, it } from "vitest";
import { sheetPushes, type SheetBlock } from "./sheet-pagination";

/** 위에서부터 차례로 쌓인 블록(top은 앞 블록 아래 + gap). */
function stack(specs: { id: string; h: number; gap?: number; group?: string; keep?: boolean; kind?: "margin" | "padding"; base?: number }[]): SheetBlock[] {
  let y = 0;
  return specs.map((s, i) => {
    const gap = s.gap ?? 0;
    const top = y + gap;
    y = top + s.h;
    return {
      atom: { id: s.id, group: s.group ?? s.id, height: s.h, gapBefore: gap, keepWithNext: s.keep },
      path: [i],
      kind: s.kind ?? "padding",
      base: s.base ?? 0,
      top,
    };
  });
}

describe("sheetPushes", () => {
  it("한 쪽에 들어가면 여백 없음", () => {
    expect(sheetPushes(stack([{ id: "a", h: 40 }, { id: "b", h: 50 }]), 100, 130)).toEqual({ pages: 1, pushes: [] });
  });

  it("다음 쪽 첫 블록을 (쪽 번호 × 쪽 간격) 위치로 밀고, 앞 여백만큼 뒤 블록 위치를 고쳐 센다", () => {
    const blocks = stack([
      { id: "a", h: 60 },
      { id: "b", h: 60, base: 4 },
      { id: "c", h: 60, kind: "margin", base: 8 },
    ]);
    const r = sheetPushes(blocks, 100, 130);
    expect(r.pages).toBe(3);
    // b: top 60 → 130으로 70만큼(원래 padding 4에 더해)
    // c: top 120 + 앞서 민 70 = 190 → 260으로 70만큼(원래 margin 8에 더해)
    expect(r.pushes).toEqual([
      { path: [1], kind: "padding", value: 74 },
      { path: [2], kind: "margin", value: 78 },
    ]);
  });

  it("쪽 맨 위 블록의 앞 간격도 밀어낼 거리에 들어간다(블록 상자 위가 쪽 위에 오게)", () => {
    const blocks = stack([
      { id: "a", h: 90 },
      { id: "b", h: 30, gap: 20 },
    ]);
    // b의 top은 110(간격 포함). 쪽 2의 시작 130까지 20만 민다.
    expect(sheetPushes(blocks, 100, 130).pushes).toEqual([{ path: [1], kind: "padding", value: 20 }]);
  });

  it("섹션 머리는 첫 항목과 함께 넘어가서 머리가 밀린다", () => {
    const blocks = stack([
      { id: "a", h: 80 },
      { id: "s", h: 10, keep: true, kind: "margin" },
      { id: "r", h: 30 },
    ]);
    const r = sheetPushes(blocks, 100, 130);
    expect(r.pages).toBe(2);
    expect(r.pushes).toEqual([{ path: [1], kind: "margin", value: 50 }]);
  });
});
