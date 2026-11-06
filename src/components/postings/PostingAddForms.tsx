"use client";
/**
 * 공고 직접 추가 입력: AI 엔진이 있으면 공고 원문 붙여넣기(→ AI가 정리해 추가 — 링크 없는 본문 붙여넣기 가져오기 작업)가 기본이고
 * 아래에 펼쳐 쓰는 직접 입력 폼, 없으면 직접 입력 폼만. 공고 보관함(PostingsView)의 '직접 추가'와 공고 찾기(ExploreView)의 '공고 추가'가 같이 쓴다.
 * 가져오기 작업의 시작·상태는 부모(usePostingImports)가 맡는다. 직접 입력으로 저장하면 내 보관함의 공고 상세로 이동한다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import type { StartImportOptions, StartImportResult } from "./import-jobs";
import { PasteImportForm } from "./PasteImportForm";
import { PostingForm } from "./PostingForm";

export function PostingAddForms({
  aiAvailable,
  start,
  onPasteStarted,
  onCancel,
}: {
  aiAvailable: boolean;
  start: (url: string, opts?: StartImportOptions) => Promise<StartImportResult>;
  /** 원문 붙여넣기 작업을 시작했다(진행 상황은 부모의 가져오기 목록에 보인다). */
  onPasteStarted: () => void;
  /** 직접 입력 폼의 취소. */
  onCancel: () => void;
}) {
  const router = useRouter();
  /** 원문 붙여넣기에서 이미 보관한 공고(409)로 막힌 경우 그 공고 id. */
  const [existingId, setExistingId] = useState<string | null>(null);

  const manualForm = (
    <PostingForm
      aiAvailable={aiAvailable}
      onCancel={onCancel}
      onSaved={(p, opts) => router.push(`/app/postings/${p.id}${opts.structure ? "?structure=1" : ""}`)}
    />
  );
  if (!aiAvailable) return manualForm;

  return (
    <>
      <PasteImportForm
        title="공고 원문 붙여넣기 → AI가 자동으로 정리해 추가"
        intro="공고 페이지·문서·메일 등에서 공고 내용 전체를 복사해 붙여넣고 'AI로 추가하기'를 누르세요. 회사·직무·마감일·근무지와 주요 업무·자격 요건·우대 사항·복지·전형 절차를 AI가 채워 공고를 만듭니다. 저장된 공고는 상세 화면에서 고칠 수 있습니다."
        submitLabel="AI로 추가하기"
        textLabel="공고 원문 붙여넣기"
        textFirst
        rows={10}
        className="border-indigo-200 bg-indigo-50/30 p-4"
        onSubmit={async (url, pageText) => {
          const result = await start(url, { pageText });
          if (!result.ok) {
            setExistingId(result.error.existingId ?? null);
            return result.error.error;
          }
          setExistingId(null);
          onPasteStarted();
          return null;
        }}
      />
      {existingId && (
        <Link href={`/app/postings/${existingId}`} className="mt-2 inline-block text-sm font-medium text-indigo-700 hover:underline">
          기존 공고 열기 →
        </Link>
      )}
      <details className="group mt-4 rounded-lg border border-slate-200">
        <summary className="cursor-pointer px-4 py-3 text-sm font-medium text-slate-700 hover:text-slate-900">직접 입력(항목을 하나씩 적기)</summary>
        <div className="border-t border-slate-200 p-4">{manualForm}</div>
      </details>
    </>
  );
}
