"use client";

/**
 * 이력서 편집 목록(경력·프로젝트 등)의 순서 바꾸기: 항목 정체성(React key)과 끌어서 옮기기·버튼·방향키.
 *
 * - 정체성: 저장 문서(ResumeDocument)에는 id가 없다. 화면에서만 항목 객체 → key를 WeakMap으로 들고,
 *   항목을 고칠 때(patchItem) 새 객체로 key를 넘긴다. 순서를 바꾸면 key가 항목을 따라가므로 칸의 지역 상태
 *   (ListText 원문·MonthInput 표시·contenteditable 내용)가 엉뚱한 자리에 남지 않는다. 저장 형식은 그대로다.
 *   바깥에서 통째로 바뀐 항목(버전 복원·AI 적용)은 새 key를 받아 새로 그린다.
 * - 끌기: 마우스는 HTML5 drag-and-drop(손잡이만 draggable — 입력 칸의 글 선택을 막지 않는다),
 *   터치·펜은 포인터 이벤트(손잡이를 누른 채 움직이면 손가락 아래 항목 자리로)로 옮긴다.
 * - 키보드: 손잡이에서 ↑/↓는 한 칸, Home/End는 맨 위/맨 아래로(Enter·Space는 이 사용법을 알린다). 옮긴 뒤 같은 컨트롤로 포커스를 되돌리고 aria-live로 알린다.
 */
import { useCallback, useEffect, useId, useState } from "react";

// ---------------------------------------------------------------------------
// 항목 key(화면 전용)
// ---------------------------------------------------------------------------

const keys = new WeakMap<object, string>();
let seq = 0;

/** 항목 객체의 화면용 key. 처음 보면 새로 만든다. */
export function itemKey(item: object): string {
  let k = keys.get(item);
  if (!k) {
    k = `item-${++seq}`;
    keys.set(item, k);
  }
  return k;
}

/** 목록의 key들. 같은 객체가 두 번 들어 있어도 key가 겹치지 않게 한다. */
export function itemKeys(items: readonly object[]): string[] {
  const used = new Set<string>();
  return items.map((x, i) => {
    let k = itemKey(x);
    if (used.has(k)) k = `${k}~${i}`;
    used.add(k);
    return k;
  });
}

/** 항목 하나를 고친 새 객체(같은 key를 이어받는다). */
export function patchItem<T extends object>(item: T, patch: Partial<T>): T {
  const next = { ...item, ...patch };
  const k = keys.get(item);
  if (k) keys.set(next, k);
  return next;
}

/** from 자리 항목을 to 자리로 옮긴 새 배열(범위 밖·같은 자리면 원래 배열). */
export function moveItem<T>(xs: readonly T[], from: number, to: number): T[] {
  if (from === to || from < 0 || to < 0 || from >= xs.length || to >= xs.length) return xs as T[];
  const next = [...xs];
  const [x] = next.splice(from, 1);
  next.splice(to, 0, x!);
  return next;
}

// ---------------------------------------------------------------------------
// 끌기·버튼·키보드 처리(React 밖에서도 시험할 수 있게 상태 저장소를 받는다)
// ---------------------------------------------------------------------------

export interface ReorderState {
  /** 끌고 있는 항목 자리(없으면 null). */
  from: number | null;
  /** 지금 놓을 자리. */
  over: number | null;
  /** 터치·펜으로 끄는 중인 포인터. */
  pointerId: number | null;
}

export const IDLE: ReorderState = { from: null, over: null, pointerId: null };

export type ReorderControl = "up" | "down" | "handle";

/** 이벤트에서 쓰는 부분만(테스트는 가짜 객체를 넣는다). */
interface DataTransferLike {
  effectAllowed?: string;
  dropEffect?: string;
  setData?: (format: string, data: string) => void;
  setDragImage?: (image: Element, x: number, y: number) => void;
}
interface DragLike {
  preventDefault: () => void;
  dataTransfer?: DataTransferLike | null;
  currentTarget?: unknown;
}
interface PointerLike {
  pointerId: number;
  pointerType: string;
  clientX: number;
  clientY: number;
  preventDefault?: () => void;
  currentTarget?: unknown;
}
interface KeyLike {
  key: string;
  preventDefault: () => void;
  altKey?: boolean;
  ctrlKey?: boolean;
  metaKey?: boolean;
}

export interface ReorderOptions {
  /** 목록 구분자(data-reorder-group). 다른 목록에 놓는 것을 막는다. */
  group: string;
  count: number;
  get: () => ReorderState;
  set: (s: ReorderState) => void;
  /** 순서를 바꾼다. control은 옮긴 뒤 포커스를 둘 컨트롤. */
  onMove: (from: number, to: number, control?: ReorderControl) => void;
  /** 화면 좌표의 요소(터치 끌기용). 기본은 document.elementFromPoint. */
  hitTest?: (x: number, y: number) => Element | null;
  /** 화면 좌표가 이 목록 상자(항목들을 감싼 범위) 안인지(터치 끌기용). 기본은 항목들의 화면 위치로 잰다. */
  inside?: (x: number, y: number) => boolean;
  /** 손잡이에서 Enter·Space(누르기)를 했을 때 — 끌기 대신 쓰는 방법을 알린다. */
  onHint?: () => void;
}

