/**
 * 공백 정리(순수, 선형 시간). 줄바꿈 양쪽에 공백 반복을 두거나 줄 끝 공백을 `+$`(m 플래그)로 찾는 정규식은 줄바꿈 없는 긴 공백 덩어리에서
 * 시작 위치마다 끝까지 다시 훑어 O(n²)이 된다(ReDoS). 업로드·외부 페이지 텍스트는 이 함수들로 정리한다.
 */

/** 공백 판정(코드 유닛). */
export type SpaceTest = (code: number) => boolean;

/** 스페이스·탭. */
export const isSpaceOrTab: SpaceTest = (c) => c === 0x20 || c === 0x09;
/** 스페이스·탭·NBSP. */
export const isSpaceTabNbsp: SpaceTest = (c) => c === 0x20 || c === 0x09 || c === 0xa0;

function trimStartBy(line: string, isSpace: SpaceTest): string {
  let i = 0;
  while (i < line.length && isSpace(line.charCodeAt(i))) i++;
  return i === 0 ? line : line.slice(i);
}

function trimEndBy(line: string, isSpace: SpaceTest): string {
  let j = line.length;
  while (j > 0 && isSpace(line.charCodeAt(j - 1))) j--;
  return j === line.length ? line : line.slice(0, j);
}

/** 각 줄 끝의 공백을 지운다(정규식 `[ \t]+$`·gm 치환과 같은 결과). */
export function trimLineEnds(text: string, isSpace: SpaceTest = isSpaceOrTab): string {
  return text
    .split("\n")
    .map((line) => trimEndBy(line, isSpace))
    .join("\n");
}

/** 줄바꿈 앞뒤의 공백만 지운다(정규식 `[ \t]*\n[ \t]*` → 줄바꿈 치환과 같은 결과). 문자열 맨 앞·맨 끝 공백은 그대로 둔다. */
export function trimAroundNewlines(text: string, isSpace: SpaceTest = isSpaceOrTab): string {
  const lines = text.split("\n");
  const last = lines.length - 1;
  return lines
    .map((line, i) => {
      let out = line;
      if (i > 0) out = trimStartBy(out, isSpace);
      if (i < last) out = trimEndBy(out, isSpace);
      return out;
    })
    .join("\n");
}

/**
 * 줄 안의 공백(\n 이외의 모든 \s)을 스페이스 하나로 접고, 줄바꿈 주변 공백과 연속 줄바꿈을 줄바꿈 하나로 합친 뒤 앞뒤를 자른다.
 * 공백 접기 → 줄바꿈 주변 공백 합치기 → trim을 정규식 백트래킹 없이 한다.
 */
export function collapseWhitespaceKeepLines(text: string): string {
  return text
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n[ \n]*/g, "\n")
    .trim();
}
