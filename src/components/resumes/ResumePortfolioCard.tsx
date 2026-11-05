"use client";

import { useState } from "react";
import { FileDrop, UPLOAD_ACCEPT, UPLOAD_FORMATS_LABEL } from "@/components/app/FileDrop";
import { SensitiveInfoNotice } from "@/components/app/SensitiveInfoNotice";
import { formatDateTime } from "@/components/app/stages";
import { SegmentedTabs } from "@/components/app/Tabs";
import { SourceLink } from "@/components/postings/SourceLink";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { ResumePortfolioInfo } from "@/lib/domain/resumes";
import { formatMb } from "@/lib/ingest/upload-limits";
import type { ResumeMeta } from "@/lib/resumes/types";
import { inputClass } from "./styles";

type Mode = "file" | "url";

async function readError(res: Response, fallback: string): Promise<string> {
  const data = (await res.json().catch(() => null)) as { error?: string } | null;
  if (data?.error) return data.error;
  if (res.status === 413) return "파일이 너무 큽니다.";
  if (res.status === 429) return "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.";
  return fallback;
}

/**
 * 이력서 첨부 포트폴리오(이력서당 하나). 파일은 글만 뽑아 저장하고(원본은 보관하지 않음), 링크는 주소만 저장한다.
 * 면접 연습 질문과 '이 이력서로 진단'에 함께 쓰인다.
 */
