/**
 * GitHub 연동 화면 공용 도우미(클라이언트). API 응답은 { error, code } 오류 형식이다(src/lib/github/http.ts).
 */
import type { GithubRepoDetailView, GithubRepoListItem, GithubStatusView } from "@/lib/github/types";
import type { ChatMessage, ChatThread } from "@/lib/domain/chat";

export class GithubClientError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string | null,
  ) {
    super(message);
    this.name = "GithubClientError";
  }
}

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(url, { cache: "no-store", ...init });
  } catch {
    throw new GithubClientError("네트워크 오류가 발생했습니다.", 0, null);
  }
  const json = (await res.json().catch(() => null)) as (T & { error?: string; code?: string }) | null;
  if (!res.ok) throw new GithubClientError(json?.error ?? "요청을 처리하지 못했습니다.", res.status, json?.code ?? null);
  return json as T;
}

const jsonInit = (method: string, body?: unknown): RequestInit => ({
  method,
  headers: { "Content-Type": "application/json" },
  body: body === undefined ? undefined : JSON.stringify(body),
});

const repoPath = (fullName: string) => {
  const [owner, repo] = fullName.split("/");
  return `${encodeURIComponent(owner ?? "")}/${encodeURIComponent(repo ?? "")}`;
};

export const githubApi = {
  status: () => call<GithubStatusView>("/api/github/status"),
  setIncludePrivate: (includePrivate: boolean) => call<GithubStatusView>("/api/github/settings", jsonInit("PATCH", { includePrivate })),
  disconnect: () => call<{ revoked: boolean; deleted: boolean; status: GithubStatusView }>("/api/github/disconnect", jsonInit("POST")),
  repos: () => call<{ login: string; includePrivate: boolean; repos: GithubRepoListItem[] }>("/api/github/repos"),
  repo: (fullName: string) => call<GithubRepoDetailView & { fetched: boolean }>(`/api/github/repos/${repoPath(fullName)}`),
  sync: (fullName: string) => call<GithubRepoDetailView & { fetched: boolean }>(`/api/github/repos/${repoPath(fullName)}/sync`, jsonInit("POST")),
  startImport: (input: { fullName: string; projectNodeId: string; refresh?: boolean; threadId?: string | null; provider?: string | null }) =>
    call<{ thread: ChatThread; message: ChatMessage; projectNodeId: string; created: boolean }>("/api/graph/chat/github-import", jsonInit("POST", input)),
};

/** 그래프 화면: 저장소 고르기 창 열기(선택: 그 저장소로 바로, 그 프로젝트에 잇기). GraphChatPanel이 듣는다. */
export const GITHUB_PICKER_EVENT = "careerloop:github-picker";
export type GithubPickerEventDetail = { fullName?: string; projectNodeId?: string };

/** 받은 채팅 패널이 없으면 false. */
export function openGithubPicker(detail: GithubPickerEventDetail = {}): boolean {
  const ev = new CustomEvent<GithubPickerEventDetail>(GITHUB_PICKER_EVENT, { detail, cancelable: true });
  window.dispatchEvent(ev);
  return ev.defaultPrevented;
}

/** "3시간 전" 같은 상대 시각. */
export function relativeTime(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "방금";
  if (m < 60) return `${m}분 전`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}시간 전`;
  return `${Math.floor(h / 24)}일 전`;
}

/** github.com 저장소 주소면 "owner/repo", 아니면 null. */
export function repoFullNameFromUrl(url: unknown): string | null {
  if (typeof url !== "string") return null;
  const m = /^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100}?)(?:\.git)?\/?(?:[?#].*)?$/i.exec(url.trim());
  return m ? `${m[1]}/${m[2]}` : null;
}
