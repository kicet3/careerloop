"use client";
/**
 * 본문 붙여넣어 가져오기 입력: 링크로 읽을 수 없는 공고(보안 검사·봇 차단 등)를 브라우저에서 복사한 페이지 본문으로 가져온다.
 * 공고 링크(출처·중복 판별용)와 붙여넣은 본문을 받아 onSubmit에 넘긴다 — 시작·상태는 부모(usePostingImports)가 맡는다.
 * 보관함 입력줄(PostingImportBar)과 새 진단의 공고 고르기(PostingTargetPicker)가 같이 쓴다.
 */
import { useId, useState } from "react";
import { Button } from "@/components/ui/Button";
import { cn } from "@/components/ui/cn";
import { POSTING_LIMITS, POSTING_PASTE_MIN_CHARS } from "@/lib/domain/postings";
import { inputClass, textareaClass } from "./shared";

/** 화면에서 먼저 거르는 검사(서버도 같은 규칙으로 다시 검사한다). 문제가 없으면 null. */
export function pasteImportProblem(url: string, text: string): string | null {
  if (!url.trim()) return "공고 상세 페이지 주소를 입력하세요.";
  const length = text.trim().length;
  if (length < POSTING_PASTE_MIN_CHARS) {
    return `붙여넣은 내용이 너무 짧습니다. 공고 페이지 전체(Ctrl+A)를 복사해 ${POSTING_PASTE_MIN_CHARS}자 이상 붙여넣어 주세요.`;
  }
  if (length > POSTING_LIMITS.jdText) {
    return `붙여넣은 내용은 ${POSTING_LIMITS.jdText.toLocaleString("en-US")}자 이내여야 합니다. 공고 본문 부분만 복사해 주세요.`;
  }
  return null;
}

export function PasteImportForm({
  initialUrl = "",
  onSubmit,
  onCancel,
  submitLabel = "붙여넣은 내용으로 가져오기",
  className,
}: {
  initialUrl?: string;
  /** 시작에 실패하면 사용자용 문구, 성공하면 null. */
  onSubmit: (url: string, pageText: string) => Promise<string | null>;
  onCancel?: () => void;
  submitLabel?: string;
  className?: string;
}) {
  const id = useId();
  const [url, setUrl] = useState(initialUrl);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const length = text.trim().length;

  async function submit() {
    const problem = pasteImportProblem(url, text);
    setError(problem);
    if (problem) return;
    setBusy(true);
    try {
      const failure = await onSubmit(url.trim(), text);
      setError(failure);
      if (!failure) setText("");
    } finally {
      setBusy(false);
    }
  }

  return (
    // aria-live="off": 실패 행(PostingImportBar의 aria-live 목록) 안에 그려져도 입력·글자 수 변화를 화면 낭독기가 읽지 않게 한다.
    <div className={cn("rounded-lg border border-slate-200 bg-white p-3", className)} aria-live="off">
      <p className="text-sm font-medium text-slate-900">본문 붙여넣어 가져오기</p>
      <p className="mt-0.5 text-xs text-slate-500">
        브라우저에서 공고 페이지를 열고 전체 선택(Ctrl+A 또는 ⌘+A) → 복사(Ctrl+C 또는 ⌘+C)한 내용을 붙여넣으세요. 메뉴·푸터가 섞여도 AI가 공고 내용만 골라 정리합니다.
      </p>
      <label htmlFor={`${id}-url`} className="mt-2 block text-xs font-medium text-slate-700">
        공고 링크(출처)
      </label>
      <input
        id={`${id}-url`}
        type="url"
        inputMode="url"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        placeholder="https://… 공고 상세 주소"
        className={cn(inputClass, "mt-1")}
      />
      <label htmlFor={`${id}-text`} className="mt-2 block text-xs font-medium text-slate-700">
        공고 페이지 내용 붙여넣기
      </label>
      <textarea
        id={`${id}-text`}
        aria-describedby={cn(`${id}-note`, error && `${id}-error`)}
        aria-invalid={error ? true : undefined}
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={6}
        placeholder="공고 페이지에서 복사한 내용을 여기에 붙여넣으세요."
        className={cn(textareaClass, "mt-1")}
      />
      <p id={`${id}-note`} className="mt-1 text-xs text-slate-500">
        정리된 공고 내용(회사·직무·JD·마감·근무 조건)은 직접 추가한 공고처럼 &lsquo;공고 찾기&rsquo;에 공유될 수 있습니다. 붙여넣은 원문과 링크는 공유되지 않지만,
        로그인 이름·이메일 같은 개인정보가 섞이지 않게 복사해 주세요.
      </p>
      <div className="mt-1 flex items-center justify-between gap-2 text-xs text-slate-500">
        <span className={cn(length > POSTING_LIMITS.jdText && "text-red-700")}>
          {length.toLocaleString("en-US")} / {POSTING_LIMITS.jdText.toLocaleString("en-US")}자
        </span>
        <div className="flex items-center gap-2">
          {onCancel && (
            <Button type="button" variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
              닫기
            </Button>
          )}
          <Button type="button" size="sm" loading={busy} disabled={busy} onClick={() => void submit()}>
            {submitLabel}
          </Button>
        </div>
      </div>
      {error && (
        <p id={`${id}-error`} className="mt-2 text-sm text-red-700" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
