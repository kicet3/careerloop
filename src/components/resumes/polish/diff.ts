/**
 * 다듬기 적용 전 미리보기용 낱말 단위 차이(순수). 공백도 조각으로 남겨 이으면 원문이 된다.
 * 칸 하나(최대 수천 자)라 단순 LCS로 충분하다. 너무 길면 차이 없이 전체 삭제·추가로 본다.
 */
export type DiffPart = { kind: "same" | "del" | "add"; text: string };

const MAX_TOKENS = 600;

function tokens(s: string): string[] {
  return s.match(/\s+|[^\s]+/g) ?? [];
}

/** before → after 차이. 같은 조각·지운 조각·더한 조각 순서대로(이웃한 같은 종류는 합친다). */
export function wordDiff(before: string, after: string): DiffPart[] {
  const a = tokens(before);
  const b = tokens(after);
  const out: DiffPart[] = [];
  const push = (kind: DiffPart["kind"], text: string) => {
    const last = out.at(-1);
    if (last && last.kind === kind) last.text += text;
    else if (text) out.push({ kind, text });
  };
  if (a.length > MAX_TOKENS || b.length > MAX_TOKENS) {
    push("del", before);
    push("add", after);
    return out;
  }
  // lcs[i][j] = a[i..]와 b[j..]의 최장 공통 부분열 길이
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i++;
      j++;
    } else if (lcs[i + 1]![j]! >= lcs[i]![j + 1]!) push("del", a[i++]!);
    else push("add", b[j++]!);
  }
  while (i < a.length) push("del", a[i++]!);
  while (j < b.length) push("add", b[j++]!);
  return out;
}
