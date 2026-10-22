"use client";

import { useId, useRef, useState } from "react";
import { cn } from "@/components/ui/cn";

export const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 확장자·크기 검사. 문제가 없으면 null. */
export function validateUpload(file: File, accept: string[]): string | null {
  const ext = file.name.toLowerCase().match(/\.[a-z0-9]+$/)?.[0] ?? "";
  if (!accept.includes(ext)) return `${accept.join(", ")} 파일만 올릴 수 있습니다.`;
  if (file.size > MAX_UPLOAD_BYTES) return "파일은 10MB 이하만 올릴 수 있습니다.";
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
}: {
  file: File | null;
  onChange: (file: File | null, error: string | null) => void;
  accept: string[];
  label: string;
  hint?: string;
}) {
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  function pick(f: File | undefined | null) {
    if (!f) return;
    const error = validateUpload(f, accept);
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
        {hint ?? `${accept.join(" · ")} · 10MB 이하`}
      </span>
      <input
        ref={inputRef}
        id={inputId}
        type="file"
        accept={accept.join(",")}
        className="sr-only"
        onChange={(e) => pick(e.target.files?.[0])}
      />
    </label>
  );
}
