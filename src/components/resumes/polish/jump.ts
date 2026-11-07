import { polishFieldFromPath } from "@/lib/domain/resume-polish";

/**
 * 다듬기 제안의 칸으로 이동: 시트 편집 칸(data-field)을 찾아 화면 가운데로 옮기고 잠깐 테두리로 강조한다.
 * 칸이 화면에 없으면(입력 폼·다른 양식) false.
 */
export function highlightPolishField(path: string, root: ParentNode = document): boolean {
  const field = polishFieldFromPath(path);
  const el = root.querySelector<HTMLElement>(`[data-field="${CSS.escape(field)}"]`);
  if (!el) return false;
  el.scrollIntoView?.({ behavior: "smooth", block: "center" });
  const prev = { outline: el.style.outline, outlineOffset: el.style.outlineOffset };
  el.style.outline = "2px solid rgb(99 102 241)";
  el.style.outlineOffset = "2px";
  window.setTimeout(() => {
    el.style.outline = prev.outline;
    el.style.outlineOffset = prev.outlineOffset;
  }, 2000);
  return true;
}
