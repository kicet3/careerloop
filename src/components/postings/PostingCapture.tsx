"use client";
/**
 * 공고 원문 캡처: 상태 버튼('원문 캡처 보기' · '캡처 중…' · '캡처 없음 · 다시 시도')과 캡처 보기 모달.
 * 이미지는 인증 라우트(apiBase + "/capture")로만 받는다. 캡처는 원문 확인용 사본이고 출처는 원문 링크다.
 * apiBase: "/api/postings/<내 공고 id>" 또는 "/api/shared-postings/<공용 공고 id>".
 */
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { formatDateTime } from "@/components/app/stages";
import { Spinner } from "@/components/ui/Spinner";
import { cn } from "@/components/ui/cn";
import { POSTING_CAPTURE, type PostingCaptureInfo } from "@/lib/domain/posting-capture";
import { SourceLink } from "./SourceLink";
import { readApiError } from "./shared";

const POLL_MS = 4_000;
/**
 * 찍는 중 상태를 따라가는 최대 시간. 서버는 POSTING_CAPTURE.staleMs가 지나면 멈춘 캡처(대기열에서 밀렸거나 after() 작업이 죽은 것)를
 * '실패 · 다시 시도'로 알려 주므로 그보다 길게 따라간다. 그래도 끝나지 않으면 스피너 대신 '다시 확인' 버튼을 보인다.
 */
const POLL_LIMIT_MS = POSTING_CAPTURE.staleMs + 30_000;

const linkButton =
  "inline-flex items-center gap-1 text-sm font-medium text-indigo-700 hover:underline disabled:cursor-not-allowed disabled:opacity-50 disabled:no-underline";

