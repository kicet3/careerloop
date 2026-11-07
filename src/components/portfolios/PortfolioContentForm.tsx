"use client";

import { useState } from "react";
import { FileDrop, formatsLabel } from "@/components/app/FileDrop";
import { SensitiveInfoNotice } from "@/components/app/SensitiveInfoNotice";
import { SegmentedTabs } from "@/components/app/Tabs";
import { inputClass, textareaClass } from "@/components/resumes/styles";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import {
  MAX_PORTFOLIO_DESCRIPTION_CHARS,
  MAX_PORTFOLIO_TITLE_CHARS,
  MAX_PORTFOLIO_URL_CHARS,
  PORTFOLIO_UPLOAD_ACCEPT,
  type PortfolioUploadConfig,
} from "@/lib/domain/portfolios";
import { formatMb } from "@/lib/ingest/upload-limits";
import { NETWORK_ERROR, readError } from "./api";

type Mode = "file" | "url";

const FORMATS_LABEL = formatsLabel(PORTFOLIO_UPLOAD_ACCEPT);

/** 서명된 주소로 R2에 바로 올린다(진행률 표시). 실패하면 사용자 문구로 던진다. */
function putToStorage(url: string, headers: Record<string, string>, file: File, onProgress: (pct: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [k, v] of Object.entries(headers)) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`파일을 저장소에 올리지 못했습니다(${xhr.status}). 잠시 후 다시 시도해 주세요.`));
    xhr.onerror = () => reject(new Error("파일을 저장소에 올리지 못했습니다. 네트워크 상태를 확인하고 다시 시도해 주세요."));
    xhr.send(file);
  });
}

/**
 * 포트폴리오 내용 올리기 폼: 파일(원본을 그대로 보관해 화면에 보여 주고, AI용 글을 뽑아 둔다) 또는 링크(주소만 저장).
 * 큰 파일(upload.directMaxBytes 초과)은 서명된 주소를 받아 저장소(R2)에 바로 올린 뒤 같은 endpoint에 { uploadId, fileName }으로 마무리한다.
 * - withMeta: 이름·설명 칸도 보인다(새로 만들 때). 내용만 바꿀 때는 끈다.
 * - endpoint·method: POST /api/portfolios(새로), PUT /api/portfolios/[id](내용 바꾸기), PUT /api/resumes/[id]/portfolio(이력서에서 바로 올리고 붙이기).
 * 성공하면 응답 JSON과 서버 경고를 onDone으로 넘긴다.
 */
export function PortfolioContentForm({
  endpoint,
  method,
  upload,
  withMeta,
  submitLabel,
  initialMode = "file",
  showModeTabs = true,
  onDone,
  onCancel,
}: {
  endpoint: string;
  method: "POST" | "PUT";
  /** 서버가 정한 업로드 설정(파일 상한·바로 보내는 상한·R2 바로 올리기 가능 여부). */
  upload: PortfolioUploadConfig;
  withMeta: boolean;
  submitLabel: string;
  initialMode?: Mode;
  /** false면 파일·링크 고르기 탭을 감춘다(바깥에서 방식을 고를 때 — 새 포트폴리오 패널). */
  showModeTabs?: boolean;
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
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const maxBytes = upload.maxBytes;

  /** 큰 파일: 서명 주소 받기 → 저장소에 PUT → 마무리 요청. 서명 단계 실패는 그 응답을 그대로 돌려준다. */
  async function sendStaged(f: File): Promise<Response> {
    const init = await fetch("/api/portfolios/uploads", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileName: f.name, size: f.size }),
    });
    if (!init.ok) return init;
    const { uploadId, url, headers } = (await init.json()) as { uploadId: string; url: string; headers: Record<string, string> };
    setProgress(0);
    await putToStorage(url, headers, f, setProgress);
    const body: Record<string, string> = { uploadId, fileName: f.name };
    if (withMeta && title.trim()) body.title = title.trim();
    if (withMeta && description.trim()) body.description = description.trim();
    return fetch(endpoint, { method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }

  async function submit() {
    setError(null);
    let init: RequestInit | null = null;
    let staged: File | null = null;
    if (mode === "file") {
      if (!file) {
        setError(fileError ?? "올릴 파일을 골라 주세요.");
        return;
      }
      if (file.size > upload.directMaxBytes && upload.presigned) {
        staged = file;
      } else {
        const fd = new FormData();
        fd.set("file", file);
        if (withMeta && title.trim()) fd.set("title", title.trim());
        if (withMeta && description.trim()) fd.set("description", description.trim());
        init = { method, body: fd };
      }
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
      const res = staged ? await sendStaged(staged) : await fetch(endpoint, init!);
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
    } catch (err) {
      setError(err instanceof Error && /저장소/.test(err.message) ? err.message : NETWORK_ERROR);
    } finally {
      setBusy(false);
      setProgress(null);
    }
  }

  return (
    <div className="space-y-3">
      {showModeTabs && (
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
      )}
      {mode === "file" ? (
        <>
          <SensitiveInfoNotice />
          <FileDrop
            file={file}
            maxBytes={maxBytes}
            accept={PORTFOLIO_UPLOAD_ACCEPT}
            label="포트폴리오 파일을 끌어다 놓거나 눌러서 선택"
            hint={`${FORMATS_LABEL}, ${formatMb(maxBytes)} 이하. 원본 파일을 그대로 보관해 화면에 보여 주고, 면접 질문·진단에는 파일에서 뽑은 글을 씁니다(이미지는 글을 뽑지 않습니다).`}
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
      {progress !== null && (
        <p className="text-xs text-slate-500" role="status">
          파일 올리는 중 {progress}%{progress >= 100 ? " · 확인하는 중…" : ""}
        </p>
      )}
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
