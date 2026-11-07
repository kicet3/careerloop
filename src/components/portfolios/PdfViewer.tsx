"use client";
/**
 * 화면 안 PDF 보기(pdf.js로 쪽마다 캔버스에 그린다 — 브라우저 내장 PDF 보기가 없는 모바일에서도 같은 모양).
 * - 내려받기: 원본 라우트의 ?viewer=1(Range 206 조각, original-serve.ts)을 우리 출처 fetch로 받는다. 첫 조각(1MB)으로 전체 크기를 알고,
 *   더 큰 파일은 PDFDataRangeTransport로 필요한 부분만 조각(≤ 1MB)으로 더 받는다(R2 서명 주소·302를 거치지 않는다).
 * - 그리기: 쪽마다 IntersectionObserver로 화면 근처에 올 때만 그리고, 멀어지면 캔버스를 지운다(모바일 메모리). 폭 맞춤(360px 화면 포함)·
 *   확대/축소·devicePixelRatio 반영(pdf-viewer-layout.ts). 새 크기는 다른 캔버스에 다 그린 뒤 바꿔 끼워 깜빡이지 않는다.
 * - 글자 선택 층(text layer)은 두지 않는다 — 뽑은 글은 화면의 '텍스트로 보기'가 따로 보인다.
 * - pdf.js(legacy 빌드)와 워커·CMap·글꼴은 처음 열 때만 불러온다(/pdfjs/<판>/... 라우트, pdfjs-assets.ts). PDF 안 스크립트·XFA는 돌리지 않는다(enableXfa false, 스크립팅은 붙이지 않음).
 */
import { type RefObject, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from "pdfjs-dist/legacy/build/pdf.mjs";
import { buttonClass } from "@/components/ui/Button";
import { pdfjsAssetBase, PDFJS_WORKER_URL } from "@/lib/portfolios/pdfjs-assets";
import {
  computePageLayout,
  currentPageIndex,
  FIT_ZOOM,
  parseContentRange,
  splitRange,
  ZOOM_LEVELS,
  zoomIn,
  zoomOut,
} from "./pdf-viewer-layout";

/** 첫 조각 크기. 이보다 작은 PDF는 한 번에 받는다. */
const INITIAL_BYTES = 1024 * 1024;
/** 이후 조각 하나의 상한(서버 상한 4MB 안). pdf.js 조각(RANGE_CHUNK)의 배수여야 한다. */
const PIECE_BYTES = 1024 * 1024;
const RANGE_CHUNK = 256 * 1024;
/** 화면에서 이만큼 떨어진 쪽까지 미리 그린다. */
const PRERENDER_MARGIN = "800px 0px";

class ViewerFetchError extends Error {
  constructor(readonly status: number) {
    super(`HTTP ${status}`);
    this.name = "ViewerFetchError";
  }
}

async function fetchRange(src: string, start: number, endInclusive: number, signal: AbortSignal): Promise<{ bytes: Uint8Array; total: number }> {
  const res = await fetch(src, {
    headers: { Range: `bytes=${start}-${endInclusive}` },
    cache: "no-store",
    credentials: "same-origin",
    referrerPolicy: "no-referrer",
    signal,
  });
  if (res.status === 200) {
    const bytes = new Uint8Array(await res.arrayBuffer());
    if (start !== 0) throw new ViewerFetchError(200);
    return { bytes, total: bytes.byteLength };
  }
  if (res.status !== 206) throw new ViewerFetchError(res.status);
  const range = parseContentRange(res.headers.get("content-range"));
  if (!range || range.start !== start) throw new ViewerFetchError(206);
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength !== range.end - range.start + 1) throw new ViewerFetchError(206);
  return { bytes, total: range.total };
}

function concatBytes(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0));
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.byteLength;
  }
  return out;
}

function errorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name;
  if (name === "PasswordException") return "암호가 걸린 PDF는 화면에서 열 수 없습니다. 원본을 내려받아 확인해 주세요.";
  if (name === "InvalidPDFException") return "PDF 파일을 읽지 못했습니다. 원본을 내려받아 확인해 주세요.";
  if (err instanceof ViewerFetchError && err.status === 404) return "파일을 찾을 수 없습니다. 링크가 바뀌었거나 공개가 끝났을 수 있습니다.";
  if (err instanceof ViewerFetchError && err.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  return "PDF를 화면에 보이지 못했습니다. 다시 시도하거나 원본을 내려받아 확인해 주세요.";
}

