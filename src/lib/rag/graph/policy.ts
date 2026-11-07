/**
 * 그래프 조회 정책 상수(§5.1, §5.4). 공유 라벨 허용 목록은 비어 있다 — 지금 그래프에는 공유 노드가 없고, 스냅샷 쿼리는
 * :Career {userId}·Person {userId}만 읽는다. "userId가 없다"는 이유로 공유로 보지 않는다(공유 여부는 이 목록과 :Shared 라벨로만).
 */

/** 공유 온톨로지 라벨(`Shared:<NodeLabel>` 형식). 비어 있음. 테스트는 validatePlan의 opts.sharedLabels로 주입한다. */
export const SHARED_LABELS: readonly string[] = Object.freeze([]);

/** 시스템 속성 — 필터·정렬·그룹·반환 키로 쓸 수 없다(실행기만 다룬다). */
export const SYSTEM_PROP_KEYS: readonly string[] = Object.freeze(["id", "userId", "createdAt", "updatedAt"]);

/** min/max·gte/lte에 쓸 수 있는 날짜 키. */
export const DATE_PROP_KEYS: readonly string[] = Object.freeze(["startDate", "endDate", "date"]);

export const MAX_HOPS = 3;
export const MAX_PLAN_LIMIT = 50;
export const MAX_BINDINGS = 5000;
export const MAX_EVAL_MS = 200;
