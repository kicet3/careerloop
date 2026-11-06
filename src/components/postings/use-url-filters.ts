"use client";
/**
 * 주소(?쿼리)에 담긴 목록 조건을 입력칸과 맞춘다(공고 보관함·공고 찾기 공용).
 * - 입력칸은 draft(화면 상태)를 바꾸고, 잠깐(300ms) 멈추면 1쪽 주소로 바꾼다(router.replace — 기록을 쌓지 않는다).
 *   조건이 바뀌면 쪽은 항상 1쪽으로 돌아간다(toQuery(draft)에 page를 싣지 않는다).
 * - 뒤로 가기 등으로 주소가 바뀌면 draft를 주소 조건으로 되돌린다. 내가 방금 바꾼 주소면(입력 중) 그대로 둔다.
 * - pending: 주소를 바꾸고 서버가 새 목록을 그리는 동안 true(목록을 흐리게).
 */
import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

export function useUrlFilters<F>({ path, filters, toQuery }: { path: string; filters: F; toQuery: (f: F) => string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [draft, setDraft] = useState<F>(filters);
  const propKey = toQuery(filters);
  const [syncedKey, setSyncedKey] = useState(propKey);
  const [pushedKey, setPushedKey] = useState<string | null>(null);
  // 주소 조건이 바뀌었다(렌더 중 조정): 내가 바꾼 주소가 아니면 입력칸을 주소에 맞춘다. 한 번 맞춘 뒤에는 '내가 바꾼 주소'
  // 표시를 지운다 — 남겨 두면 뒤로 가기 → 앞으로 가기로 그 주소에 다시 왔을 때 입력칸을 맞추지 않아, 옛 입력칸이 주소를 되돌린다.
  if (propKey !== syncedKey) {
    setSyncedKey(propKey);
    if (propKey !== pushedKey) setDraft(filters);
    if (pushedKey !== null) setPushedKey(null);
  }

  const draftKey = toQuery(draft);
  useEffect(() => {
    if (draftKey === propKey) return;
    const timer = setTimeout(() => {
      setPushedKey(draftKey);
      startTransition(() => router.replace(draftKey ? `${path}?${draftKey}` : path, { scroll: false }));
    }, 300);
    return () => clearTimeout(timer);
  }, [draftKey, propKey, path, router]);

  const set = <K extends keyof F>(k: K, v: F[K]) => setDraft((f) => ({ ...f, [k]: v }));
  return { draft, setDraft, set, pending: pending || draftKey !== propKey, startTransition };
}