type PageSize = { width: number; height: number };
type LoadState =
  | { kind: "loading" }
  | { kind: "ready"; doc: PDFDocumentProxy; numPages: number; firstSize: PageSize }
  | { kind: "error"; message: string };

export interface PdfViewerProps {
  /** ?viewer=1을 붙인 원본 주소(Range 요청을 받는 라우트). */
  src: string;
  /** 오류일 때 보여 줄 원본 내려받기 주소. */
  downloadHref: string;
  /** 보기 칸 이름(스크린리더). */
  title: string;
  /** 스크롤 칸 높이(CSS 값). */
  height?: string;
}

export function PdfViewer(props: PdfViewerProps) {
  // 다시 시도 = 안쪽을 새로 만든다(effect 안에서 상태를 되돌리지 않는다).
  const [attempt, setAttempt] = useState(0);
  return <PdfViewerInner key={`${props.src}#${attempt}`} {...props} onRetry={() => setAttempt((n) => n + 1)} />;
}

function PdfViewerInner({ src, downloadHref, title, height = "80vh", onRetry }: PdfViewerProps & { onRetry: () => void }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [zoom, setZoom] = useState<number>(FIT_ZOOM);
  const [containerWidth, setContainerWidth] = useState(0);
  const [dpr, setDpr] = useState(1);
  const [sizes, setSizes] = useState<Record<number, PageSize>>({});
  const [current, setCurrent] = useState(0);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const pageEls = useRef<(HTMLDivElement | null)[]>([]);
  const scrollRatio = useRef<number | null>(null);

  // 문서 불러오기.
  useEffect(() => {
    let cancelled = false;
    const ac = new AbortController();
    let task: PDFDocumentLoadingTask | null = null;
    const fail = (err: unknown) => {
      if (cancelled) return;
      cancelled = true;
      ac.abort();
      void task?.destroy();
      setState({ kind: "error", message: errorMessage(err) });
    };
    (async () => {
      const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
      pdfjs.GlobalWorkerOptions.workerSrc = PDFJS_WORKER_URL;
      const first = await fetchRange(src, 0, INITIAL_BYTES - 1, ac.signal);
      if (cancelled) return;
      const common = {
        cMapUrl: pdfjsAssetBase("cmaps"),
        cMapPacked: true,
        standardFontDataUrl: pdfjsAssetBase("standard_fonts"),
        wasmUrl: pdfjsAssetBase("wasm"),
        iccUrl: pdfjsAssetBase("iccs"),
        enableXfa: false,
        disableAutoFetch: true,
        disableStream: true,
        rangeChunkSize: RANGE_CHUNK,
      };
      if (first.bytes.byteLength >= first.total) {
        task = pdfjs.getDocument({ ...common, data: first.bytes });
      } else {
        const transport = new pdfjs.PDFDataRangeTransport(first.total, first.bytes);
        // pdf.js는 붙어 있는 조각을 한 요청으로 묶어(상한 없음) [begin, end)를 묻고, 그 요청은 begin으로 찾은 읽기 하나가
        // 조각 한 번만 받는다(PDFDataTransportStreamRangeReader). 그래서 1MB 이하 조각으로 나눠 받되, 다 모아 begin 하나로 넘긴다.
        transport.requestDataRange = (begin: number, end: number) => {
          Promise.all(splitRange(begin, end, PIECE_BYTES).map(([b, e]) => fetchRange(src, b, e - 1, ac.signal))).then(
            (parts) => {
              if (cancelled) return;
              transport.onDataRange(begin, parts.length === 1 ? parts[0]!.bytes : concatBytes(parts.map((p) => p.bytes)));
            },
            (err) => fail(err),
          );
        };
        task = pdfjs.getDocument({ ...common, range: transport });
      }
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const vp = page.getViewport({ scale: 1 });
      if (cancelled) return;
      setState({ kind: "ready", doc, numPages: doc.numPages, firstSize: { width: vp.width, height: vp.height } });
    })().catch((err) => {
      if ((err as { name?: string } | null)?.name === "AbortError" && cancelled) return;
      fail(err);
    });
    return () => {
      cancelled = true;
      ac.abort();
      void task?.destroy();
    };
  }, [src]);

  // 칸 폭·화면 배율 재기(창 크기·회전·브라우저 확대).
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const measure = () => {
      const cs = getComputedStyle(el);
      const w = el.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
      setContainerWidth(Math.max(1, Math.floor(w)));
      setDpr(window.devicePixelRatio || 1);
    };
    const ro = new ResizeObserver(() => {
      clearTimeout(timer);
      timer = setTimeout(measure, 120);
    });
    ro.observe(el);
    measure();
    return () => {
      clearTimeout(timer);
      ro.disconnect();
    };
  }, []);

  // 확대를 바꾼 뒤 보던 자리(비율)를 지킨다.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || scrollRatio.current === null) return;
    el.scrollTop = scrollRatio.current * el.scrollHeight;
    scrollRatio.current = null;
  }, [zoom]);

  const changeZoom = (next: number) => {
    const el = scrollRef.current;
    if (el && el.scrollHeight > 0) scrollRatio.current = el.scrollTop / el.scrollHeight;
    setZoom(next);
  };

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const tops = pageEls.current.map((p) => p?.offsetTop ?? 0);
    setCurrent(currentPageIndex(tops, el.scrollTop, el.clientHeight));
  }, []);

  const onSize = useCallback((index: number, size: PageSize) => {
    setSizes((prev) => {
      const old = prev[index];
      if (old && Math.abs(old.width - size.width) < 0.5 && Math.abs(old.height - size.height) < 0.5) return prev;
      return { ...prev, [index]: size };
    });
  }, []);

  const ready = state.kind === "ready" ? state : null;
  const numPages = ready?.numPages ?? 0;
  const busy = !ready;

  return (
    <div className="overflow-hidden rounded-lg border border-slate-200 bg-slate-100">
      <div role="toolbar" aria-label={`${title} 보기 도구`} className="flex flex-wrap items-center justify-between gap-2 border-b border-slate-200 bg-white px-2 py-1.5">
        <span className="min-w-[4.5rem] text-sm text-slate-700 tabular-nums">
          <span className="sr-only">쪽 위치 </span>
          {ready ? `${current + 1} / ${numPages}` : "– / –"}
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className={buttonClass("ghost", "sm", "w-8 px-0")}
            aria-label="축소"
            title="축소"
            disabled={busy || zoom <= ZOOM_LEVELS[0]}
            onClick={() => changeZoom(zoomOut(zoom))}
          >
            <span aria-hidden>−</span>
          </button>
          <span className="w-12 text-center text-xs text-slate-600 tabular-nums">
            <span className="sr-only">확대 비율 </span>
            {Math.round(zoom * 100)}%
          </span>
          <button
            type="button"
            className={buttonClass("ghost", "sm", "w-8 px-0")}
            aria-label="확대"
            title="확대"
            disabled={busy || zoom >= ZOOM_LEVELS[ZOOM_LEVELS.length - 1]}
            onClick={() => changeZoom(zoomIn(zoom))}
          >
            <span aria-hidden>+</span>
          </button>
          <button
            type="button"
            className={buttonClass("ghost", "sm")}
            aria-label="폭에 맞추기"
            aria-pressed={zoom === FIT_ZOOM}
            disabled={busy}
            onClick={() => changeZoom(FIT_ZOOM)}
          >
            폭 맞춤
          </button>
        </div>
      </div>

      <div
        ref={scrollRef}
        role="region"
        aria-label={title}
        aria-busy={state.kind === "loading"}
        tabIndex={0}
        onScroll={onScroll}
        className="relative overflow-auto overscroll-contain p-2 outline-none focus-visible:ring-2 focus-visible:ring-indigo-400 sm:p-4"
        style={{ height }}
      >
        {state.kind === "loading" && <PdfSkeleton />}
        {state.kind === "error" && (
          <div role="alert" className="mx-auto max-w-md space-y-3 rounded-lg border border-slate-200 bg-white p-4 text-sm text-slate-700">
            <p>{state.message}</p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className={buttonClass("secondary", "sm")} onClick={onRetry}>
                다시 시도
              </button>
              <a href={downloadHref} className={buttonClass("primary", "sm")}>
                원본 내려받기
              </a>
            </div>
          </div>
        )}
        {ready && containerWidth > 0 && (
          <div className="mx-auto flex w-max min-w-full flex-col items-center gap-3 sm:gap-4">
            {Array.from({ length: numPages }, (_, i) => {
              const size = sizes[i] ?? ready.firstSize;
              const layout = computePageLayout({ pageWidth: size.width, pageHeight: size.height, containerWidth, zoom, devicePixelRatio: dpr });
              return (
                <PdfPage
                  key={i}
                  doc={ready.doc}
                  index={i}
                  numPages={numPages}
                  scale={layout.scale}
                  pixelRatio={layout.pixelRatio}
                  cssWidth={layout.cssWidth}
                  cssHeight={layout.cssHeight}
                  rootRef={scrollRef}
                  onSize={onSize}
                  elRef={(el) => {
                    pageEls.current[i] = el;
                  }}
                />
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function PdfSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4">
      {[0, 1].map((i) => (
        <div key={i} className="aspect-[1/1.414] w-full animate-pulse rounded bg-white shadow-sm motion-reduce:animate-none" />
      ))}
      <span className="sr-only" role="status">
        PDF를 불러오는 중입니다.
      </span>
    </div>
  );
}

function PdfPage({
  doc,
  index,
  numPages,
  scale,
  pixelRatio,
  cssWidth,
  cssHeight,
  rootRef,
  onSize,
  elRef,
}: {
  doc: PDFDocumentProxy;
  index: number;
  numPages: number;
  scale: number;
  pixelRatio: number;
  cssWidth: number;
  cssHeight: number;
  rootRef: RefObject<HTMLDivElement | null>;
  onSize: (index: number, size: PageSize) => void;
  elRef: (el: HTMLDivElement | null) => void;
}) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const canvasHolder = useRef<HTMLDivElement | null>(null);
  const [near, setNear] = useState(false);
  const [renderedKey, setRenderedKey] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  const renderKey = `${scale.toFixed(4)}@${pixelRatio.toFixed(3)}`;

  // 화면 근처에 왔는지.
  useEffect(() => {
    const el = boxRef.current;
    if (!el) return;
    const io = new IntersectionObserver(
      (entries) => {
        // 한 번에 같은 요소의 기록이 여럿 올 수 있다 — 마지막 것이 지금 상태다.
        const visible = entries[entries.length - 1]?.isIntersecting ?? false;
        setNear(visible);
        // 멀어지면 그린 것을 지운다(아래 effect) — 다시 오면 그릴 때까지 자리 표시를 보인다.
        if (!visible) setRenderedKey(null);
      },
      {
        root: rootRef.current,
        rootMargin: PRERENDER_MARGIN,
      },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [rootRef]);

  // 그리기(근처일 때만). 멀어지면 캔버스를 비운다.
  useEffect(() => {
    const holder = canvasHolder.current;
    if (!holder) return;
    if (!near) {
      for (const c of holder.querySelectorAll("canvas")) {
        c.width = 0;
        c.height = 0;
      }
      holder.replaceChildren();
      return;
    }
    let cancelled = false;
    let task: RenderTask | null = null;
    (async () => {
      const page = await doc.getPage(index + 1);
      if (cancelled) return;
      const base = page.getViewport({ scale: 1 });
      onSize(index, { width: base.width, height: base.height });
      const viewport = page.getViewport({ scale: scale * pixelRatio });
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width));
      canvas.height = Math.max(1, Math.floor(viewport.height));
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      canvas.setAttribute("aria-hidden", "true");
      task = page.render({ canvas, viewport });
      await task.promise;
      if (cancelled) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      for (const c of holder.querySelectorAll("canvas")) {
        c.width = 0;
        c.height = 0;
      }
      holder.replaceChildren(canvas);
      setRenderedKey(renderKey);
      setFailed(false);
    })().catch((err) => {
      if (cancelled || (err as { name?: string } | null)?.name === "RenderingCancelledException") return;
      setFailed(true);
    });
    return () => {
      cancelled = true;
      task?.cancel();
    };
  }, [near, doc, index, scale, pixelRatio, renderKey, onSize]);

  const shown = near && renderedKey !== null;
  return (
    <div
      ref={(el) => {
        boxRef.current = el;
        elRef(el);
      }}
      role="img"
      aria-label={`${numPages}쪽 중 ${index + 1}쪽`}
      className="relative shrink-0 overflow-hidden bg-white shadow-sm"
      style={{ width: cssWidth, height: cssHeight }}
    >
      <div ref={canvasHolder} className="absolute inset-0" />
      {!shown && !failed && <div className="absolute inset-0 animate-pulse bg-slate-50 motion-reduce:animate-none" aria-hidden />}
      {failed && (
        <p className="absolute inset-0 flex items-center justify-center p-4 text-center text-xs text-slate-500">이 쪽을 그리지 못했습니다.</p>
      )}
    </div>
  );
}