/** 끌기 데이터 형식. text/plain으로 두면 목록 밖 입력 칸에 놓았을 때 브라우저가 그 글을 칸에 넣는다(문서가 바뀐다). */
export const DRAG_TYPE = "application/x-resume-reorder";

const ITEM_ATTR = "data-reorder-item";
const GROUP_ATTR = "data-reorder-group";

function indexAt(group: string, el: Element | null): number | null {
  const item = el?.closest?.(`[${ITEM_ATTR}]`);
  if (!item || item.getAttribute(GROUP_ATTR) !== group) return null;
  const n = Number(item.getAttribute(ITEM_ATTR));
  return Number.isInteger(n) ? n : null;
}

/** 목록 항목들을 감싼 화면 범위 안인지(항목 사이 틈도 안으로 본다). */
function insideGroup(group: string, x: number, y: number): boolean {
  if (typeof document === "undefined") return false;
  const boxes = [...document.querySelectorAll(`[${ITEM_ATTR}]`)]
    .filter((el) => el.getAttribute(GROUP_ATTR) === group)
    .map((el) => el.getBoundingClientRect());
  if (!boxes.length) return false;
  const top = Math.min(...boxes.map((b) => b.top));
  const bottom = Math.max(...boxes.map((b) => b.bottom));
  const left = Math.min(...boxes.map((b) => b.left));
  const right = Math.max(...boxes.map((b) => b.right));
  return x >= left && x <= right && y >= top && y <= bottom;
}

/** 터치 끌기 중 손가락이 화면(스크롤 상자) 가장자리에 가면 그쪽으로 조금 굴린다 — 화면 밖 자리에도 닿게. */
const EDGE = 48;
const STEP = 16;
function autoScroll(from: unknown, y: number) {
  if (typeof window === "undefined" || typeof document === "undefined") return;
  let el = from instanceof Element ? from.parentElement : null;
  while (el) {
    const oy = getComputedStyle(el).overflowY;
    if ((oy === "auto" || oy === "scroll") && el.scrollHeight > el.clientHeight) break;
    el = el.parentElement;
  }
  const box = el ? el.getBoundingClientRect() : { top: 0, bottom: window.innerHeight };
  const dy = y < box.top + EDGE ? -STEP : y > box.bottom - EDGE ? STEP : 0;
  if (!dy) return;
  if (el) el.scrollTop += dy;
  else window.scrollBy(0, dy);
}

export function reorderHandlers({ group, count, get, set, onMove, hitTest, inside, onHint }: ReorderOptions) {
  const clear = () => set(IDLE);
  const finish = (from: number | null, to: number | null) => {
    clear();
    if (from !== null && to !== null && from !== to) onMove(from, to);
  };
  const hit = (x: number, y: number) => (hitTest ? hitTest(x, y) : typeof document === "undefined" ? null : document.elementFromPoint(x, y));
  const within = (x: number, y: number) => (inside ? inside(x, y) : insideGroup(group, x, y));

  return {
    /** 항목 상자(놓을 자리). */
    item: (i: number) => ({
      [ITEM_ATTR]: String(i),
      [GROUP_ATTR]: group,
      onDragOver: (e: DragLike) => {
        const s = get();
        // 이 목록에서 시작한 끌기만 받는다(파일·다른 목록의 끌기는 무시).
        if (s.from === null || s.pointerId !== null) return;
        e.preventDefault();
        if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
        if (s.over !== i) set({ ...s, over: i });
      },
      onDrop: (e: DragLike) => {
        const s = get();
        if (s.from === null || s.pointerId !== null) return;
        e.preventDefault();
        finish(s.from, i);
      },
    }),
    /** 끌기 손잡이(버튼). */
    handle: (i: number) => ({
      draggable: true,
      "data-reorder-control": "handle" as const,
      onDragStart: (e: DragLike) => {
        const dt = e.dataTransfer;
        if (dt) {
          dt.effectAllowed = "move";
          // Firefox는 데이터가 있어야 끌기를 시작한다. 입력 칸이 받지 않는 형식으로 둔다(목록 밖에 놓아도 글이 들어가지 않게).
          dt.setData?.(DRAG_TYPE, "");
          const box = (e.currentTarget as Element | null)?.closest?.(`[${ITEM_ATTR}]`);
          if (box && dt.setDragImage) dt.setDragImage(box, 16, 16);
        }
        set({ from: i, over: i, pointerId: null });
      },
      onDragEnd: () => {
        if (get().pointerId === null) clear();
      },
      onPointerDown: (e: PointerLike) => {
        // 마우스는 HTML5 끌기로. 터치·펜은 포인터를 붙잡고 직접 따라간다.
        if (e.pointerType === "mouse") return;
        const el = e.currentTarget as { setPointerCapture?: (id: number) => void } | null;
        try {
          el?.setPointerCapture?.(e.pointerId);
        } catch {
          // 이미 놓인 포인터 등
        }
        set({ from: i, over: i, pointerId: e.pointerId });
      },
      onPointerMove: (e: PointerLike) => {
        const s = get();
        if (s.pointerId === null || s.pointerId !== e.pointerId) return;
        e.preventDefault?.();
        const at = indexAt(group, hit(e.clientX, e.clientY));
        if (at !== null && at !== s.over) set({ ...s, over: at });
        if (!hitTest) autoScroll(e.currentTarget, e.clientY);
      },
      onPointerUp: (e: PointerLike) => {
        const s = get();
        if (s.pointerId === null || s.pointerId !== e.pointerId) return;
        // 놓은 자리는 뗀 좌표로 다시 잰다(마지막 pointermove 상태가 아직 다시 그려지기 전일 수 있다).
        // 목록 밖에서 떼면 취소(마우스 끌기를 목록 밖에 놓은 것과 같게). 항목 사이 틈이면 마지막으로 지난 자리로.
        const at = indexAt(group, hit(e.clientX, e.clientY));
        finish(s.from, at ?? (within(e.clientX, e.clientY) ? s.over : null));
      },
      onPointerCancel: (e: PointerLike) => {
        if (get().pointerId === e.pointerId) clear();
      },
      onKeyDown: (e: KeyLike) => {
        if (e.altKey || e.ctrlKey || e.metaKey) return;
        // role=button이라 화면 낭독기는 Enter·Space로 "누른다" — 반응 없이 끝나지 않게 쓰는 법을 알린다.
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onHint?.();
          return;
        }
        const to =
          e.key === "ArrowUp" ? i - 1 : e.key === "ArrowDown" ? i + 1 : e.key === "Home" ? 0 : e.key === "End" ? count - 1 : null;
        if (to === null) return;
        e.preventDefault();
        if (to >= 0 && to < count && to !== i) onMove(i, to, "handle");
      },
    }),
    up: (i: number) => ({ disabled: i === 0, "data-reorder-control": "up" as const, onClick: () => onMove(i, i - 1, "up") }),
    down: (i: number) => ({
      disabled: i >= count - 1,
      "data-reorder-control": "down" as const,
      onClick: () => onMove(i, i + 1, "down"),
    }),
  };
}

