import { describe, expect, it } from "vitest";
import { A4, mayExceedPage, pageOverflow, paginate, toUnits, type PageAtom } from "./pagination";

const atom = (id: string, height: number, group = id, extra: Partial<PageAtom> = {}): PageAtom => ({ id, height, gapBefore: 0, group, ...extra });

describe("paginate", () => {
  it("한 쪽에 들어가면 한 쪽, 빈 입력은 빈 쪽 하나", () => {
    expect(paginate([], { pageHeight: 100 })).toEqual([[]]);
    expect(paginate([atom("a", 30), atom("b", 30), atom("c", 40)], { pageHeight: 100 })).toEqual([["a", "b", "c"]]);
  });

  it("묶음은 쪼개지 않고 통째로 다음 쪽으로 넘긴다", () => {
    const atoms = [atom("a", 60), atom("b1", 20, "b"), atom("b2", 20, "b"), atom("b3", 20, "b"), atom("c", 30)];
    expect(paginate(atoms, { pageHeight: 100 })).toEqual([["a"], ["b1", "b2", "b3", "c"]]);
  });

  it("쪽 맨 위 블록의 앞 간격은 버린다", () => {
    const atoms = [atom("a", 90), atom("b", 100, "b", { gapBefore: 10 })];
    // b는 간격 10을 더하면 110이라 첫 쪽에도 새 쪽에도 안 들어갈 것 같지만, 새 쪽 맨 위에서는 간격이 없어 100으로 들어간다.
    expect(paginate(atoms, { pageHeight: 100 })).toEqual([["a"], ["b"]]);
    // 간격 때문에 넘치면 다음 쪽으로
    expect(paginate([atom("a", 85), atom("b", 10, "b", { gapBefore: 10 })], { pageHeight: 100 })).toEqual([["a"], ["b"]]);
  });

  it("한 쪽보다 큰 묶음만 줄 단위로 나누고, 이 쪽의 남은 자리부터 채운다", () => {
    const lines = Array.from({ length: 6 }, (_, i) => atom(`x${i}`, 30, "x"));
    expect(paginate([atom("a", 40), ...lines], { pageHeight: 100 })).toEqual([
      ["a", "x0", "x1"],
      ["x2", "x3", "x4"],
      ["x5"],
    ]);
  });

  it("섹션 제목은 첫 항목과 같은 쪽에 둔다", () => {
    const atoms = [atom("a", 70), atom("h", 10, "h", { keepWithNext: true }), atom("i1", 30, "i1"), atom("i2", 10, "i2")];
    // 제목(10)은 첫 쪽에 들어가지만 첫 항목(30)이 안 들어가므로 제목도 함께 넘어간다.
    expect(paginate(atoms, { pageHeight: 100 })).toEqual([["a"], ["h", "i1", "i2"]]);
  });

  it("제목 + 큰 첫 항목: 제목과 첫 줄이 들어갈 자리가 있으면 이 쪽에서 시작해 줄 단위로 나눈다", () => {
    const big = Array.from({ length: 5 }, (_, i) => atom(`b${i}`, 30, "big"));
    const atoms = [atom("a", 40), atom("h", 10, "h", { keepWithNext: true }), ...big];
    expect(paginate(atoms, { pageHeight: 100 })).toEqual([
      ["a", "h", "b0"],
      ["b1", "b2", "b3"],
      ["b4"],
    ]);
    // 제목 + 첫 줄이 안 들어가면 함께 다음 쪽에서 시작
    expect(paginate([atom("a", 70), ...atoms.slice(1)], { pageHeight: 100 })).toEqual([
      ["a"],
      ["h", "b0", "b1", "b2"],
      ["b3", "b4"],
    ]);
  });

  it("제목만 있고 항목이 없으면 제목 하나의 묶음", () => {
    expect(toUnits([atom("h", 10, "h", { keepWithNext: true })])).toEqual([{ atoms: [atom("h", 10, "h", { keepWithNext: true })], lead: 1 }]);
  });

  it("첫 쪽은 머리글을 뺀 높이를 쓸 수 있다", () => {
    const atoms = [atom("a", 50), atom("b", 50), atom("c", 50)];
    expect(paginate(atoms, { pageHeight: 100, firstPageHeight: 60 })).toEqual([["a"], ["b", "c"]]);
  });

  it("한 쪽보다 큰 원자 하나는 혼자 한 쪽(무한 반복 없이)", () => {
    expect(paginate([atom("a", 10), atom("b", 250), atom("c", 10)], { pageHeight: 100 })).toEqual([["a"], ["b"], ["c"]]);
  });

  it("긴 이력서(경력 12건·불릿 5개씩)는 여러 쪽, 모든 블록이 순서대로 한 번씩", () => {
    const atoms: PageAtom[] = [atom("header", 120)];
    atoms.push(atom("h-exp", 30, "h-exp", { keepWithNext: true, gapBefore: 16 }));
    for (let i = 0; i < 12; i++) {
      atoms.push(atom(`e${i}`, 22, `e${i}`, { gapBefore: i === 0 ? 8 : 9 }));
      for (let j = 0; j < 5; j++) atoms.push(atom(`e${i}.b${j}`, 20, `e${i}`, { gapBefore: 2 }));
    }
    const pageHeight = A4.heightPx - 2 * ((40 * 96) / 72);
    const pages = paginate(atoms, { pageHeight });
    expect(pages.length).toBe(2);
    expect(pages.flat()).toEqual(atoms.map((a) => a.id));
    // 경력 한 건이 두 쪽에 걸치지 않는다
    for (const p of pages) {
      const groups = new Set(p.map((id) => id.split(".")[0]));
      for (const g of groups) if (g.startsWith("e")) expect(pages.filter((q) => q.some((id) => id.split(".")[0] === g))).toHaveLength(1);
    }
    // 각 쪽 높이가 쪽 높이를 넘지 않는다
    const byId = new Map(atoms.map((a) => [a.id, a]));
    for (const p of pages) {
      const h = p.reduce((n, id, i) => n + byId.get(id)!.height + (i === 0 ? 0 : byId.get(id)!.gapBefore), 0);
      expect(h).toBeLessThanOrEqual(pageHeight + 0.5);
    }
  });
});

describe("mayExceedPage", () => {
  const opts = { widthPt: 500, fontPt: 10, lineHeight: 1.5, pageHeightPt: 760 };
  it("짧은 항목은 넘지 않는다고, 아주 긴 항목은 넘을 수 있다고 본다", () => {
    expect(mayExceedPage(["회사 | 직무", "결제 API 응답 시간을 40% 줄였습니다."], opts)).toBe(false);
    expect(mayExceedPage(Array.from({ length: 15 }, () => "가".repeat(400)), opts)).toBe(true);
  });
});

describe("pageOverflow", () => {
  it("쪽 높이를 넘는 만큼만(나눌 수 없는 큰 블록), 아니면 0", () => {
    const atoms = [atom("a", 40), atom("big", 250), atom("c", 30, "c", { gapBefore: 10 })];
    const opts = { pageHeight: 100, firstPageHeight: 80 };
    const pages = paginate(atoms, opts);
    expect(pages).toEqual([["a"], ["big"], ["c"]]);
    expect(pageOverflow(atoms, pages, opts)).toEqual([0, 150, 0]);
  });

  it("첫 쪽은 firstPageHeight 기준", () => {
    const atoms = [atom("big", 120)];
    expect(pageOverflow(atoms, paginate(atoms, { pageHeight: 200, firstPageHeight: 100 }), { pageHeight: 200, firstPageHeight: 100 })).toEqual([20]);
  });
});
