"use client";

import { useId, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";
import { formatMb, SELF_HOSTED_UPLOAD_LIMITS } from "@/lib/ingest/upload-limits";

/** 이력서·포트폴리오·JD 업로드에서 받는 확장자(서버 src/lib/ingest/extract.ts UPLOAD_EXTENSIONS와 같게 유지). */
export const UPLOAD_ACCEPT = [".pdf", ".docx", ".hwp", ".hwpx", ".html", ".htm", ".txt", ".md"];
/** 안내 문구용 형식 목록 */
export const UPLOAD_FORMATS_LABEL = formatsLabel(UPLOAD_ACCEPT);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** [".pdf", ".htm", ".html"] → "PDF · HTML"(.htm은 .html과 같은 형식이라 뺀다). */
export function formatsLabel(accept: string[]): string {
  return accept
    .filter((ext) => ext !== ".htm" || !accept.includes(".html"))
    .map((ext) => ext.slice(1).toUpperCase())
    .join(" · ");
}

/**
 * 확장자·크기 검사. 문제가 없으면 null. maxBytes는 서버가 정한 파일당 상한(uploadLimitsFor).
 * typeError: 확장자가 맞지 않을 때 쓸 문구(비우면 기본 문구 — 포트폴리오는 'PDF만').
 */
export function validateUpload(
  file: File,
  accept: string[],
  maxBytes: number = SELF_HOSTED_UPLOAD_LIMITS.perFileBytes,
  typeError?: string,
): string | null {
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (!accept.includes(ext)) {
    if (typeError) return typeError;
    if (ext === ".doc") return "DOC 파일은 읽지 못합니다. DOCX나 PDF로 저장해 올려 주세요.";
    return `${accept.join(", ")} 파일만 올릴 수 있습니다.`;
  }
  if (file.size > maxBytes) return `파일은 ${formatMb(maxBytes)} 이하만 올릴 수 있습니다.`;
  if (file.size === 0) return "빈 파일입니다.";
  return null;
}

/** 끌어다 놓기 + 클릭 업로드. 선택한 파일은 부모가 상태로 들고 있는다. */
export function FileDrop({
  file,
  onChange,
  accept,
  label,
  hint,
  maxBytes = SELF_HOSTED_UPLOAD_LIMITS.perFileBytes,
  acceptAttr,
  typeError,
}: {
  file: File | null;
  onChange: (file: File | null, error: string | null) => void;
  accept: string[];
  label: string;
  hint?: string;
  /** 파일당 상한(바이트). */
  maxBytes?: number;
  /** 파일 고르기 창의 accept 값(비우면 accept 확장자를 잇는다). */
  acceptAttr?: string;
  /** 확장자가 맞지 않을 때 문구(validateUpload). */
  typeError?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function pick(f: File | undefined | null) {
    if (!f) return;
    const error = validateUpload(f, accept, maxBytes, typeError);
    onChange(error ? null : f, error);
  }

  if (file) {
    return (
      <div className="flex items-center justify-between gap-3 rounded-lg border border-slate-200 bg-slate-50 px-4 py-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-slate-900">{file.name}</p>
          <p className="text-xs text-slate-500">{formatBytes(file.size)}</p>
        </div>
        <button
          type="button"
          onClick={() => {
            onChange(null, null);
            if (inputRef.current) inputRef.current.value = "";
          }}
          className="shrink-0 rounded-md px-2 py-1 text-sm text-slate-600 hover:bg-slate-200"
        >
          다른 파일
        </button>
      </div>
    );
  }

  return (
    <label
      htmlFor={inputId}
      onDragOver={(e) => {
        e.preventDefault();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        pick(e.dataTransfer.files?.[0]);
      }}
      className={cn(
        "flex cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border-2 border-dashed px-4 py-8 text-center transition-colors",
        dragging ? "border-indigo-500 bg-indigo-50" : "border-slate-300 bg-white hover:border-indigo-400",
      )}
    >
      <span className="text-sm font-medium text-slate-800">{label}</span>
      <span className="text-xs text-slate-500">
        {hint ?? `${formatsLabel(accept)} · ${formatMb(maxBytes)} 이하`}
      </span>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={acceptAttr ?? accept.join(",")}
        className="sr-only"
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </label>
  );
}
