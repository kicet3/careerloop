"use client";
/**
 * 그래프 채팅 패널(기능 2). 경험을 이야기하면 AI가 경험 그래프 변경안을 제안하고, 사용자가 확인하면 적용한다.
 * - 메시지 전송은 202로 바로 끝나고 답변은 서버가 백그라운드로 만든다 → 답을 기다리는 동안 스레드를 폴링한다.
 * - 변경안을 적용하면 window 이벤트 'career-graph:changed'를 보내 그래프 화면이 다시 읽게 한다.
 * - initialMessage가 오면(공고 대조의 '그래프 채팅으로 추가') 새 대화로 열고 입력을 미리 채운다. 보내기는 사용자가 누른다.
 * - 같은 화면의 경험 체크리스트는 window 이벤트(GRAPH_CHAT_ASK_EVENT)로 같은 일을 한다(같은 문구를 다시 눌러도 다시 채운다).
 * - [이력서·포트폴리오로 채우기]: 문서를 올리면 같은 대화에서 변경안을 받는다(POST …/import, 원본은 저장하지 않는다).
 * - 프로젝트 단위 대화: 스레드에 focusNodeId가 있으면 그 프로젝트 하나를 AI가 한 질문씩 물어 구조화한다. 머리에 프로젝트와
 *   구조화 진행도(n/7)·빠진 항목을 보이고, 그래프가 바뀌면(GRAPH_CHANGED_EVENT) 다시 읽는다. 프로젝트 상세의 버튼은
 *   GRAPH_CHAT_PROJECT_EVENT로 그 프로젝트의 최근 대화를 고르거나 새로 만든다. 이 대화에서는 문서 가져오기를 숨긴다.
 * - 후속 질문(graph_followups): 변경안의 후속 질문과 '변경안에서 뺀 항목' 중 채울 수 있는 것은 서버가 목록으로 쌓는다. 프로젝트 대화는
 *   그 프로젝트의 열린 질문을 하나씩 '후속 질문 k/n'으로 띄우고(건너뛰기·다음), 보낼 때 그 질문 id(followupId)를 함께 보낸다 —
 *   그 답으로 나온 변경안을 적용하면 질문이 답함으로 바뀐다. 기본 현재 질문은 AI가 방금 물은 질문(이 대화에서 이미 답으로 보낸 질문 제외)뿐이고,
 *   그 밖에는 사용자가 고른 질문(목록·다음·'이어서 답하기'·목록 탭 배지)만 연결한다.
 *   일반 대화에서는 프로젝트 미지정 질문을 접힌 목록으로 보이고(답하기·프로젝트 지정·건너뛰기), 질문이 바뀌면 FOLLOWUPS_CHANGED_EVENT를 보낸다.
 * - [GitHub에서 가져오기]: 저장소를 골라 프로젝트를 고르거나 만들고, 그 프로젝트 대화에서 AI가 저장소 정보로 변경안·후속 질문을 만든다
 *   (GithubRepoPicker → POST /api/graph/chat/github-import). ?github=pick이면 창을 다시 열고(GitHub 연결 뒤 돌아왔을 때),
 *   ?github_error=는 정해 둔 코드만 문구로 보인다. 프로젝트 상세는 GITHUB_PICKER_EVENT로 그 저장소를 바로 연다.
 *   저장소를 이은 프로젝트 대화는 머리에 저장소·동기화 시각과 [다시 동기화]·[새 정보로 다시 정리]를 보인다.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Spinner, cn } from "@/components/ui";
import type { GraphChatMessageView, GraphThreadFocus, GraphThreadView } from "@/lib/chat/graph-chat";
import type { ChatThread } from "@/lib/domain/chat";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import { type GraphFollowup, normalizeFollowupText } from "@/lib/domain/followups";
import { nodeDisplayName } from "@/lib/domain/graph";
import { NO_ENGINE_MESSAGE, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { SELF_HOSTED_UPLOAD_LIMITS, type UploadLimits } from "@/lib/ingest/upload-limits";
import {
  emitGraphChanged,
  fetchGraph,
  focusGraphNode,
  GRAPH_CHANGED_EVENT,
  GRAPH_CHAT_ASK_EVENT,
  GRAPH_CHAT_PROJECT_EVENT,
  type ProjectChatDetail,
} from "./api";
import { chatApi as api, useElapsed } from "./chat-client";
import { emitFollowupsChanged, FOLLOWUPS_CHANGED_EVENT, patchFollowup } from "./followups-client";
import { GraphImportForm } from "./GraphImportForm";
import { GITHUB_PICKER_EVENT, githubApi, GithubClientError, type GithubPickerEventDetail, relativeTime } from "@/components/github/client";
import { GithubRepoPicker } from "@/components/github/GithubRepoPicker";
import { GITHUB_UNAVAILABLE_MESSAGE, githubErrorMessage, type GithubThreadRepo } from "@/lib/github/types";

const PROVIDER_STORAGE_KEY = "graph-chat:provider";
/** 새 프로젝트 대화의 입력에 미리 채우는 문장(보내기는 사용자가 누른다). */
const projectStarter = (name: string) => `‘${name}’ 프로젝트를 더 구체적으로 정리하고 싶어요. 빠진 부분부터 하나씩 물어봐 주세요.`;
/** 프로젝트 대화의 현재 후속 질문 고르기: 질문 id, "first"(가장 오래된 열린 질문), "none"(질문과 상관없이 보내기). */
type FollowupPick = { threadId: string; id: string | "first" | "none" };

/** 변경안 줄이 이보다 많으면(문서 가져오기) 앞부분만 보이고 나머지는 펼쳐 본다. */
const OP_LINES_PREVIEW = 12;

const STATUS_BADGE = {
  proposed: { tone: "accent", label: "확인 대기" },
  applied: { tone: "positive", label: "적용됨" },
  dismissed: { tone: "neutral", label: "거절함" },
  failed: { tone: "negative", label: "적용 실패" },
} as const;

/**
 * 미리 채운 메시지(?ask=)를 보낸 뒤 주소에서 지운다. 남겨 두면 새로고침할 때 같은 문구가 다시 채워지고 새 대화로 바뀐다.
 * history.replaceState는 Next 라우터와 동기화되며 서버 컴포넌트를 다시 그리지 않는다.
 */
function clearAskQuery() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("ask")) return;
  url.searchParams.delete("ask");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
}

