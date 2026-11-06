/**
 * 이력서 쪽 나눔(순수 함수). 웹 미리보기(ResumePreview·PerformanceSheet)가 화면에서 잰 블록 높이를 A4 쪽으로 나눈다.
 * PDF(@react-pdf, pdf.tsx·pdf-performance.tsx)도 같은 규칙을 따른다:
 *  - 묶음(group: 경력 한 건, 프로젝트 한 건, 핵심 성과 한 줄…)은 쪼개지 않고 통째로 다음 쪽으로 넘긴다.
 *  - 섹션 제목(keepWithNext)은 첫 항목과 함께 움직인다(제목만 쪽 끝에 남지 않는다).
 *  - 한 쪽보다 큰 묶음만 줄(블록 안 원자: 머리줄·불릿 하나…) 단위로 나눈다.
 *  - 쪽 맨 위에 오는 블록의 앞 간격(gapBefore)은 버린다.
 */

/** A4(210×297mm)를 CSS px(96dpi)·pt로. */
export const A4 = {
  widthPx: (210 * 96) / 25.4,
  heightPx: (297 * 96) / 25.4,
  widthPt: (210 * 72) / 25.4,
  heightPt: (297 * 72) / 25.4,
} as const;

export const ptToPx = (pt: number) => (pt * 96) / 72;
export const mmToPx = (mm: number) => (mm * 96) / 25.4;

export interface PageAtom {
  id: string;
  /** 블록 높이(px). */
  height: number;
  /** 같은 쪽에서 앞 블록과의 간격(px). 쪽 맨 위면 버린다. */
  gapBefore: number;
  /** 같은 group이 이어지는 블록들은 한 묶음(함께 넘어간다). */
  group: string;
  /** 다음 묶음의 첫 블록과 같은 쪽에 둔다(섹션 제목). */
  keepWithNext?: boolean;
}

export interface PaginateOptions {
  /** 한 쪽 본문 높이(px). */
  pageHeight: number;
  /** 첫 쪽 본문 높이(머리글을 뺀 높이 등). 없으면 pageHeight. */
  firstPageHeight?: number;
}

/** 소수점 오차로 1px도 안 되는 넘침 때문에 쪽이 바뀌지 않게. */
const EPS = 0.5;

interface Unit {
  atoms: PageAtom[];
  /** 이 개수만큼 앞 블록은 같은 쪽에 둔다(제목 + 첫 블록). */
  lead: number;
}

/** 이어진 같은 group을 묶고, keepWithNext 묶음은 다음 묶음과 합친다. */
export function toUnits(atoms: readonly PageAtom[]): Unit[] {
  const raw: PageAtom[][] = [];
  for (const a of atoms) {
    const last = raw[raw.length - 1];
    if (last && last[0]!.group === a.group) last.push(a);
    else raw.push([a]);
  }
  const units: Unit[] = [];
  let pending: PageAtom[] = [];
  for (const g of raw) {
    if (g.every((a) => a.keepWithNext)) {
      pending.push(...g);
      continue;
    }
    units.push({ atoms: [...pending, ...g], lead: pending.length > 0 ? pending.length + 1 : 1 });
    pending = [];
  }
  if (pending.length > 0) units.push({ atoms: pending, lead: pending.length });
  return units;
}

const stackHeight = (atoms: readonly PageAtom[], atTop: boolean) =>
  atoms.reduce((h, a, i) => h + a.height + (i === 0 && atTop ? 0 : a.gapBefore), 0);

/** 블록을 쪽에 나눠 담는다. 결과는 쪽마다 블록 id 목록(빈 입력이면 빈 쪽 하나). */
export function paginate(atoms: readonly PageAtom[], opts: PaginateOptions): string[][] {
  const pageHeight = Math.max(1, opts.pageHeight);
  const pages: string[][] = [[]];
  let used = 0;
  const cap = () => (pages.length === 1 ? (opts.firstPageHeight ?? pageHeight) : pageHeight);
  const current = () => pages[pages.length - 1]!;
  const newPage = () => {
    pages.push([]);
    used = 0;
  };
  const place = (a: PageAtom) => {
    used += a.height + (current().length === 0 ? 0 : a.gapBefore);
    current().push(a.id);
  };

  for (const unit of toUnits(atoms)) {
    const atTop = current().length === 0;
    // 1) 이 쪽에 통째로 들어가면 그대로
    if (used + stackHeight(unit.atoms, atTop) <= cap() + EPS) {
      unit.atoms.forEach(place);
      continue;
    }
    // 2) 새 쪽에는 통째로 들어가면 다음 쪽으로
    if (!atTop && stackHeight(unit.atoms, true) <= pageHeight + EPS) {
      newPage();
      unit.atoms.forEach(place);
      continue;
    }
    // 3) 한 쪽보다 큰 묶음: 줄 단위로 나눈다. 제목 + 첫 블록(lead)은 같은 쪽에서 시작한다.
    const lead = unit.atoms.slice(0, unit.lead);
    if (!atTop && used + stackHeight(lead, false) > cap() + EPS) newPage();
    unit.atoms.forEach((a, i) => {
      const h = a.height + (current().length === 0 ? 0 : a.gapBefore);
      if (i >= unit.lead && current().length > 0 && used + h > cap() + EPS) newPage();
      place(a);
    });
  }
  return pages;
}

/**
 * 쪽마다 담긴 블록이 쪽 높이를 넘는 만큼(px, 넘지 않으면 0). 더 나눌 수 없는 블록 하나가 한 쪽보다 클 때만 0보다 크다.
 * 미리보기는 이만큼 쪽 카드를 늘려 내용이 잘려 숨지 않게 한다.
 */
export function pageOverflow(atoms: readonly PageAtom[], pages: readonly string[][], opts: PaginateOptions): number[] {
  const byId = new Map(atoms.map((a) => [a.id, a]));
  return pages.map((ids, p) => {
    const cap = p === 0 ? (opts.firstPageHeight ?? opts.pageHeight) : opts.pageHeight;
    const list = ids.map((id) => byId.get(id)).filter((a): a is PageAtom => !!a);
    const h = stackHeight(list, true);
    return h > cap + EPS ? h - cap : 0;
  });
}

/**
 * PDF용 어림: 글자 수로 줄 수를 넉넉히(한글 한 글자 = 1em) 세어, 이 블록이 한 쪽을 넘을 수 있는지.
 * @react-pdf는 쪼개지 않는 상자(wrap=false)가 한 쪽보다 크면 잘라 버리므로, 넘을 수 있는 블록만 쪼갤 수 있게 둔다.
 * 넉넉히 세므로(실제보다 줄이 많다고 본다) '넘지 않는다'고 본 블록은 실제로도 한 쪽 안에 들어간다.
 */
export function mayExceedPage(
  texts: readonly string[],
  { widthPt, fontPt, lineHeight, pageHeightPt, extraLines = 0 }: { widthPt: number; fontPt: number; lineHeight: number; pageHeightPt: number; extraLines?: number },
): boolean {
  const perLine = Math.max(1, Math.floor(widthPt / fontPt));
  const lines =
    extraLines +
    texts
      .flatMap((t) => t.split("\n"))
      .map((t) => t.trim())
      .filter(Boolean)
      .reduce((n, t) => n + Math.ceil(t.length / perLine), 0);
  // 줄 간격·블록 간격 몫으로 85%만 쓴다고 본다.
  return lines * fontPt * lineHeight > pageHeightPt * 0.85;
}
