"use client";
/**
 * 이력서·포트폴리오로 그래프 채우기 폼(그래프 만들기 탭). 파일(FileDrop) 또는 붙여넣은 글, 문서 종류를 multipart로 보낸다.
 * 원본 파일은 서버에 저장하지 않고 읽어 낸 글만 대화에 남는다. 보내기 이후는 그래프 채팅의 폴링 흐름을 그대로 탄다.
 */
import { useState } from "react";
import { FileDrop, UPLOAD_ACCEPT, UPLOAD_FORMATS_LABEL } from "@/components/app/FileDrop";
import { SensitiveInfoNotice } from "@/components/app/SensitiveInfoNotice";
import { Alert, Button } from "@/components/ui";
import { DOC_KINDS, type DocKind, MAX_IMPORT_CHARS } from "@/lib/domain/chat";
import { formatMb, type UploadLimits } from "@/lib/ingest/upload-limits";
import { textareaClass } from "./styles";

const DOC_KIND_LABEL: Record<DocKind, string> = { resume: "이력서", portfolio: "포트폴리오" };
/** 붙여넣기 하한(서버 MIN_TEXT_LENGTH와 같다). */
const MIN_PASTE_CHARS = 50;

export function GraphImportForm({
  uploadLimits,
  disabled,
  onSubmit,
  onCancel,
}: {
  uploadLimits: UploadLimits;
  disabled: boolean;
  onSubmit: (form: FormData, label: string) => Promise<void>;
  onCancel: () => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [text, setText] = useState("");
  const [docKind, setDocKind] = useState<DocKind>("resume");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  const pasted = text.trim();
  const ready = file !== null || pasted.length >= MIN_PASTE_CHARS;

  async function submit() {
    if (!ready || sending) return;
    const form = new FormData();
    form.append("docKind", docKind);
    if (file) form.append("file", file);
    else form.append("text", pasted);
    setSending(true);
    setError(null);
    try {
      await onSubmit(form, file?.name ?? DOC_KIND_LABEL[docKind]);
      setFile(null);
      setText("");
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSending(false);
    }
  }

  return (
    <form
      className="space-y-3 rounded-lg border border-indigo-100 bg-indigo-50/40 p-3"
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
    >
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="font-medium text-slate-800">이력서·포트폴리오로 채우기</span>
        <div role="radiogroup" aria-label="문서 종류" className="inline-flex gap-3">
          {DOC_KINDS.map((k) => (
            <label key={k} className="inline-flex items-center gap-1 text-slate-700">
              <input type="radio" name="graph-import-kind" value={k} checked={docKind === k} onChange={() => setDocKind(k)} />
              {DOC_KIND_LABEL[k]}
            </label>
          ))}
        </div>
      </div>
      <SensitiveInfoNotice />
      <FileDrop
        file={file}
        onChange={(f, err) => {
          setFile(err ? null : f);
          setError(err);
        }}
        accept={UPLOAD_ACCEPT}
        label={`${DOC_KIND_LABEL[docKind]} 파일`}
        hint={`${UPLOAD_FORMATS_LABEL} · ${formatMb(uploadLimits.perFileBytes)} 이하`}
        maxBytes={uploadLimits.perFileBytes}
      />
      {!file && (
        <div>
          <label htmlFor="graph-import-text" className="text-sm text-slate-600">
            또는 내용을 붙여넣기
          </label>
          <textarea
            id="graph-import-text"
            rows={4}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="경력·프로젝트·성과·기술·학력이 담긴 글을 붙여넣어 주세요"
            className={textareaClass}
          />
          <p className="mt-1 text-right text-xs text-slate-400">
            {pasted.length.toLocaleString()}자 {pasted.length > MAX_IMPORT_CHARS && `(앞 ${MAX_IMPORT_CHARS.toLocaleString()}자만 읽습니다)`}
          </p>
        </div>
      )}
      <p className="text-xs text-slate-500">
        원본 파일은 저장하지 않고, 읽어 낸 글만 이 대화에 남습니다. AI가 문서에 적힌 사실만으로 변경안을 만들고, 확인한 것만 그래프에 적용됩니다.
      </p>
      {error && <Alert tone="error">{error}</Alert>}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" loading={sending} disabled={disabled || !ready}>
          변경안 만들기
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onCancel} disabled={sending}>
          닫기
        </Button>
      </div>
    </form>
  );
}
