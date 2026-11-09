/**
 * 핵심 성과 상세 성과 줄 편집(순수): 성과 양식 시트에서 Enter로 다음 줄을 넣고, 빈 줄에서 Backspace로 지운다.
 * 줄이 하나도 없을 때 시트는 안내 문구 한 줄(값 아님)을 보이므로, 그 자리에서는 줄을 만들지 않고 포커스만 옮긴다(입력하면 첫 줄이 생긴다).
 */
import { MAX_HIGHLIGHT_DETAILS } from "@/lib/domain/resumes";

/**
 * at 자리에 빈 줄을 넣는다(Enter). focus는 포커스할 줄 번호. 줄이 없으면 details null(바꾸지 않음)·focus 0. 상한이면 null.
 */
export function insertDetailLine(details: readonly string[], at: number): { details: string[] | null; focus: number } | null {
  if (details.length >= MAX_HIGHLIGHT_DETAILS) return null;
  if (details.length === 0) return { details: null, focus: 0 };
  const i = Math.max(0, Math.min(at, details.length));
  return { details: [...details.slice(0, i), "", ...details.slice(i)], focus: i };
}

/** j번째 줄을 지운다(빈 줄에서 Backspace). focus는 앞 줄 번호, 첫 줄이었으면 null(성과 요약으로). 지울 줄이 없으면 null. */
export function removeDetailLine(details: readonly string[], j: number): { details: string[]; focus: number | null } | null {
  if (j < 0 || j >= details.length) return null;
  return { details: details.filter((_, k) => k !== j), focus: j > 0 ? j - 1 : null };
}

/**
 * 시트에 그릴 상세 성과 줄(index는 details 안 자리 — data-field 경로·편집에 쓴다).
 * 편집: 모든 줄(빈 줄도 — 입력 중), 줄이 없으면 안내 문구용 빈 첫 줄 하나. 보기: 글이 있는 줄만(PDF·텍스트 내보내기와 같게).
 */
export function highlightDetailRows(details: readonly string[], edit: boolean): { value: string; index: number }[] {
  const rows = details.map((value, index) => ({ value, index }));
  if (!edit) return rows.filter((r) => r.value.trim());
  return rows.length > 0 ? rows : [{ value: "", index: 0 }];
}
