"use client";
/**
 * 원본 PDF 보기 칸. 데스크톱 브라우저는 내장 PDF 보기(iframe)로 그대로 보여 준다.
 * 모바일은 iframe 안의 PDF를 제대로 그리지 못한다(Android Chrome은 빈 칸·내려받기로 넘어가고, iOS Safari는 첫 쪽만 보이고 스크롤되지 않는다) —
 * 그런 기기(또는 navigator.pdfViewerEnabled === false)에서는 iframe 대신 안내와 '새 탭에서 열기'·'원본 내려받기'를 앞세운다.
 */
import { useSyncExternalStore } from "react";
import { buttonClass } from "@/components/ui/Button";

const noop = () => () => {};

/** 이 기기에서 iframe 안 PDF 보기를 믿을 수 있는지(서버 렌더·첫 그리기는 true — 데스크톱이 대부분이다). */
function inlinePdfSupported(): boolean {
  const nav = navigator as Navigator & { pdfViewerEnabled?: boolean };
  if (nav.pdfViewerEnabled === false) return false;
  const ua = nav.userAgent;
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return false;
  // iPadOS는 데스크톱(Macintosh) UA를 보낸다.
  if (/Macintosh/.test(ua) && nav.maxTouchPoints > 1) return false;
  return true;
}

export function PortfolioPdfFrame({ src, downloadHref, title, height }: { src: string; downloadHref: string; title: string; height: string }) {
  const supported = useSyncExternalStore(noop, inlinePdfSupported, () => true);
  if (!supported) {
    return (
      <div className="space-y-2 rounded-lg border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">
        <p>이 기기에서는 PDF를 화면 안에서 열 수 없습니다. 새 탭에서 열거나 원본을 내려받아 확인해 주세요.</p>
        <div className="flex flex-wrap gap-2">
          <a href={src} target="_blank" rel="noopener noreferrer" className={buttonClass("primary", "sm")}>
            새 탭에서 열기
          </a>
          <a href={downloadHref} className={buttonClass("secondary", "sm")}>
            원본 내려받기
          </a>
        </div>
      </div>
    );
  }
  return (
    <iframe src={src} title={title} className="w-full rounded-lg border border-slate-200 bg-slate-50" style={{ height }} referrerPolicy="no-referrer" />
  );
}
