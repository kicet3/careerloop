/**
 * 수치 확인(순수): 생성된 문장의 숫자가 근거 자료에 있는지 본다. 그래프 포트폴리오(portfolios/graph-material.ts)와
 * 그래프 이력서 에이전트(resume-agent/verify.ts)가 같은 규칙을 쓴다 — 근거에 없는 숫자는 [ADD: 수치 확인 — …]로 바꾼다.
 */

const NUM_RE = /\d+(?:[.,]\d+)*/g;
const normNum = (s: string) => s.replace(/,/g, "");

/** text의 숫자 중 source에 없는 것(쉼표는 무시). */
export function unverifiedNumbers(text: string, source: string): string[] {
  const known = new Set((source.match(NUM_RE) ?? []).map(normNum));
  return [...new Set((text.match(NUM_RE) ?? []).map(normNum))].filter((n) => !known.has(n));
}

/** [ADD: ...] 안의 숫자는 자리표시라 확인하지 않는다. */
export const stripPlaceholders = (s: string): string => s.replace(/\[ADD:[^\]]*\]/g, " ");
