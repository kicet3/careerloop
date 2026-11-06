"use client";

import { useState } from "react";
import { FileDrop, UPLOAD_ACCEPT, UPLOAD_FORMATS_LABEL } from "@/components/app/FileDrop";
import { SensitiveInfoNotice } from "@/components/app/SensitiveInfoNotice";
import { SegmentedTabs } from "@/components/app/Tabs";
import { inputClass, textareaClass } from "@/components/resumes/styles";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { MAX_PORTFOLIO_DESCRIPTION_CHARS, MAX_PORTFOLIO_TITLE_CHARS, MAX_PORTFOLIO_URL_CHARS } from "@/lib/domain/portfolios";
import { formatMb } from "@/lib/ingest/upload-limits";
import { NETWORK_ERROR, readError } from "./api";

type Mode = "file" | "url";

/**
 * 포트폴리오 내용 올리기 폼: 파일(글만 뽑아 저장, 원본은 보관하지 않음) 또는 링크(주소만 저장).
 * - withMeta: 이름·설명 칸도 보인다(새로 만들 때). 내용만 바꿀 때는 끈다.
 * - endpoint·method: POST /api/portfolios(새로), PUT /api/portfolios/[id](내용 바꾸기), PUT /api/resumes/[id]/portfolio(이력서에서 바로 올리고 붙이기).
 * 성공하면 응답 JSON과 서버 경고를 onDone으로 넘긴다.
 */
export function PortfolioContentForm({
  endpoint,
  method,
  maxBytes,
  withMeta,
  submitLabel,
  initialMode = "file",
  onDone,
  onCancel,
}: {
  endpoint: string;
  method: "POST" | "PUT";
  /** 파일 하나 상한(바이트, 서버 업로드 상한과 4MB 중 작은 값). */
  maxBytes: number;
  withMeta: boolean;
  submitLabel: string;
  initialMode?: Mode;
  onDone: (data: unknown, warnings: string[]) => void;
  onCancel?: () => void;
}) {
  const [mode, setMode] = useState<Mode>(initialMode);
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [url, setUrl] = useState("");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setError(null);
    let init: RequestInit;
    if (mode === "file") {
      if (!file) {
        setError(fileError ?? "올릴 파일을 골라 주세요.");
        return;
      }
      const fd = new FormData();
      fd.set("file", file);
      if (withMeta && title.trim()) fd.set("title", title.trim());
      if (withMeta && description.trim()) fd.set("description", description.trim());
      init = { method, body: fd };
    } else {
      if (!url.trim()) {
        setError("포트폴리오 주소를 입력해 주세요.");
        return;
      }
      const body: Record<string, string> = { url: url.trim() };
      if (withMeta && title.trim()) body.title = title.trim();
      if (withMeta && description.trim()) body.description = description.trim();
      init = { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) };
    }
    setBusy(true);
    try {
      const res = await fetch(endpoint, init);
      if (!res.ok) {
        setError(await readError(res, "포트폴리오를 저장하지 못했습니다."));
        return;
      }
      const data = (await res.json()) as { warnings?: string[] };
      setFile(null);
      setUrl("");
      setTitle("");
      setDescription("");
      onDone(data, data.warnings ?? []);
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-3">
      <SegmentedTabs
        label="포트폴리오 올리는 방식"
        value={mode}
        onChange={(m) => {
          setMode(m);
          setError(null);
        }}
        options={[
          { value: "file", label: "파일 올리기" },
          { value: "url", label: "링크" },
        ]}
      />
      {mode === "file" ? (
        <>
          <SensitiveInfoNotice />
          <FileDrop
            file={file}
            maxBytes={maxBytes}
            accept={UPLOAD_ACCEPT}
            label="포트폴리오 파일을 끌어다 놓거나 눌러서 선택"
            hint={`${UPLOAD_FORMATS_LABEL}, ${formatMb(maxBytes)} 이하. 글만 뽑아 저장하고 원본 파일은 보관하지 않습니다.`}
            onChange={(f, err) => {
              setFile(f);
              setFileError(err);
            }}
          />
          {fileError && <p className="text-sm text-red-600">{fileError}</p>}
        </>
      ) : (
        <label className="block">
          <span className="block text-sm font-medium text-slate-800">포트폴리오 주소</span>
          <input
            type="url"
            inputMode="url"
            value={url}
            maxLength={MAX_PORTFOLIO_URL_CHARS}
            onChange={(e) => setUrl(e.target.value)}
            placeholder="https://"
            className={inputClass}
          />
          <span className="mt-1 block text-xs text-slate-500">
            주소만 저장합니다. AI는 링크 내용을 열어 보지 못하니{withMeta ? " 아래 설명에" : ""} 프로젝트 내용·역할·결과를 적어 두면 질문·진단에 반영됩니다.
          </span>
        </label>
      )}
      {withMeta && (
        <>
          <label className="block">
            <span className="block text-sm font-medium text-slate-800">
              이름 <span className="font-normal text-slate-400">(비우면 파일 이름·주소로)</span>
            </span>
            <input
              value={title}
              maxLength={MAX_PORTFOLIO_TITLE_CHARS}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="예: 결제 정산 시스템 개편"
              className={inputClass}
            />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-slate-800">
              설명 <span className="font-normal text-slate-400">(선택)</span>
            </span>
            <textarea
              value={description}
              maxLength={MAX_PORTFOLIO_DESCRIPTION_CHARS}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              placeholder="내 역할과 결과를 적어 두면 면접 질문·진단에 함께 쓰입니다. 예: 정산 배치를 Kotlin으로 재작성, 처리 시간 4시간 → 40분."
              className={textareaClass}
            />
            <span className="mt-1 block text-right text-xs text-slate-400">
              {description.length}/{MAX_PORTFOLIO_DESCRIPTION_CHARS}
            </span>
          </label>
        </>
      )}
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex justify-end gap-2">
        {onCancel && (
          <Button variant="ghost" size="sm" onClick={onCancel} disabled={busy}>
            취소
          </Button>
        )}
        <Button size="sm" onClick={submit} loading={busy} disabled={busy || (mode === "file" && !file)}>
          {submitLabel}
        </Button>
      </div>
    </div>
  );
}
