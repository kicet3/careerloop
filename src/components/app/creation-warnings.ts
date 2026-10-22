/**
 * 진단 생성 직후의 입력 경고(예: "채용 공고가 매우 짧습니다")를 진행 화면에 한 번 넘겨주는 통로.
 * URL 쿼리로 넘기면 누구나 임의 문구를 사이트의 경고 상자에 띄우는 링크를 만들 수 있으므로,
 * 같은 탭의 sessionStorage에 진단 id별로 담고 읽은 즉시 지운다.
 */
const PREFIX = "rp:create-warnings:";
const MAX_ITEMS = 5;
const MAX_LEN = 200;

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem">;

function storage(): StorageLike | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage;
  } catch {
    return null;
  }
}

export function saveCreationWarnings(id: string, warnings: string[], store: StorageLike | null = storage()): void {
  if (!store || warnings.length === 0) return;
  try {
    store.setItem(PREFIX + id, JSON.stringify(warnings.slice(0, MAX_ITEMS).map((w) => w.slice(0, MAX_LEN))));
  } catch {
    // 저장소를 못 쓰면 경고를 생략한다.
  }
}

/** 저장된 경고를 읽고 지운다. 형식이 틀리면 빈 배열. */
export function takeCreationWarnings(id: string, store: StorageLike | null = storage()): string[] {
  if (!store) return [];
  try {
    const raw = store.getItem(PREFIX + id);
    store.removeItem(PREFIX + id);
    if (!raw) return [];
    const v: unknown = JSON.parse(raw);
    return Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string").slice(0, MAX_ITEMS).map((x) => x.slice(0, MAX_LEN))
      : [];
  } catch {
    return [];
  }
}