export function PostingCaptureButton({
  apiBase,
  initial,
  sourceUrl,
  title,
  className,
}: {
  apiBase: string;
  initial: PostingCaptureInfo | undefined;
  sourceUrl: string;
  /** 모달 제목(회사 · 직무). */
  title: string;
  className?: string;
}) {
  const [info, setInfo] = useState<PostingCaptureInfo | undefined>(initial);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [gaveUp, setGaveUp] = useState(false);
  const pollStarted = useRef<number | null>(null);
  const status = info?.status;
  const active = status === "pending" || status === "running";

  // 찍는 중이면 상태를 다시 읽는다(최대 POLL_LIMIT_MS, 넘으면 gaveUp → '다시 확인').
  useEffect(() => {
    if (!active) {
      pollStarted.current = null;
      return;
    }
    if (gaveUp) return;
    pollStarted.current ??= Date.now();
    const timer = setTimeout(async () => {
      if (pollStarted.current !== null && Date.now() - pollStarted.current > POLL_LIMIT_MS) {
        setGaveUp(true);
        return;
      }
      try {
        const res = await fetch(`${apiBase}/capture/info`, { cache: "no-store" });
        if (res.ok) setInfo((await res.json()) as PostingCaptureInfo);
        else setInfo((i) => (i ? { ...i } : i)); // 다음 주기에 다시 묻는다
      } catch {
        setInfo((i) => (i ? { ...i } : i));
      }
    }, POLL_MS);
    return () => clearTimeout(timer);
  }, [active, apiBase, info, gaveUp]);

  /** 따라가기를 멈춘 뒤 사용자가 누르면 한 번 다시 읽고, 아직 찍는 중이면 다시 따라간다. */
  async function recheck() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/capture/info`, { cache: "no-store" });
      if (!res.ok) {
        setError((await readApiError(res, "캡처 상태를 확인하지 못했습니다.")).error);
        return;
      }
      setInfo((await res.json()) as PostingCaptureInfo);
      pollStarted.current = Date.now();
      setGaveUp(false);
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  async function retry() {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`${apiBase}/capture`, { method: "POST" });
      if (!res.ok) {
        setError((await readApiError(res, "캡처를 다시 시도하지 못했습니다.")).error);
        return;
      }
      const data = (await res.json()) as { capture: PostingCaptureInfo | null };
      if (data.capture) setInfo(data.capture);
      pollStarted.current = Date.now();
      setGaveUp(false);
    } catch {
      setError("서버에 연결하지 못했습니다. 네트워크를 확인해 주세요.");
    } finally {
      setBusy(false);
    }
  }

  if (!info) return null;
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-x-2 gap-y-1", className)}>
      {status === "done" ? (
        <button type="button" className={linkButton} onClick={() => setOpen(true)} aria-haspopup="dialog">
          원문 캡처 보기
        </button>
      ) : active && gaveUp ? (
        <span className="inline-flex items-center gap-1 text-sm text-slate-500">
          캡처가 오래 걸립니다
          <span aria-hidden>·</span>
          <button type="button" className={linkButton} onClick={() => void recheck()} disabled={busy}>
            {busy ? "확인 중…" : "다시 확인"}
          </button>
        </span>
      ) : active ? (
        <span className="inline-flex items-center gap-1.5 text-sm text-slate-500" role="status">
          <Spinner size="sm" /> 원문 캡처 중…
        </span>
      ) : (
        <span className="inline-flex items-center gap-1 text-sm text-slate-500">
          캡처 없음
          {info.retryable && (
            <>
              <span aria-hidden>·</span>
              <button type="button" className={linkButton} onClick={() => void retry()} disabled={busy} title={info.error ?? undefined}>
                {busy ? "요청 중…" : "다시 시도"}
              </button>
            </>
          )}
        </span>
      )}
      {error && (
        <span className="text-xs text-red-700" role="alert">
          {error}
        </span>
      )}
      {open && info.status === "done" && (
        <CaptureModal
          src={`${apiBase}/capture?v=${info.capturedAt ?? 0}`}
          info={info}
          sourceUrl={sourceUrl}
          title={title}
          onClose={() => setOpen(false)}
        />
      )}
    </span>
  );
}

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2] as const;

function CaptureModal({
  src,
  info,
  sourceUrl,
  title,
  onClose,
}: {
  src: string;
  info: PostingCaptureInfo;
  sourceUrl: string;
  title: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  /** null = 화면 폭에 맞춤. 숫자는 원본(1280px) 대비 배율. */
  const [zoom, setZoom] = useState<number | null>(null);
  const [loaded, setLoaded] = useState<"loading" | "ok" | "error">("loading");
  const naturalWidth = info.width ?? 1280;

  const step = useCallback(
    (dir: 1 | -1) =>
      setZoom((z) => {
        const current = z ?? 1;
        const next = dir > 0 ? ZOOMS.find((v) => v > current + 0.001) : [...ZOOMS].reverse().find((v) => v < current - 0.001);
        return next ?? current;
      }),
    [],
  );

  useEffect(() => {
    const prevOverflow = document.body.style.overflow;
    const prevFocus = document.activeElement as HTMLElement | null;
    document.body.style.overflow = "hidden";
    dialogRef.current?.focus();
    function onKey(e: KeyboardEvent) {
      if (e.isComposing || e.keyCode === 229) return;
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
        return;
      }
      if ((e.key === "+" || e.key === "=") && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        step(1);
        return;
      }
      if (e.key === "-" && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        step(-1);
        return;
      }
      // 포커스 트랩: Tab이 모달 밖(가려진 화면)으로 빠져나가지 않게 한다.
      const panel = dialogRef.current;
      if (e.key !== "Tab" || !panel) return;
      const focusables = [
        ...panel.querySelectorAll<HTMLElement>('a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"])'),
      ].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusables.length === 0) {
        e.preventDefault();
        panel.focus();
        return;
      }
      const first = focusables[0]!;
      const last = focusables[focusables.length - 1]!;
      const activeEl = document.activeElement;
      if (!panel.contains(activeEl)) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && (activeEl === first || activeEl === panel)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && activeEl === last) {
        e.preventDefault();
        first.focus();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prevOverflow;
      prevFocus?.focus?.();
    };
  }, [onClose, step]);

  const zoomBtn =
    "inline-flex h-8 min-w-8 items-center justify-center rounded-md border border-slate-300 bg-white px-2 text-sm font-medium text-slate-700 hover:bg-slate-50 disabled:opacity-40";

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-stretch justify-center print:hidden sm:p-4">
      <div className="absolute inset-0 bg-slate-900/60" aria-hidden onClick={onClose} />
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="relative flex h-dvh w-full max-w-6xl flex-col bg-white shadow-xl focus:outline-none sm:h-auto sm:rounded-xl"
      >
        <header className="flex flex-wrap items-start justify-between gap-3 border-b border-slate-200 px-4 py-3 sm:px-5">
          <div className="min-w-0">
            <h2 id={titleId} className="truncate font-semibold text-slate-900">
              원문 캡처 · {title}
            </h2>
            <p className="mt-0.5 flex flex-wrap items-center gap-x-2 text-xs text-slate-500">
              {info.capturedAt && <span>{formatDateTime(info.capturedAt)} 캡처</span>}
              <span aria-hidden>·</span>
              <span>원문 확인용 사본</span>
              <span aria-hidden>·</span>
              <SourceLink url={sourceUrl} label="출처 링크" className="text-xs" />
            </p>
          </div>
          <div className="flex items-center gap-1.5">
            <button type="button" className={zoomBtn} onClick={() => step(-1)} aria-label="축소" disabled={zoom !== null && zoom <= ZOOMS[0]}>
              −
            </button>
            <button type="button" className={cn(zoomBtn, "w-16")} onClick={() => setZoom((z) => (z === null ? 1 : null))} aria-label={zoom === null ? "원본 크기로 보기" : "화면 폭에 맞추기"}>
              {zoom === null ? "맞춤" : `${Math.round(zoom * 100)}%`}
            </button>
            <button type="button" className={zoomBtn} onClick={() => step(1)} aria-label="확대" disabled={zoom !== null && zoom >= ZOOMS[ZOOMS.length - 1]!}>
              +
            </button>
            <button
              type="button"
              onClick={onClose}
              aria-label="캡처 닫기"
              className="ml-1 inline-flex h-8 w-8 items-center justify-center rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-800"
            >
              <span aria-hidden>✕</span>
            </button>
          </div>
        </header>
        <div className="relative min-h-0 flex-1 overflow-auto bg-slate-100 sm:max-h-[calc(100dvh-8rem)]" tabIndex={0} aria-label="캡처 이미지 (스크롤)">
          {loaded === "loading" && (
            <div className="absolute inset-x-0 top-6 flex justify-center" role="status">
              <Spinner size="sm" />
              <span className="sr-only">캡처를 불러오는 중</span>
            </div>
          )}
          {loaded === "error" ? (
            <p className="p-6 text-sm text-slate-600">캡처를 불러오지 못했습니다. 잠시 후 다시 열어 보세요.</p>
          ) : (
            // eslint-disable-next-line @next/next/no-img-element -- 인증 라우트의 개인 이미지(최적화·캐시 경유 금지)
            <img
              src={src}
              alt={`${title} 공고 원문 페이지 캡처`}
              onLoad={() => setLoaded("ok")}
              onError={() => setLoaded("error")}
              className={cn("mx-auto block h-auto max-w-none bg-white", zoom === null && "w-full max-w-[1280px]")}
              style={zoom === null ? undefined : { width: `${Math.round(naturalWidth * zoom)}px` }}
            />
          )}
        </div>
        {info.height && info.height >= POSTING_CAPTURE.maxHeight && (
          <p className="border-t border-slate-200 px-4 py-2 text-xs text-slate-500 sm:px-5">
            페이지가 길어 위쪽 일부만 캡처했습니다. 전체 내용은 출처 링크에서 확인하세요.
          </p>
        )}
      </div>
    </div>,
    document.body,
  );
}
