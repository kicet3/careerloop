"use client";
/**
 * 그래프 채팅 패널들(그래프 만들기·그래프에 묻기)이 함께 쓰는 브라우저 도우미: JSON·multipart 호출, 경과 시간, AI 엔진 선택.
 */
import { useEffect, useState } from "react";
import type { ProviderId, ProviderOption } from "@/lib/domain/providers";

export class ChatApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

/** fetch + JSON. json을 주면 JSON 본문, body(FormData 등)는 그대로. 실패하면 서버 문구로 ChatApiError. */
export async function chatApi<T>(url: string, init?: RequestInit & { json?: unknown }): Promise<T> {
  const res = await fetch(url, {
    ...init,
    headers: init?.json !== undefined ? { "Content-Type": "application/json" } : undefined,
    body: init?.json !== undefined ? JSON.stringify(init.json) : init?.body,
    cache: "no-store",
  });
  if (res.status === 204) return undefined as T;
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (!res.ok) throw new ChatApiError(data?.error ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.", res.status);
  return data as T;
}

/** since(ms) 이후 지난 초. null이면 0. */
export function useElapsed(since: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (since === null) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [since]);
  return since === null ? 0 : Math.max(0, Math.floor((now - since) / 1000));
}

/** 준비된 AI 엔진 목록과 선택(localStorage에 기억). */
export function useProviderChoice(storageKey: string) {
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  useEffect(() => {
    let alive = true;
    chatApi<{ options: ProviderOption[] }>("/api/providers")
      .then((r) => {
        if (!alive) return;
        const ready = r.options.filter((o) => o.ready);
        setProviders(r.options);
        const saved = window.localStorage.getItem(storageKey);
        setProvider(ready.find((o) => o.id === saved)?.id ?? ready[0]?.id ?? null);
      })
      .catch(() => alive && setProviders([]));
    return () => {
      alive = false;
    };
  }, [storageKey]);
  const ready = providers?.filter((p) => p.ready) ?? [];
  const choose = (id: ProviderId) => {
    setProvider(id);
    window.localStorage.setItem(storageKey, id);
  };
  return { providers, ready, provider, choose, noEngine: providers !== null && ready.length === 0 };
}
