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
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Badge, Button, Card, Spinner, cn } from "@/components/ui";
import type { GraphChatMessageView, GraphThreadFocus, GraphThreadView } from "@/lib/chat/graph-chat";
import type { ChatThread } from "@/lib/domain/chat";
import { MAX_CHAT_MESSAGE_CHARS } from "@/lib/domain/chat";
import { nodeDisplayName } from "@/lib/domain/graph";
import { NO_ENGINE_MESSAGE, type ProviderId, type ProviderOption } from "@/lib/domain/providers";
import { SELF_HOSTED_UPLOAD_LIMITS, type UploadLimits } from "@/lib/ingest/upload-limits";
import { emitGraphChanged, fetchGraph, focusGraphNode, GRAPH_CHANGED_EVENT, GRAPH_CHAT_ASK_EVENT, GRAPH_CHAT_PROJECT_EVENT } from "./api";
import { chatApi as api, useElapsed } from "./chat-client";
import { GraphImportForm } from "./GraphImportForm";

const PROVIDER_STORAGE_KEY = "graph-chat:provider";
/** 새 프로젝트 대화의 입력에 미리 채우는 문장(보내기는 사용자가 누른다). */
const projectStarter = (name: string) => `‘${name}’ 프로젝트를 더 구체적으로 정리하고 싶어요. 빠진 부분부터 하나씩 물어봐 주세요.`;
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
  const openProject = useCallback(async (projectId: string) => {
    setError(null);
    setOpening(true);
    try {
      const r = await api<{ thread: ChatThread; created: boolean }>("/api/graph/chat/threads", {
        method: "POST",
        json: { focusNodeId: projectId, reuse: true },
      });
      setThreads((ts) => [r.thread, ...(ts ?? []).filter((t) => t.id !== r.thread.id)]);
      setThreadId(r.thread.id);
      setInput(r.created ? projectStarter(r.thread.title) : "");
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
      const projectId = (ev as CustomEvent<{ projectId?: string } | undefined>).detail?.projectId;
      if (!projectId) return;
      ev.preventDefault();
      void openProject(projectId);
    };
    window.addEventListener(GRAPH_CHAT_PROJECT_EVENT, onProject);
    return () => window.removeEventListener(GRAPH_CHAT_PROJECT_EVENT, onProject);
  }, [openProject]);

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
          // 답이 오면 스레드 목록 순서·제목도 갱신한다.
          api<{ threads: ChatThread[] }>("/api/graph/chat/threads").then((r) => setThreads(r.threads), () => {});
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
      await api(`/api/graph/chat/threads/${encodeURIComponent(id)}/messages`, { method: "POST", json: { message: text, provider } });
      setInput("");
      clearAskQuery();
      await loadThread(id);
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
      if (action === "apply" && r.message.status === "applied") emitGraphChanged("chat");
      await loadThread(threadId);
    } catch (e) {
      setError((e as Error).message);
      await loadThread(threadId).catch(() => {});
    } finally {
      setBusyMessage(null);
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

  function askAbout(question: string) {
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
        {threadId && (
          <Button size="sm" variant="ghost" onClick={removeThread} aria-label="이 대화 삭제">
            삭제
          </Button>
        )}
      </div>

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
          ) : m.role === "user" ? (
            <div key={m.id} className="flex justify-end">
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
}: {
  focus: GraphThreadFocus | null;
  title: string;
  onShowInGraph: () => void;
  onPick: (itemName: string) => void;
  onLeave: () => void;
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

        {proposal?.droppedOps && proposal.droppedOps.length > 0 && (
          <details className="text-xs text-slate-500">
            <summary className="cursor-pointer">변경안에서 뺀 항목 {proposal.droppedOps.length}개</summary>
            <ul className="mt-1 list-disc space-y-0.5 pl-4">
              {proposal.droppedOps.map((d, i) => (
                <li key={i} className="break-words">
                  {d}
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