export function GraphChatPanel({
  initialThreadId,
  initialMessage,
  uploadLimits = SELF_HOSTED_UPLOAD_LIMITS,
}: {
  initialThreadId?: string;
  initialMessage?: string;
  /** 서버의 업로드 상한(uploadLimitsFor) — 이력서·포트폴리오 가져오기 폼. */
  uploadLimits?: UploadLimits;
}) {
  const [threads, setThreads] = useState<ChatThread[] | null>(null);
  const [graphOn, setGraphOn] = useState(true);
  const [threadId, setThreadId] = useState<string | null>(initialThreadId ?? null);
  const [loadedView, setView] = useState<GraphThreadView | null>(null);
  // 다른 스레드를 고른 직후에는 이전 스레드 내용을 보이지 않는다.
  const view = loadedView && loadedView.thread.id === threadId ? loadedView : null;
  const [providers, setProviders] = useState<ProviderOption[] | null>(null);
  const [provider, setProvider] = useState<ProviderId | null>(null);
  const [input, setInput] = useState(initialMessage ?? "");
  // 미리 채운 메시지는 새 대화로 시작한다(첫 로드에서 최근 스레드를 고르지 않는다).
  const startFresh = useRef(Boolean(initialMessage) && !initialThreadId);
  const [sending, setSending] = useState(false);
  const [busyMessage, setBusyMessage] = useState<string | null>(null);
  const [importOpen, setImportOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 프로젝트 고르기(프로젝트 단위 대화 시작): 열 때 그래프에서 Project 목록을 읽는다.
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<{ id: string; name: string }[] | null>(null);
  const [projectsError, setProjectsError] = useState(false);
  const [pickedProject, setPickedProject] = useState("");
  const [opening, setOpening] = useState(false);
  // 후속 질문: 프로젝트 대화의 현재 질문 고르기, 일반 대화에서 답할 미지정 질문, 미지정 질문 목록.
  const [focusPick, setFocusPick] = useState<FollowupPick | null>(null);
  const [generalPick, setGeneralPick] = useState<string | null>(null);
  const [unassigned, setUnassigned] = useState<GraphFollowup[]>([]);
  const [followupBusy, setFollowupBusy] = useState<string | null>(null);
  const [reopeningMessage, setReopeningMessage] = useState<string | null>(null);
  // GitHub 가져오기: 창(열린 경우 처음 고를 저장소·프로젝트), 설정 여부(null = 확인 중), 저장소 동기화·다시 정리 진행.
  const [githubPicker, setGithubPicker] = useState<GithubPickerEventDetail | null>(null);
  const [githubConfigured, setGithubConfigured] = useState<boolean | null>(null);
  const [repoBusy, setRepoBusy] = useState<"sync" | "reorganize" | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 체크리스트·그래프에 묻기의 '채우기' 요청 번호(바뀔 때마다 입력란으로 포커스).
  const [focusRequest, setFocusRequest] = useState(0);
  const loadSeq = useRef(0);
  // 같은 화면에서 다른 기술을 골라 initialMessage가 바뀌면 입력을 다시 채운다(렌더 중 조정 — effect의 setState를 피한다).
  const [seenInitial, setSeenInitial] = useState(initialMessage);
  if (initialMessage !== seenInitial) {
    setSeenInitial(initialMessage);
    if (initialMessage) {
      setInput(initialMessage);
      setThreadId(null);
      setError(null);
    }
  }

  // 같은 화면의 체크리스트 '채팅으로 채우기': 주소(?ask=)를 거치지 않고 입력을 채우고 새 대화로 연다.
  useEffect(() => {
    const onAsk = (ev: Event) => {
      const message = (ev as CustomEvent<{ message?: string } | undefined>).detail?.message;
      if (!message) return;
      ev.preventDefault();
      setInput(message);
      setThreadId(null);
      setError(null);
      // 지금은 이 패널이 숨은 탭(hidden)일 수 있다 — 탭 전환이 커밋된 뒤(아래 effect)에 커서를 옮긴다.
      setFocusRequest((n) => n + 1);
    };
    window.addEventListener(GRAPH_CHAT_ASK_EVENT, onAsk);
    return () => window.removeEventListener(GRAPH_CHAT_ASK_EVENT, onAsk);
  }, []);

  /**
   * 프로젝트 단위 대화 열기: 서버가 그 프로젝트의 최근 대화를 찾아 주고(목록 50개 밖의 오래된 대화도), 없으면 새로 만든다.
   * 새 대화면 입력을 시작 문장으로, 기존 대화면 비운다(다른 대화에 쓰던 글이 따라가지 않게).
   */
  const openProject = useCallback(async (projectId: string, followupId?: string) => {
    setError(null);
    setOpening(true);
    try {
      const r = await api<{ thread: ChatThread; created: boolean }>("/api/graph/chat/threads", {
        method: "POST",
        json: { focusNodeId: projectId, reuse: true },
      });
      setThreads((ts) => [r.thread, ...(ts ?? []).filter((t) => t.id !== r.thread.id)]);
      setThreadId(r.thread.id);
      setFocusPick(followupId ? { threadId: r.thread.id, id: followupId } : null);
      // 후속 질문에 답하러 왔으면 시작 문장을 채우지 않는다(질문이 머리에 보인다).
      setInput(r.created && !followupId ? projectStarter(r.thread.title) : "");
      setPickerOpen(false);
      setImportOpen(false);
      setFocusRequest((n) => n + 1);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  }, []);

  // 프로젝트 상세의 '이 프로젝트 대화로 구조화하기'.
  useEffect(() => {
    const onProject = (ev: Event) => {
      const detail = (ev as CustomEvent<Partial<ProjectChatDetail> | undefined>).detail;
      if (!detail?.projectId) return;
      ev.preventDefault();
      void openProject(detail.projectId, detail.followupId);
    };
    window.addEventListener(GRAPH_CHAT_PROJECT_EVENT, onProject);
    return () => window.removeEventListener(GRAPH_CHAT_PROJECT_EVENT, onProject);
  }, [openProject]);

  // GitHub: 설정 여부, 프로젝트 상세의 'GitHub 정보로 정리하기', 연결 뒤 돌아온 주소(?github=pick·?github_error=).
  useEffect(() => {
    githubApi.status().then(
      (st) => setGithubConfigured(st.configured),
      () => setGithubConfigured(null),
    );
    const onPicker = (ev: Event) => {
      ev.preventDefault();
      setGithubPicker((ev as CustomEvent<GithubPickerEventDetail | undefined>).detail ?? {});
    };
    window.addEventListener(GITHUB_PICKER_EVENT, onPicker);
    const url = new URL(window.location.href);
    const reopen = url.searchParams.get("github") === "pick";
    const errorText = githubErrorMessage(url.searchParams.get("github_error"));
    if (reopen || url.searchParams.has("github_error") || url.searchParams.has("github")) {
      url.searchParams.delete("github");
      url.searchParams.delete("github_error");
      window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
      // 주소에서 읽은 값으로 한 번만 연다(마운트 직후 — 외부 상태와 맞추는 effect).
      queueMicrotask(() => {
        if (reopen && !errorText) setGithubPicker({});
        if (errorText) setError(errorText);
      });
    }
    return () => window.removeEventListener(GITHUB_PICKER_EVENT, onPicker);
  }, []);

  // 채우기 요청 뒤: 탭이 보이게 바뀐 커밋 다음에 입력란으로 스크롤·포커스한다(숨은 요소에는 포커스가 가지 않는다).
  useEffect(() => {
    if (focusRequest === 0) return;
    const el = inputRef.current;
    if (!el) return;
    const run = () => {
      el.scrollIntoView({ block: "center", behavior: "smooth" });
      el.focus({ preventScroll: true });
    };
    // 같은 커밋에서 부모 탭도 바뀌므로 대개 바로 보인다. 아직 숨어 있으면 다음 프레임에 한 번 더 시도한다.
    if (el.offsetParent !== null) {
      run();
      return;
    }
    const raf = requestAnimationFrame(run);
    return () => cancelAnimationFrame(raf);
  }, [focusRequest]);

  // 미리 채운 메시지가 오면 입력란으로 커서를 옮긴다.
  useEffect(() => {
    if (initialMessage) inputRef.current?.focus();
  }, [initialMessage]);

  // ---- 초기 로드: 스레드 목록·엔진 ----
  useEffect(() => {
    let alive = true;
    api<{ threads: ChatThread[]; graphEnabled: boolean }>("/api/graph/chat/threads")
      .then((r) => {
        if (!alive) return;
        setThreads(r.threads);
        setGraphOn(r.graphEnabled);
        setThreadId((cur) =>
          cur && r.threads.some((t) => t.id === cur) ? cur : startFresh.current ? null : (r.threads[0]?.id ?? null),
        );
      })
      .catch((e: Error) => alive && (setThreads([]), setError(e.message)));
    api<{ options: ProviderOption[] }>("/api/providers")
      .then((r) => {
        if (!alive) return;
        const ready = r.options.filter((o) => o.ready);
        setProviders(r.options);
        const saved = window.localStorage.getItem(PROVIDER_STORAGE_KEY);
        setProvider(ready.find((o) => o.id === saved)?.id ?? ready[0]?.id ?? null);
      })
      .catch(() => alive && setProviders([]));
    return () => {
      alive = false;
    };
  }, []);

  // 프로젝트 미지정 후속 질문(일반 대화에서 보인다). 질문이 바뀌면 다시 읽는다.
  const loadUnassigned = useCallback(() => {
    api<{ items?: GraphFollowup[] }>("/api/graph/chat/followups?unassigned=1").then(
      (r) => setUnassigned(r.items ?? []),
      () => {},
    );
  }, []);
  useEffect(() => {
    loadUnassigned();
    window.addEventListener(FOLLOWUPS_CHANGED_EVENT, loadUnassigned);
    return () => window.removeEventListener(FOLLOWUPS_CHANGED_EVENT, loadUnassigned);
  }, [loadUnassigned]);

  const loadThread = useCallback(async (id: string) => {
    const seq = ++loadSeq.current;
    const v = await api<GraphThreadView>(`/api/graph/chat/threads/${encodeURIComponent(id)}`);
    if (seq === loadSeq.current) setView(v);
    return v;
  }, []);

  useEffect(() => {
    if (!threadId) return;
    loadThread(threadId).catch((e: Error) => setError(e.message));
  }, [threadId, loadThread]);

  // 프로젝트 대화: 그래프가 바뀌면(직접 편집 등) 구조화 진행도를 다시 읽는다. 이 패널의 적용은 decide()가 다시 읽는다.
  const focusNodeId = view?.thread.focusNodeId ?? threads?.find((t) => t.id === threadId)?.focusNodeId ?? null;
  useEffect(() => {
    if (!threadId || !focusNodeId) return;
    const onChanged = (ev: Event) => {
      if ((ev as CustomEvent<{ source?: string } | undefined>).detail?.source === "chat") return;
      loadThread(threadId).catch(() => {});
    };
    window.addEventListener(GRAPH_CHANGED_EVENT, onChanged);
    return () => window.removeEventListener(GRAPH_CHANGED_EVENT, onChanged);
  }, [threadId, focusNodeId, loadThread]);

  // ---- 답변 대기 중 폴링 ----
  const pending = view?.pending ?? false;
  const lastCreatedAt = view?.messages.at(-1)?.createdAt ?? null;
  useEffect(() => {
    if (!pending || !threadId) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const started = Date.now();
    const tick = async () => {
      try {
        const v = await loadThread(threadId);
        if (!v.pending || stopped) {
          // 답이 오면 스레드 목록 순서·제목도 갱신한다. 답과 함께 후속 질문이 쌓였을 수 있다.
          api<{ threads: ChatThread[] }>("/api/graph/chat/threads").then((r) => setThreads(r.threads), () => {});
          if (!v.pending) emitFollowupsChanged();
          return;
        }
      } catch {
        // 일시적 네트워크 오류는 다음 주기에 다시 시도한다.
      }
      if (!stopped) timer = setTimeout(tick, Date.now() - started > 30_000 ? 4000 : 1500);
    };
    timer = setTimeout(tick, 1200);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, [pending, threadId, loadThread]);

  // 새 메시지가 오면 맨 아래로.
  const messageCount = view?.messages.length ?? 0;
  useEffect(() => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [messageCount, pending, threadId]);

  const elapsed = useElapsed(pending ? lastCreatedAt : null);
  const readyProviders = providers?.filter((p) => p.ready) ?? [];
  const noEngine = providers !== null && readyProviders.length === 0;

  // ---- 후속 질문 ----
  // 프로젝트 대화: 그 프로젝트의 열린 질문 중 현재 질문(보낼 때 이 질문의 답으로 연결한다).
  //  - 사용자가 고른 질문(목록·다음·배지의 "first")이 있으면 그것.
  //  - 고른 것이 없으면 AI가 방금 물은 질문과 같은 열린 질문만 — 그 밖의 이야기를 아무 질문의 답으로 연결하지 않는다.
  //  - 이 대화에서 이미 답으로 보낸 질문(적용 전이거나 "모르겠어요"로 끝난 것)은 자동으로 다시 고르지 않는다(서버 프롬프트도 같은 규칙).
  // 일반 대화: 사용자가 '답하기'로 고른 미지정 질문만.
  const threadFollowups = focusNodeId ? (view?.followups ?? []) : [];
  const openFollowups = threadFollowups.filter((f) => f.status === "open");
  const answeredHere = new Set(
    (view?.messages ?? []).flatMap((m) => (m.role === "user" && m.data?.kind === "followup-answer" ? [m.data.followupId] : [])),
  );
  const freshFollowups = openFollowups.filter((f) => !answeredHere.has(f.id));
  const pick = focusPick && focusPick.threadId === threadId ? focusPick.id : null;
  let currentFollowup: GraphFollowup | null = null;
  if (focusNodeId && pick !== "none") {
    const lastAssistant = [...(view?.messages ?? [])].reverse().find((m) => m.role === "assistant");
    const asked = lastAssistant?.data?.kind === "graph-proposal" ? normalizeFollowupText(lastAssistant.data.followUpQuestions[0] ?? "") : "";
    currentFollowup =
      (pick === "first"
        ? (freshFollowups[0] ?? openFollowups[0])
        : pick
          ? openFollowups.find((f) => f.id === pick)
          : asked
            ? freshFollowups.find((f) => normalizeFollowupText(f.text) === asked)
            : undefined) ?? null;
  } else if (!focusNodeId && generalPick) {
    currentFollowup = unassigned.find((f) => f.id === generalPick && f.status === "open") ?? null;
  }

  /** 프로젝트 대화의 현재 질문을 바꾼다(id·"first"·"none"). */
  function pickFollowup(id: string | "first" | "none") {
    if (threadId) setFocusPick({ threadId, id });
    inputRef.current?.focus();
  }

  /** 다음 열린 질문으로(끝이면 처음으로). 상태는 바꾸지 않는다. */
  function nextFollowup() {
    if (openFollowups.length === 0) return;
    const i = currentFollowup ? openFollowups.findIndex((f) => f.id === currentFollowup.id) : -1;
    pickFollowup(openFollowups[(i + 1) % openFollowups.length]!.id);
  }

  async function changeFollowup(f: GraphFollowup, patch: { status?: "open" | "skipped"; projectNodeId?: string | null }) {
    setFollowupBusy(f.id);
    setError(null);
    try {
      await patchFollowup(f.id, patch);
      if (patch.status === "skipped" && currentFollowup?.id === f.id) {
        // 건너뛰면 다음 열린 질문으로(없으면 질문 없이). 버튼이 사라져도 키보드 포커스는 입력란으로.
        const rest = openFollowups.filter((x) => x.id !== f.id);
        const i = openFollowups.findIndex((x) => x.id === f.id);
        const next = rest[i % Math.max(rest.length, 1)];
        if (focusNodeId && threadId) setFocusPick({ threadId, id: next?.id ?? "none" });
        if (!focusNodeId) setGeneralPick(null);
        inputRef.current?.focus();
      }
      if (patch.status === "open" && focusNodeId && threadId) setFocusPick({ threadId, id: f.id });
      if (patch.projectNodeId !== undefined && generalPick === f.id) setGeneralPick(null);
      if (threadId) await loadThread(threadId).catch(() => {});
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFollowupBusy(null);
    }
  }

  /** 답변이 답함으로 정리한 후속 질문을 다시 연다(되돌리기). 같은 열린 질문이 이미 있으면(409) 그 질문은 그대로 두고 알린다. */
  async function reopenResolved(messageId: string, ids: string[]) {
    setReopeningMessage(messageId);
    setError(null);
    try {
      const results = await Promise.allSettled(ids.map((id) => patchFollowup(id, { status: "open" })));
      const failed = results.find((r): r is PromiseRejectedResult => r.status === "rejected");
      if (failed) setError((failed.reason as Error).message);
      if (threadId) await loadThread(threadId).catch(() => {});
    } finally {
      setReopeningMessage(null);
    }
  }

  function chooseProvider(id: ProviderId) {
    setProvider(id);
    window.localStorage.setItem(PROVIDER_STORAGE_KEY, id);
  }

  function newThread() {
    setError(null);
    setThreadId(null);
    setInput("");
    inputRef.current?.focus();
  }

  /** 프로젝트 대화 → 일반 대화: 가장 최근 일반 대화로(없으면 새 대화). 쓰던 글은 지우지 않는다. */
  function leaveProject() {
    setError(null);
    setThreadId(threads?.find((t) => !t.focusNodeId)?.id ?? null);
    inputRef.current?.focus();
  }

  function togglePicker() {
    if (pickerOpen) {
      setPickerOpen(false);
      return;
    }
    setPickerOpen(true);
    setError(null);
    void loadProjects();
  }

  async function loadProjects() {
    setProjectsError(false);
    setProjects(null);
    try {
      const g = await fetchGraph();
      const list = g.nodes.filter((n) => n.label === "Project").map((n) => ({ id: n.id, name: nodeDisplayName(n) }));
      setProjects(list);
      setPickedProject((cur) => (list.some((p) => p.id === cur) ? cur : (list[0]?.id ?? "")));
    } catch {
      // 목록을 못 읽은 것과 프로젝트가 없는 것은 다르다 — 빈 목록으로 두지 않는다.
      setProjectsError(true);
    }
  }

  async function send() {
    const text = input.trim();
    if (!text || sending || pending) return;
    if (text.length > MAX_CHAT_MESSAGE_CHARS) {
      setError(`메시지는 ${MAX_CHAT_MESSAGE_CHARS}자까지 보낼 수 있습니다.`);
      return;
    }
    setSending(true);
    setError(null);
    try {
      let id = threadId;
      if (!id) {
        const r = await api<{ thread: ChatThread }>("/api/graph/chat/threads", { method: "POST", json: {} });
        id = r.thread.id;
        setThreads((ts) => [r.thread, ...(ts ?? [])]);
        setThreadId(id);
      }
      await api(`/api/graph/chat/threads/${encodeURIComponent(id)}/messages`, {
        method: "POST",
        json: { message: text, provider, ...(currentFollowup ? { followupId: currentFollowup.id } : {}) },
      });
      setInput("");
      // 답한 뒤에는 AI가 다음에 묻는 질문이 현재 질문이 된다(답한 질문은 변경안을 적용하면 답함으로 바뀌고, 그 전에도 자동으로 다시 고르지 않는다).
      if (focusNodeId) setFocusPick(null);
      else setGeneralPick(null);
      clearAskQuery();
      const v = await loadThread(id);
      // 답이 이미 왔으면(폴링을 타지 않는다) 후속 질문 수·목록을 여기서 다시 읽게 한다 — 답변이 질문을 답함으로 정리했을 수 있다.
      if (!v.pending) emitFollowupsChanged();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  /** 이력서·포트폴리오 보내기: 대화가 없으면 먼저 만들고, 응답(202) 뒤 폴링 흐름을 탄다. 실패는 폼이 보인다. */
  async function sendImport(form: FormData, label: string) {
    if (pending) throw new Error("이전 메시지의 답변을 만드는 중입니다. 잠시 후 다시 보내 주세요.");
    let id = threadId;
    if (!id) {
      const r = await api<{ thread: ChatThread }>("/api/graph/chat/threads", { method: "POST", json: { title: `자료 가져오기: ${label}` } });
      id = r.thread.id;
      setThreads((ts) => [r.thread, ...(ts ?? [])]);
      setThreadId(id);
    }
    if (provider) form.append("provider", provider);
    const r = await api<{ warnings?: string[] }>(`/api/graph/chat/threads/${encodeURIComponent(id)}/import`, { method: "POST", body: form });
    setImportOpen(false);
    setError(r.warnings?.length ? r.warnings.join(" ") : null);
    await loadThread(id);
    api<{ threads: ChatThread[] }>("/api/graph/chat/threads").then((x) => setThreads(x.threads), () => {});
  }

  async function retry() {
    if (!threadId) return;
    setError(null);
    setSending(true);
    try {
      await api(`/api/graph/chat/threads/${encodeURIComponent(threadId)}/retry`, { method: "POST", json: { provider } });
      await loadThread(threadId);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  async function decide(messageId: string, action: "apply" | "dismiss") {
    if (!threadId) return;
    setBusyMessage(messageId);
    setError(null);
    try {
      const r = await api<{ message: GraphChatMessageView; result?: unknown }>(
        `/api/graph/chat/messages/${encodeURIComponent(messageId)}/${action}`,
        { method: "POST" },
      );
      if (action === "apply" && r.message.status === "applied") {
        emitGraphChanged("chat");
        emitFollowupsChanged();
      }
      await loadThread(threadId);
    } catch (e) {
      setError((e as Error).message);
      await loadThread(threadId).catch(() => {});
    } finally {
      setBusyMessage(null);
    }
  }

  /** GitHub 가져오기가 시작되면(202): 그 프로젝트 대화로 바꾸고 폴링한다. 새 프로젝트·주소를 넣었을 수 있어 그래프도 다시 읽게 한다. */
  function githubStarted(r: { thread: ChatThread; created: boolean }) {
    setGithubPicker(null);
    setThreads((ts) => [r.thread, ...(ts ?? []).filter((t) => t.id !== r.thread.id)]);
    setThreadId(r.thread.id);
    setFocusPick(null);
    setInput("");
    setError(null);
    emitGraphChanged("github");
    loadThread(r.thread.id).catch(() => {});
  }

  /** 저장소를 이은 프로젝트 대화: [다시 동기화](정보만 새로 읽기) / [새 정보로 다시 정리](새로 읽고 AI에 다시 정리 요청). */
  async function repoAction(repo: GithubThreadRepo, action: "sync" | "reorganize") {
    if (!threadId || !focusNodeId || repoBusy) return;
    setRepoBusy(action);
    setError(null);
    try {
      if (action === "sync") {
        await githubApi.sync(repo.fullName);
        await loadThread(threadId);
      } else {
        // 서버는 지금 대화에 이어 쓴다(그 프로젝트 대화가 아니면 다른 대화) — 응답의 대화로 옮겨 대기 표시와 변경안이 보이게 한다.
        githubStarted(await githubApi.startImport({ fullName: repo.fullName, projectNodeId: focusNodeId, refresh: true, threadId, provider }));
      }
    } catch (e) {
      setError(e instanceof GithubClientError ? e.message : (e as Error).message);
    } finally {
      setRepoBusy(null);
    }
  }

  async function removeThread() {
    if (!threadId || !window.confirm("이 대화를 지울까요? 이미 적용한 그래프 변경은 그대로 남습니다.")) return;
    setError(null);
    try {
      await api(`/api/graph/chat/threads/${encodeURIComponent(threadId)}`, { method: "DELETE" });
      const rest = (threads ?? []).filter((t) => t.id !== threadId);
      setThreads(rest);
      setThreadId(rest[0]?.id ?? null);
    } catch (e) {
      setError((e as Error).message);
    }
  }

  /** 답변의 질문 칩: 목록에 같은 열린 후속 질문이 있으면 그 질문을 현재 질문으로, 없으면 입력에 질문을 붙인다. */
  function askAbout(question: string) {
    const key = normalizeFollowupText(question);
    const item = (focusNodeId ? openFollowups : unassigned).find((f) => f.status === "open" && normalizeFollowupText(f.text) === key);
    if (item) {
      if (focusNodeId) pickFollowup(item.id);
      else {
        setGeneralPick(item.id);
        inputRef.current?.focus();
      }
      return;
    }
    setInput((cur) => `${cur ? `${cur}\n` : ""}${question}\n→ `);
    inputRef.current?.focus();
  }

  const disabled = !graphOn || noEngine;
  const messages = view?.messages ?? [];
  const generalThreads = threads?.filter((t) => !t.focusNodeId) ?? [];
  const projectThreads = threads?.filter((t) => t.focusNodeId) ?? [];
  const lastId = messages.at(-1)?.id;

  return (
    <Card className="flex min-w-0 flex-col">
      {/* 머리: 스레드·엔진 선택 */}
      <div className="flex flex-wrap items-center gap-2 border-b border-slate-200 px-4 py-3">
        <h2 className="w-full text-base font-semibold text-slate-900">경험 대화로 정리하기</h2>
        <label className="sr-only" htmlFor="graph-chat-thread">
          대화 선택
        </label>
        <select
          id="graph-chat-thread"
          className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
          value={threadId ?? ""}
          onChange={(e) => setThreadId(e.target.value || null)}
          disabled={threads === null}
        >
          <option value="">{threadId ? "새 대화" : "새 대화(작성 중)"}</option>
          {generalThreads.length > 0 && (
            <optgroup label="일반 대화">
              {generalThreads.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.title}
                </option>
              ))}
            </optgroup>
          )}
          {projectThreads.length > 0 && (
            <optgroup label="프로젝트 대화">
              {projectThreads.map((t) => (
                <option key={t.id} value={t.id}>
                  프로젝트: {t.title}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <Button size="sm" variant="secondary" onClick={newThread} disabled={!threadId}>
          새 대화
        </Button>
        <Button
          size="sm"
          variant={pickerOpen ? "primary" : "secondary"}
          onClick={togglePicker}
          disabled={!graphOn}
          aria-expanded={pickerOpen}
          aria-controls="graph-chat-project-picker"
        >
          프로젝트로 대화
        </Button>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => setGithubPicker({})}
          disabled={!graphOn || githubConfigured === false}
          title={githubConfigured === false ? GITHUB_UNAVAILABLE_MESSAGE : "GitHub 저장소로 프로젝트 정리하기"}
        >
          GitHub에서 가져오기
        </Button>
        {threadId && (
          <Button size="sm" variant="ghost" onClick={removeThread} aria-label="이 대화 삭제">
            삭제
          </Button>
        )}
      </div>

      {githubConfigured === false && (
        <p className="border-b border-slate-100 px-4 py-1.5 text-xs text-slate-500">GitHub에서 가져오기: {GITHUB_UNAVAILABLE_MESSAGE}</p>
      )}

      {githubPicker && (
        <GithubRepoPicker
          initialFullName={githubPicker.fullName}
          initialProjectId={githubPicker.projectNodeId}
          provider={provider}
          onClose={() => setGithubPicker(null)}
          onStarted={githubStarted}
        />
      )}

      {pickerOpen && (
        <div id="graph-chat-project-picker" className="flex flex-wrap items-center gap-2 border-b border-slate-100 bg-slate-50/60 px-4 py-2.5 text-sm">
          {projectsError ? (
            <>
              <p className="text-slate-600">프로젝트 목록을 불러오지 못했습니다. 다시 시도해 주세요.</p>
              <Button size="sm" variant="secondary" onClick={() => void loadProjects()}>
                다시 시도
              </Button>
            </>
          ) : projects === null ? (
            <Spinner size="sm" label="프로젝트를 불러오는 중" />
          ) : projects.length === 0 ? (
            <p className="text-slate-600">아직 프로젝트가 없습니다. 먼저 일반 대화나 항목 추가로 프로젝트를 만들어 주세요.</p>
          ) : (
            <>
              <label htmlFor="graph-chat-project" className="text-slate-600">
                구조화할 프로젝트
              </label>
              <select
                id="graph-chat-project"
                className="h-8 min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
                value={pickedProject}
                onChange={(e) => setPickedProject(e.target.value)}
              >
                {projects.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                    {threads?.some((t) => t.focusNodeId === p.id) ? " (대화 있음)" : ""}
                  </option>
                ))}
              </select>
              <Button size="sm" onClick={() => pickedProject && void openProject(pickedProject)} loading={opening} disabled={!pickedProject}>
                대화 시작
              </Button>
            </>
          )}
          <Button size="sm" variant="ghost" onClick={() => setPickerOpen(false)}>
            닫기
          </Button>
        </div>
      )}

      {focusNodeId && (
        <ProjectFocusBar
          focus={view?.focus ?? null}
          title={view?.thread.title ?? threads?.find((t) => t.id === threadId)?.title ?? ""}
          onShowInGraph={() => focusGraphNode(focusNodeId)}
          onPick={(name) => {
            setInput((cur) => `${cur ? `${cur}\n` : ""}${name}: `);
            inputRef.current?.focus();
          }}
          onLeave={leaveProject}
          repo={view?.repo ?? null}
          repoBusy={repoBusy}
          repoDisabled={disabled || pending}
          githubConfigured={githubConfigured}
          onRepoAction={(repo, action) => void repoAction(repo, action)}
        />
      )}

      {focusNodeId && view && (
        <FocusFollowupBar
          items={threadFollowups}
          current={currentFollowup}
          busyId={followupBusy}
          detached={pick === "none"}
          onPick={pickFollowup}
          onNext={nextFollowup}
          onChange={(f, status) => void changeFollowup(f, { status })}
        />
      )}

      {!focusNodeId && unassigned.length > 0 && (
        <UnassignedFollowups
          items={unassigned}
          currentId={currentFollowup?.id ?? null}
          busyId={followupBusy}
          projects={projects}
          projectsError={projectsError}
          // 펼칠 때마다 다시 읽는다(그 사이 새 Project를 적용했을 수 있다).
          onLoadProjects={() => void loadProjects()}
          onAnswer={(f) => {
            setGeneralPick(f.id);
            inputRef.current?.focus();
          }}
          onAssign={(f, projectNodeId) => void changeFollowup(f, { projectNodeId })}
          onSkip={(f) => void changeFollowup(f, { status: "skipped" })}
        />
      )}

      {readyProviders.length > 1 && (
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-2 text-sm text-slate-600">
          <label htmlFor="graph-chat-provider">AI 엔진</label>
          <select
            id="graph-chat-provider"
            className="h-8 min-w-0 rounded-lg border border-slate-300 bg-white px-2 text-sm text-slate-800"
            value={provider ?? ""}
            onChange={(e) => chooseProvider(e.target.value as ProviderId)}
          >
            {readyProviders.map((p) => (
              <option key={p.id} value={p.id}>
                {p.label}
                {p.account ? ` (${p.account})` : ""}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* 메시지 목록 */}
      <div ref={listRef} className="h-[min(60vh,560px)] min-h-72 space-y-4 overflow-y-auto px-4 py-4" aria-live="polite">
        {!graphOn && <Alert tone="warning">경험 그래프 저장소(Neo4j)가 설정되지 않아 대화로 정리할 수 없습니다.</Alert>}
        {noEngine && <Alert tone="warning">{NO_ENGINE_MESSAGE}</Alert>}
        {threadId && !view && (
          <div className="flex justify-center py-10 text-slate-400">
            <Spinner label="대화를 불러오는 중" />
          </div>
        )}
        {focusNodeId && view && messages.length === 0 && (
          <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm leading-relaxed text-slate-600">
            <p className="font-medium text-slate-800">‘{view.thread.title}’ 프로젝트를 구조화해요</p>
            <p className="mt-1">
              AI가 배경·문제, 내 역할, 한 일, 사용 기술, 성과, 기간·소속, 배운 점 중 빠진 것을 하나씩 묻고, 답한 내용을 이 프로젝트에 붙일
              변경안으로 만듭니다. 확인한 것만 적용됩니다.
            </p>
          </div>
        )}
        {(!threadId || (view && messages.length === 0 && !focusNodeId)) && (
          <div className="rounded-lg bg-slate-50 px-4 py-5 text-sm leading-relaxed text-slate-600">
            <p className="font-medium text-slate-800">어떤 경험을 정리할까요?</p>
            <p className="mt-1">
              회사·프로젝트·맡은 일·사용한 기술·결과를 편하게 이야기해 주세요. AI가 그래프에 넣을 변경안을 만들고, 확인한 것만 적용됩니다.
            </p>
            <p className="mt-2 text-slate-500">예: “2022년 3월부터 페이랩에서 백엔드 개발자로 일했고, 결제 API를 Go로 다시 만들어 응답 시간을 40% 줄였어요.”</p>
          </div>
        )}
        {messages.map((m) =>
          m.role === "user" && m.data?.kind === "document-import" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-sm text-indigo-900">
                <p className="font-medium break-words">
                  {m.data.docKind === "portfolio" ? "포트폴리오" : "이력서"}: {m.data.fileName ?? "붙여넣은 글"}
                </p>
                <p className="text-xs text-indigo-700">
                  읽어 낸 글 {m.data.chars.toLocaleString()}자{m.data.truncated && " · 앞부분만 읽음"}
                </p>
                {m.data.warnings.length > 0 && <p className="mt-1 text-xs text-amber-700">{m.data.warnings.join(" ")}</p>}
              </div>
            </div>
          ) : m.role === "user" && m.data?.kind === "repo-import" ? (
            <div key={m.id} className="flex justify-end">
              <div className="max-w-[85%] rounded-2xl rounded-br-sm border border-indigo-200 bg-indigo-50 px-3.5 py-2 text-sm text-indigo-900">
                <p className="font-medium break-words">
                  GitHub 저장소: {m.data.fullName}
                  {m.data.private && " (비공개)"}
                </p>
                <p className="text-xs text-indigo-700">저장소 정보 {m.data.chars.toLocaleString()}자로 이 프로젝트 정리를 요청했습니다</p>
              </div>
            </div>
          ) : m.role === "user" ? (
            <div key={m.id} className="flex flex-col items-end gap-1">
              {m.data?.kind === "followup-answer" && (
                <p className="max-w-[85%] text-right text-xs break-words text-slate-500">후속 질문에 답함: {m.data.question}</p>
              )}
              <p className="max-w-[85%] rounded-2xl rounded-br-sm bg-indigo-600 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-white">
                {m.content}
              </p>
            </div>
          ) : (
            <AssistantMessage
              key={m.id}
              message={m}
              busy={busyMessage === m.id}
              disabled={!graphOn || busyMessage !== null}
              onApply={() => decide(m.id, "apply")}
              onDismiss={() => decide(m.id, "dismiss")}
              onAsk={askAbout}
              canRetry={m.id === lastId && (view?.canRetry ?? false)}
              onRetry={retry}
              retrying={sending}
              onReopen={(ids) => void reopenResolved(m.id, ids)}
              reopening={reopeningMessage === m.id}
            />
          ),
        )}
        {pending && (
          <div className="flex items-center gap-2 text-sm text-slate-500" role="status">
            <Spinner size="sm" />
            <span>
              답변을 만드는 중… {elapsed > 0 && `${elapsed}초`}
              {elapsed >= 20 && <span className="block text-xs text-slate-400">엔진에 따라 1분 이상 걸릴 수 있어요. 이 화면을 떠나도 답변은 저장됩니다.</span>}
            </span>
          </div>
        )}
        {view?.stale && (
          <Alert tone="warning">
            답변을 받지 못했습니다.{" "}
            <button type="button" className="font-semibold underline" onClick={retry} disabled={sending}>
              다시 시도
            </button>
          </Alert>
        )}
      </div>

      {/* 입력 */}
      <div className="border-t border-slate-200 px-4 py-3">
        {error && (
          <Alert tone="error" className="mb-2">
            {error}
          </Alert>
        )}
        {focusNodeId ? null : importOpen ? (
          <div className="mb-2">
            <GraphImportForm uploadLimits={uploadLimits} disabled={disabled || pending} onSubmit={sendImport} onCancel={() => setImportOpen(false)} />
          </div>
        ) : (
          <div className="mb-2 flex justify-end">
            <Button size="sm" variant="secondary" onClick={() => setImportOpen(true)} disabled={disabled || pending}>
              이력서·포트폴리오로 채우기
            </Button>
          </div>
        )}
        {!focusNodeId && currentFollowup && (
          <div className="mb-2 flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
            <span className="min-w-0 flex-1 break-words">
              <span className="font-semibold">답하는 후속 질문</span> {currentFollowup.text}
            </span>
            <button type="button" className="shrink-0 underline" onClick={() => setGeneralPick(null)}>
              연결 해제
            </button>
          </div>
        )}
        <form
          className="flex items-end gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <label htmlFor="graph-chat-input" className="sr-only">
            경험 이야기하기
          </label>
          <textarea
            id="graph-chat-input"
            ref={inputRef}
            rows={2}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              // 한글 조합 중 Enter는 무시한다.
              if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                e.preventDefault();
                void send();
              }
            }}
            disabled={disabled}
            placeholder={
              pending
                ? "답변을 기다리는 중입니다…"
                : currentFollowup
                  ? "후속 질문에 답해 주세요 (Enter 전송, Shift+Enter 줄바꿈)"
                  : focusNodeId
                  ? "질문에 답하거나 이 프로젝트 이야기를 해 주세요 (Enter 전송, Shift+Enter 줄바꿈)"
                  : "경험을 이야기해 주세요 (Enter 전송, Shift+Enter 줄바꿈)"
            }
            className="max-h-40 min-h-[2.75rem] min-w-0 flex-1 resize-y rounded-lg border border-slate-300 px-3 py-2 text-sm text-slate-900 placeholder:text-slate-400 focus:border-indigo-500 focus:ring-2 focus:ring-indigo-200 focus:outline-none disabled:bg-slate-50"
          />
          <Button type="submit" loading={sending} disabled={disabled || pending || !input.trim()}>
            보내기
          </Button>
        </form>
        <p className={cn("mt-1 text-right text-xs", input.length > MAX_CHAT_MESSAGE_CHARS ? "text-red-600" : "text-slate-400")}>
          {input.length.toLocaleString()} / {MAX_CHAT_MESSAGE_CHARS.toLocaleString()}
        </p>
      </div>
    </Card>
  );
}

/** 프로젝트 단위 대화 머리: 프로젝트 이름, 구조화 진행도(n/7), 빠진 항목(누르면 입력에 항목 이름을 채운다). */
function ProjectFocusBar({
  focus,
  title,
  onShowInGraph,
  onPick,
  onLeave,
  repo,
  repoBusy,
  repoDisabled,
  githubConfigured,
  onRepoAction,
}: {
  focus: GraphThreadFocus | null;
  title: string;
  onShowInGraph: () => void;
  onPick: (itemName: string) => void;
  onLeave: () => void;
  repo: GithubThreadRepo | null;
  repoBusy: "sync" | "reorganize" | null;
  repoDisabled: boolean;
  githubConfigured: boolean | null;
  onRepoAction: (repo: GithubThreadRepo, action: "sync" | "reorganize") => void;
}) {
  const s = focus?.structure ?? null;
  const name = s?.projectName ?? title;
  const todo = s?.items.filter((i) => i.state !== "done") ?? [];
  return (
    <div className="space-y-2 border-b border-slate-100 bg-indigo-50/40 px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone="accent">프로젝트</Badge>
        <span className="min-w-0 truncate text-sm font-semibold text-slate-900" title={name}>
          {name}
        </span>
        {s && (
          <span className="text-xs text-slate-600">
            구조화 {s.done}/{s.total}
          </span>
        )}
        {focus?.exists === null && <span className="text-xs text-slate-500">진행도를 불러오지 못했습니다</span>}
        <span className="ml-auto inline-flex gap-1">
          {focus?.exists !== false && (
            <Button size="sm" variant="ghost" onClick={onShowInGraph}>
              그래프에서 보기
            </Button>
          )}
          <Button size="sm" variant="ghost" onClick={onLeave}>
            일반 대화로
          </Button>
        </span>
      </div>
      {repo && (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-slate-600">
          <span className="break-all">
            GitHub · {repo.fullName}
            {repo.private && " (비공개)"} · 동기화 {relativeTime(repo.fetchedAt)}
            {repo.stale && " (오래됨)"}
            {repo.aiExcluded && " · 비공개 저장소 허용이 꺼져 있어 AI에 보내지 않음"}
          </span>
          <span className="inline-flex flex-wrap gap-2">
            <button
              type="button"
              className="underline disabled:opacity-50"
              disabled={repoBusy !== null || repoDisabled || githubConfigured === false}
              title={githubConfigured === false ? GITHUB_UNAVAILABLE_MESSAGE : undefined}
              onClick={() => onRepoAction(repo, "sync")}
            >
              {repoBusy === "sync" ? "동기화 중…" : "다시 동기화"}
            </button>
            <button
              type="button"
              className="underline disabled:opacity-50"
              disabled={repoBusy !== null || repoDisabled || githubConfigured === false || repo.aiExcluded}
              title={
                githubConfigured === false
                  ? GITHUB_UNAVAILABLE_MESSAGE
                  : repo.aiExcluded
                    ? "계정 설정에서 '비공개 저장소도 가져오기'를 켜야 다시 정리할 수 있습니다."
                    : undefined
              }
              onClick={() => onRepoAction(repo, "reorganize")}
            >
              {repoBusy === "reorganize" ? "요청 중…" : "새 정보로 다시 정리"}
            </button>
            <a href={repo.htmlUrl} target="_blank" rel="noreferrer" className="underline">
              GitHub에서 보기
            </a>
          </span>
        </div>
      )}
      {focus?.exists === false && (
        <Alert tone="warning">구조화하던 프로젝트가 그래프에서 지워졌습니다. 일반 대화로 돌아가거나 다른 프로젝트를 골라 주세요.</Alert>
      )}
      {s && (
        <>
          <div
            className="h-1.5 overflow-hidden rounded-full bg-white"
            role="progressbar"
            aria-label="프로젝트 구조화 진행도"
            aria-valuemin={0}
            aria-valuemax={s.total}
            aria-valuenow={s.done}
          >
            <div
              className={cn("h-full rounded-full transition-[width]", s.done === s.total ? "bg-emerald-500" : "bg-indigo-500")}
              style={{ width: `${Math.round((100 * s.done) / s.total)}%` }}
            />
          </div>
          {todo.length === 0 ? (
            <p className="text-xs text-emerald-700">7개 항목을 모두 채웠어요. 더 이야기할 내용이 있으면 이어서 말해 주세요.</p>
          ) : (
            <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="빠진 항목">
              <span className="text-xs text-slate-500">빠진 항목</span>
              {todo.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => onPick(item.name)}
                  title={`${item.hint} — 눌러서 이 항목 이야기하기`}
                  aria-label={`${item.name}${item.state === "partial" ? " (일부)" : ""}: ${item.hint}. 눌러서 이 항목 이야기하기`}
                  className={cn(
                    "rounded-full border px-2 py-0.5 text-xs hover:bg-white",
                    item.state === "partial" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-slate-200 bg-white text-slate-700",
                    item.id === s.next && "ring-1 ring-indigo-300",
                  )}
                >
                  {item.name}
                  {item.state === "partial" && " (일부)"}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}

function AssistantMessage({
  message: m,
  busy,
  disabled,
  onApply,
  onDismiss,
  onAsk,
  canRetry,
  onRetry,
  retrying,
  onReopen,
  reopening,
}: {
  message: GraphChatMessageView;
  busy: boolean;
  disabled: boolean;
  onApply: () => void;
  onDismiss: () => void;
  onAsk: (q: string) => void;
  canRetry: boolean;
  onRetry: () => void;
  retrying: boolean;
  /** 이 답변이 답함으로 정리한 후속 질문을 다시 연다(되돌리기). */
  onReopen: (ids: string[]) => void;
  reopening: boolean;
}) {
  const replyError = m.status === "failed" && m.data === null;
  if (replyError) {
    return (
      <Alert tone="error">
        {m.content}
        {canRetry && (
          <>
            {" "}
            <button type="button" className="font-semibold underline" onClick={onRetry} disabled={retrying}>
              다시 시도
            </button>
          </>
        )}
      </Alert>
    );
  }
  const proposal = m.data?.kind === "graph-proposal" ? m.data : null;
  const hasOps = !!proposal && proposal.ops.length > 0;
  const badge = hasOps && m.status ? STATUS_BADGE[m.status] : null;
  return (
    <div className="flex">
      <div className="max-w-[92%] min-w-0 space-y-2">
        <p className="rounded-2xl rounded-bl-sm bg-slate-100 px-3.5 py-2 text-sm whitespace-pre-wrap break-words text-slate-800">{m.content}</p>

        {hasOps && (
          <div className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="flex flex-wrap items-center gap-2">
              <p className="mr-auto font-medium text-slate-900">변경안: {proposal.summary || `${proposal.ops.length}개 변경`}</p>
              {badge && <Badge tone={badge.tone}>{badge.label}</Badge>}
            </div>
            {proposal.source === "document-import" && (
              <p className="mt-1 text-xs text-slate-500">이력서·포트폴리오에서 만든 변경안 · {proposal.ops.length}개 변경</p>
            )}
            <OpLineList lines={m.opLines ?? proposal.ops.map((o) => o.op)} />
            {proposal.error && <p className="mt-2 text-red-700">{proposal.error}</p>}
            {m.status === "proposed" && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" onClick={onApply} loading={busy} disabled={disabled}>
                  그래프에 적용
                </Button>
                <Button size="sm" variant="secondary" onClick={onDismiss} disabled={disabled}>
                  거절
                </Button>
              </div>
            )}
          </div>
        )}

        {proposal?.resolvedFollowups && proposal.resolvedFollowups.items.length > 0 && (
          <ResolvedFollowupsNote
            items={proposal.resolvedFollowups.items}
            stillAnswered={m.stillAnswered ?? null}
            reopened={m.reopened ?? null}
            busy={reopening}
            onReopen={onReopen}
          />
        )}

        {proposal?.followupId && m.status === "proposed" && !m.stillAnswered?.includes(proposal.followupId) && (
          <p className="text-xs text-slate-500">후속 질문에 대한 답이에요. 적용하면 그 질문을 답함으로 표시합니다.</p>
        )}

        {proposal?.droppedOps && proposal.droppedOps.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">
              변경안에서 뺀 항목 {proposal.droppedOps.length}개
              {proposal.droppedFollowups?.length ? ` · ${proposal.droppedFollowups.length}개는 후속 질문에 추가` : ""}
            </summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {proposal.droppedOps.map((d, i) => (
                <li key={i} className="break-words">
                  {d}
                  {proposal.droppedFollowups?.includes(i) && (
                    <span className="ml-1 rounded bg-amber-50 px-1 py-px text-[11px] font-medium text-amber-800 ring-1 ring-amber-200">후속 질문에 추가</span>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}

        {proposal && proposal.followUpQuestions.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {proposal.followUpQuestions.map((q, i) => (
              <button
                key={i}
                type="button"
                onClick={() => onAsk(q)}
                className="rounded-full border border-indigo-200 bg-indigo-50 px-2.5 py-1 text-left text-xs text-indigo-800 hover:bg-indigo-100"
                title="눌러서 이 질문에 답하기"
              >
                {q}
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function OpLine({ line }: { line: string }) {
  return (
    <li className="flex gap-1.5 break-words">
      <span aria-hidden className="text-slate-400">
        •
      </span>
      <span className="min-w-0">{line}</span>
    </li>
  );
}

/** 변경안 줄 목록. 많으면(문서 가져오기) 앞부분만 보이고 나머지는 펼친다. */
function OpLineList({ lines }: { lines: string[] }) {
  const head = lines.slice(0, OP_LINES_PREVIEW);
  const rest = lines.slice(OP_LINES_PREVIEW);
  return (
    <>
      <ul className="mt-2 space-y-1 text-slate-700">
        {head.map((line, i) => (
          <OpLine key={i} line={line} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="mt-1 text-slate-700">
          <summary className="cursor-pointer text-xs text-indigo-700">나머지 {rest.length}개 보기</summary>
          <ul className="mt-1 space-y-1">
            {rest.map((line, i) => (
              <OpLine key={i} line={line} />
            ))}
          </ul>
        </details>
      )}
    </>
  );
}

/**
 * 답변이 바로 답함으로 정리한 후속 질문 표시: "후속 질문 n개를 답한 것으로 정리했습니다"와 되돌리기(지금도 답함인 질문을 다시 연다).
 * stillAnswered가 null이면(상태를 못 읽음) 되돌리기를 숨긴다. 모두 지금 열려 있을 때만 "다시 열었습니다".
 * 질문별로 열림이면 "(다시 열림)", 이 답변이 정리한 상태가 아니면(나중에 건너뜀·다른 경로로 답함·삭제) "(처리됨)".
 */
function ResolvedFollowupsNote({
  items,
  stillAnswered,
  reopened,
  busy,
  onReopen,
}: {
  items: { id: string; text: string }[];
  stillAnswered: string[] | null;
  reopened: string[] | null;
  busy: boolean;
  onReopen: (ids: string[]) => void;
}) {
  const undone = reopened !== null && items.length > 0 && items.every((f) => reopened.includes(f.id));
  return (
    <details className="text-xs text-emerald-800">
      <summary className="cursor-pointer">
        {undone ? `후속 질문 ${items.length}개를 다시 열었습니다` : `후속 질문 ${items.length}개를 답한 것으로 정리했습니다`}
        {stillAnswered && stillAnswered.length > 0 && (
          <>
            {" · "}
            <button
              type="button"
              className="font-medium text-indigo-700 underline disabled:opacity-50"
              disabled={busy}
              onClick={(e) => {
                e.preventDefault();
                onReopen(stillAnswered);
              }}
            >
              {busy ? "되돌리는 중…" : "되돌리기"}
            </button>
          </>
        )}
      </summary>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-slate-600">
        {items.map((f) => (
          <li key={f.id} className="break-words">
            {f.text}
            {reopened?.includes(f.id) ? (
              <span className="ml-1 text-slate-400">(다시 열림)</span>
            ) : (
              stillAnswered &&
              !stillAnswered.includes(f.id) && <span className="ml-1 text-slate-400">(처리됨)</span>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

const FOLLOWUP_KIND_NAME = { question: "AI 질문", dropped: "뺀 항목" } as const;

/**
 * 프로젝트 대화의 후속 질문 머리: '후속 질문 k/n'과 현재 질문, 건너뛰기·다음, 펼치면 전체 목록(건너뛴 질문은 다시 열기).
 * 열린 질문이 없으면 건너뛴 질문 수만 보인다. 질문이 하나도 없으면 아무것도 보이지 않는다.
 */
function FocusFollowupBar({
  items,
  current,
  busyId,
  detached,
  onPick,
  onNext,
  onChange,
}: {
  items: GraphFollowup[];
  current: GraphFollowup | null;
  busyId: string | null;
  detached: boolean;
  onPick: (id: string | "first" | "none") => void;
  onNext: () => void;
  onChange: (f: GraphFollowup, status: "open" | "skipped") => void;
}) {
  const open = items.filter((f) => f.status === "open");
  const skipped = items.filter((f) => f.status === "skipped");
  if (items.length === 0) return null;
  const k = current ? open.findIndex((f) => f.id === current.id) + 1 : 0;
  return (
    <div className="space-y-2 border-b border-slate-100 bg-amber-50/40 px-4 py-2.5 text-sm" aria-live="polite">
      {current ? (
        <div className="flex flex-wrap items-start gap-2">
          <Badge tone="warning">
            후속 질문 {k}/{open.length}
          </Badge>
          <p className="min-w-0 flex-1 break-words text-slate-900">
            {current.text}
            {current.kind === "dropped" && current.detail && (
              <span className="mt-0.5 block text-xs text-slate-500" title={current.detail}>
                변경안에서 뺀 항목: {current.detail}
              </span>
            )}
          </p>
          <span className="inline-flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => onChange(current, "skipped")} loading={busyId === current.id} disabled={busyId !== null}>
              건너뛰기
            </Button>
            <Button size="sm" variant="secondary" onClick={onNext} disabled={open.length < 2}>
              다음
            </Button>
            <Button size="sm" variant="ghost" onClick={() => onPick("none")} title="이번 메시지는 이 질문과 상관없이 보내기">
              이번엔 질문 없이
            </Button>
          </span>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2 text-xs text-slate-600">
          {open.length > 0 ? (
            <>
              <span>
                후속 질문 {open.length}개가 남아 있어요.{detached ? " 지금은 질문과 상관없이 이야기합니다." : " 고르면 그 질문의 답으로 보냅니다."}
              </span>
              <Button size="sm" variant="secondary" onClick={() => onPick("first")}>
                후속 질문 이어서 답하기
              </Button>
            </>
          ) : (
            <span>열린 후속 질문이 없어요{skipped.length > 0 ? ` · 건너뛴 질문 ${skipped.length}개` : ""}.</span>
          )}
        </div>
      )}
      <details className="text-xs text-slate-600">
        <summary className="cursor-pointer">
          후속 질문 목록 (열림 {open.length}
          {skipped.length > 0 ? ` · 건너뜀 ${skipped.length}` : ""})
        </summary>
        <ul className="mt-1.5 max-h-48 space-y-1 overflow-y-auto">
          {items.map((f) => (
            <li key={f.id} className={cn("flex items-start gap-2 rounded-md px-2 py-1", f.id === current?.id && "bg-white ring-1 ring-amber-200")}>
              <span className="shrink-0 text-slate-400">{f.status === "skipped" ? "건너뜀" : FOLLOWUP_KIND_NAME[f.kind]}</span>
              <span className={cn("min-w-0 flex-1 break-words", f.status === "skipped" && "text-slate-400 line-through")}>{f.text}</span>
              {f.status === "open" ? (
                f.id !== current?.id && (
                  <button type="button" className="shrink-0 font-medium text-indigo-700 underline" onClick={() => onPick(f.id)}>
                    이 질문 답하기
                  </button>
                )
              ) : (
                <button
                  type="button"
                  className="shrink-0 font-medium text-indigo-700 underline disabled:opacity-50"
                  onClick={() => onChange(f, "open")}
                  disabled={busyId !== null}
                >
                  다시 열기
                </button>
              )}
            </li>
          ))}
        </ul>
      </details>
    </div>
  );
}

/** 일반 대화: 프로젝트 미지정 후속 질문(접힌 목록). 답하기(이 대화에서), 프로젝트 지정, 건너뛰기. */
function UnassignedFollowups({
  items,
  currentId,
  busyId,
  projects,
  projectsError,
  onLoadProjects,
  onAnswer,
  onAssign,
  onSkip,
}: {
  items: GraphFollowup[];
  currentId: string | null;
  busyId: string | null;
  projects: { id: string; name: string }[] | null;
  projectsError: boolean;
  onLoadProjects: () => void;
  onAnswer: (f: GraphFollowup) => void;
  onAssign: (f: GraphFollowup, projectNodeId: string) => void;
  onSkip: (f: GraphFollowup) => void;
}) {
  return (
    <details
      className="border-b border-slate-100 bg-amber-50/30 px-4 py-2 text-sm"
      onToggle={(e) => {
        if ((e.currentTarget as HTMLDetailsElement).open) onLoadProjects();
      }}
    >
      <summary className="cursor-pointer text-xs font-medium text-amber-900">프로젝트 미지정 후속 질문 {items.length}개</summary>
      <ul className="mt-2 max-h-64 space-y-2 overflow-y-auto">
        {items.map((f) => (
          <li key={f.id} className={cn("rounded-md bg-white px-2.5 py-2 ring-1 ring-slate-200", f.id === currentId && "ring-amber-300")}>
            <p className="break-words text-slate-800">{f.text}</p>
            {f.kind === "dropped" && f.detail && <p className="mt-0.5 break-words text-xs text-slate-500">변경안에서 뺀 항목: {f.detail}</p>}
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              <Button size="sm" variant="secondary" onClick={() => onAnswer(f)} disabled={f.id === currentId}>
                {f.id === currentId ? "선택됨" : "이 대화에서 답하기"}
              </Button>
              {projects && projects.length > 0 && (
                <>
                  <label className="sr-only" htmlFor={`followup-assign-${f.id}`}>
                    프로젝트 지정
                  </label>
                  <select
                    id={`followup-assign-${f.id}`}
                    className="h-8 min-w-0 max-w-[12rem] rounded-lg border border-slate-300 bg-white px-2 text-xs text-slate-800"
                    value=""
                    disabled={busyId !== null}
                    onChange={(e) => e.target.value && onAssign(f, e.target.value)}
                  >
                    <option value="">프로젝트 지정…</option>
                    {projects.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.name}
                      </option>
                    ))}
                  </select>
                </>
              )}
              {projects && projects.length === 0 && <span className="text-xs text-slate-500">지정할 프로젝트가 없습니다</span>}
              {projectsError && <span className="text-xs text-slate-500">프로젝트 목록을 불러오지 못했습니다</span>}
              <Button size="sm" variant="ghost" onClick={() => onSkip(f)} loading={busyId === f.id} disabled={busyId !== null}>
                건너뛰기
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}