export type ReorderHandlers = ReturnType<typeof reorderHandlers>;

// ---------------------------------------------------------------------------
// React 훅
// ---------------------------------------------------------------------------

/** 순서 변경 알림(aria-live 영역에 넣을 문장). 같은 문장을 다시 알려도 읽히게 매번 새 값으로 둔다. */
export function useAnnouncer() {
  const [message, setMessage] = useState("");
  const announce = useCallback((m: string) => setMessage((prev) => (prev === m ? `${m} ` : m)), []);
  return [message, announce] as const;
}

/** 손잡이를 눌렀을 때(Enter·Space) 읽을 안내. */
export const HANDLE_HINT = "방향키 ↑↓로 한 칸씩, Home·End로 맨 위·맨 아래로 옮깁니다. 위로·아래로 버튼으로도 옮길 수 있습니다.";

/** 순서를 바꾼 뒤 읽을 문장. */
export function movedMessage(name: string, to: number, count: number) {
  return `${name}을(를) ${to + 1}번째로 옮겼습니다. 전체 ${count}개.`;
}

export function useReorder<T extends object>({
  items,
  onChange,
  name,
  announce,
}: {
  items: readonly T[];
  onChange: (next: T[]) => void;
  /** 알림에 쓸 항목 이름(옮기기 전 자리 기준). */
  name: (item: T, i: number) => string;
  announce: (message: string) => void;
}) {
  const group = useId();
  const [state, setState] = useState<ReorderState>(IDLE);
  const [focus, setFocus] = useState<{ index: number; control: ReorderControl } | null>(null);

  // 옮긴 항목의 같은 컨트롤로 포커스를 돌린다(그 컨트롤이 막혔으면 손잡이로).
  useEffect(() => {
    if (!focus) return;
    const box = [...document.querySelectorAll(`[${GROUP_ATTR}]`)].find(
      (el) => el.getAttribute(GROUP_ATTR) === group && el.getAttribute(ITEM_ATTR) === String(focus.index),
    );
    const want = box?.querySelector<HTMLElement>(`[data-reorder-control="${focus.control}"]:not(:disabled)`);
    (want ?? box?.querySelector<HTMLElement>(`[data-reorder-control="handle"]`))?.focus();
    // eslint-disable-next-line react-hooks/set-state-in-effect -- 한 번 옮기고 비운다
    setFocus(null);
  }, [focus, group]);

  const handlers = reorderHandlers({
    group,
    count: items.length,
    get: () => state,
    set: setState,
    onHint: () => announce(HANDLE_HINT),
    onMove: (from, to, control) => {
      const next = moveItem(items, from, to);
      if (next === items) return;
      onChange(next);
      announce(movedMessage(name(items[from]!, from), to, items.length));
      if (control) setFocus({ index: to, control });
    },
  });
  return { ...handlers, keys: itemKeys(items), dragging: state.from, over: state.over };
}