export function ResumePortfolioCard({
  resumeId,
  portfolio,
  maxBytes,
  onChange,
}: {
  resumeId: string;
  portfolio: ResumePortfolioInfo | null;
  /** 파일 하나 상한(바이트, 서버가 정한 값과 4MB 중 작은 값). */
  maxBytes: number;
  onChange: (resume: ResumeMeta) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Mode>(portfolio?.kind === "url" ? "url" : "file");
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [url, setUrl] = useState(portfolio?.url ?? "");
  const [busy, setBusy] = useState<"save" | "remove" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  function startEdit() {
    setEditing(true);
    setError(null);
    setNotice(null);
    setFile(null);
    setFileError(null);
    setUrl(portfolio?.url ?? "");
  }

  async function save() {
    setError(null);
    setNotice(null);
    setWarnings([]);
    let res: Response;
    setBusy("save");
    try {
      if (mode === "file") {
        if (!file) {
          setError(fileError ?? "올릴 파일을 골라 주세요.");
          return;
        }
        const fd = new FormData();
        fd.set("file", file);
        res = await fetch(`/api/resumes/${resumeId}/portfolio`, { method: "PUT", body: fd });
      } else {
        if (!url.trim()) {
          setError("포트폴리오 주소를 입력해 주세요.");
          return;
        }
        res = await fetch(`/api/resumes/${resumeId}/portfolio`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ url: url.trim() }),
        });
      }
      if (!res.ok) {
        setError(await readError(res, "포트폴리오를 저장하지 못했습니다."));
        return;
      }
      const data = (await res.json()) as { resume: ResumeMeta; warnings?: string[] };
      onChange(data.resume);
      setWarnings(data.warnings ?? []);
      setPreview(null);
      setEditing(false);
      setNotice(portfolio ? "포트폴리오를 바꿨습니다." : "포트폴리오를 붙였습니다.");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    if (!window.confirm("첨부한 포트폴리오를 뗄까요? 저장해 둔 글도 함께 지워집니다.")) return;
    setError(null);
    setNotice(null);
    setBusy("remove");
    try {
      const res = await fetch(`/api/resumes/${resumeId}/portfolio`, { method: "DELETE" });
      if (!res.ok) {
        setError(await readError(res, "포트폴리오를 떼지 못했습니다."));
        return;
      }
      const data = (await res.json()) as { resume: ResumeMeta };
      onChange(data.resume);
      setPreview(null);
      setWarnings([]);
      setNotice("포트폴리오를 뗐습니다.");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  async function togglePreview() {
    if (preview !== null) {
      setPreview(null);
      return;
    }
    setBusy("preview");
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/portfolio`);
      if (!res.ok) {
        setError(await readError(res, "미리보기를 불러오지 못했습니다."));
        return;
      }
      const data = (await res.json()) as { preview: string };
      setPreview(data.preview || "(저장된 글이 없습니다. 파일을 다시 올려 주세요.)");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            포트폴리오 <span className="font-normal text-slate-500">(선택 · 이력서당 하나)</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">면접 연습 질문과 &lsquo;이 이력서로 진단&rsquo;에 함께 쓰입니다.</p>
        </div>
        {!editing && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={startEdit} disabled={busy !== null}>
              {portfolio ? "바꾸기" : "포트폴리오 붙이기"}
            </Button>
            {portfolio && (
              <Button size="sm" variant="ghost" onClick={remove} loading={busy === "remove"} disabled={busy !== null}>
                떼기
              </Button>
            )}
          </div>
        )}
      </div>

      {portfolio && !editing && (
        <div className="mt-3 space-y-2 text-sm">
          {portfolio.kind === "file" ? (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="info">파일</Badge>
              <span className="min-w-0 truncate font-medium text-slate-900">{portfolio.fileName ?? "포트폴리오"}</span>
              {portfolio.chars !== null && <span className="text-xs text-slate-500">{portfolio.chars.toLocaleString("ko-KR")}자</span>}
              <button
                type="button"
                onClick={togglePreview}
                disabled={busy !== null}
                className="text-xs font-medium text-indigo-700 hover:underline disabled:opacity-50"
              >
                {preview !== null ? "미리보기 닫기" : busy === "preview" ? "불러오는 중…" : "앞부분 미리보기"}
              </button>
            </p>
          ) : (
            <p className="flex flex-wrap items-center gap-2">
              <Badge tone="info">링크</Badge>
              <span className="min-w-0 truncate text-slate-700">{portfolio.url}</span>
              <SourceLink url={portfolio.url} label="열기" />
            </p>
          )}
          {portfolio.kind === "url" && (
            <p className="text-xs text-slate-500">링크 내용은 AI가 열어 보지 못합니다. 질문·진단에 반영하려면 파일로 올려 주세요.</p>
          )}
          {portfolio.updatedAt && (
            <p className="text-xs text-slate-500">
              <time dateTime={new Date(portfolio.updatedAt).toISOString()}>{formatDateTime(portfolio.updatedAt)}</time>에 붙임
            </p>
          )}
          {preview !== null && (
            <pre className="max-h-60 overflow-y-auto rounded-lg border border-slate-200 bg-slate-50 p-3 text-xs leading-relaxed whitespace-pre-wrap text-slate-700">
              {preview}
            </pre>
          )}
        </div>
      )}

      {!portfolio && !editing && <p className="mt-3 text-sm text-slate-500">붙인 포트폴리오가 없습니다.</p>}

      {editing && (
        <div className="mt-4 space-y-3">
          <SegmentedTabs
            label="포트폴리오 첨부 방식"
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
                maxLength={2048}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://"
                className={inputClass}
              />
              <span className="mt-1 block text-xs text-slate-500">주소만 저장합니다. AI는 링크 내용을 열어 보지 못합니다.</span>
            </label>
          )}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy === "save"}>
              취소
            </Button>
            <Button size="sm" onClick={save} loading={busy === "save"} disabled={busy !== null || (mode === "file" && !file)}>
              {portfolio ? "바꾸기" : "붙이기"}
            </Button>
          </div>
        </div>
      )}

      {error && (
        <Alert tone="error" className="mt-3">
          {error}
        </Alert>
      )}
      {notice && !error && (
        <Alert tone="info" className="mt-3">
          {notice}
        </Alert>
      )}
      {warnings.length > 0 && (
        <Alert tone="warning" className="mt-3">
          <ul className="list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
    </Card>
  );
}
