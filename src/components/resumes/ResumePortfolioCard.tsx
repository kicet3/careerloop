"use client";

import Link from "next/link";
import { useState } from "react";
import { formatDateTime } from "@/components/app/stages";
import { SegmentedTabs } from "@/components/app/Tabs";
import { NETWORK_ERROR, readError } from "@/components/portfolios/api";
import { PortfolioContentForm } from "@/components/portfolios/PortfolioContentForm";
import { SourceLink } from "@/components/postings/SourceLink";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import {
  PORTFOLIO_KIND_LABELS,
  portfolioReadable,
  portfolioSourceLabel,
  toPortfolioPickOption,
  type PortfolioInfo,
  type PortfolioPickOption,
} from "@/lib/domain/portfolios";
import type { ResumePortfolioInfo } from "@/lib/domain/resumes";
import type { ResumeMeta } from "@/lib/resumes/types";
import { inputClass } from "./styles";

type Mode = "library" | "new";

/**
 * 이력서 첨부 포트폴리오(이력서당 하나): 포트폴리오 보관함에서 고르거나, 여기서 바로 파일·링크를 올려(보관함에 추가되고) 붙인다.
 * 떼도 보관함의 포트폴리오는 남는다. 면접 연습 질문과 '이 이력서로 진단'에 함께 쓰인다.
 */
export function ResumePortfolioCard({
  resumeId,
  portfolio,
  library: initialLibrary,
  maxBytes,
  onChange,
}: {
  resumeId: string;
  portfolio: ResumePortfolioInfo | null;
  /** 내 포트폴리오 보관함(최근 수정 순). */
  library: PortfolioPickOption[];
  /** 파일 하나 상한(바이트, 서버가 정한 값과 4MB 중 작은 값). */
  maxBytes: number;
  onChange: (resume: ResumeMeta) => void;
}) {
  const [library, setLibrary] = useState(initialLibrary);
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<Mode>(initialLibrary.length > 0 ? "library" : "new");
  const [picked, setPicked] = useState("");
  const [busy, setBusy] = useState<"attach" | "detach" | "preview" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [preview, setPreview] = useState<string | null>(null);

  function startEdit() {
    setEditing(true);
    setError(null);
    setNotice(null);
    setWarnings([]);
    setPicked(library.find((p) => p.id !== portfolio?.id)?.id ?? "");
    setMode(library.some((p) => p.id !== portfolio?.id) ? "library" : "new");
  }

  function attached(resume: ResumeMeta, message: string) {
    onChange(resume);
    setPreview(null);
    setEditing(false);
    setNotice(message);
  }

  async function attach() {
    if (!picked) {
      setError("붙일 포트폴리오를 골라 주세요.");
      return;
    }
    setBusy("attach");
    setError(null);
    try {
      const res = await fetch(`/api/resumes/${resumeId}/portfolio`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ portfolioId: picked }),
      });
      if (!res.ok) {
        if (res.status === 404) setLibrary((l) => l.filter((p) => p.id !== picked));
        setError(await readError(res, "포트폴리오를 붙이지 못했습니다."));
        return;
      }
      const data = (await res.json()) as { resume: ResumeMeta };
      setWarnings([]);
      attached(data.resume, portfolio ? "포트폴리오를 바꿨습니다." : "포트폴리오를 붙였습니다.");
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function detach() {
    if (!window.confirm("이 이력서에서 포트폴리오를 뗄까요? 보관함의 포트폴리오는 지워지지 않습니다.")) return;
    setError(null);
    setNotice(null);
    setBusy("detach");
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
      setNotice("포트폴리오를 뗐습니다. 보관함에는 남아 있습니다.");
    } catch {
      setError(NETWORK_ERROR);
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
      setPreview(data.preview || "(저장된 글이 없습니다. 포트폴리오 화면에서 파일을 다시 올려 주세요.)");
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  const choices = library.filter((p) => p.id !== portfolio?.id);

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-slate-900">
            포트폴리오 <span className="font-normal text-slate-500">(선택 · 이력서당 하나)</span>
          </h2>
          <p className="mt-0.5 text-xs text-slate-500">
            면접 연습 질문과 &lsquo;이 이력서로 진단&rsquo;에 함께 쓰입니다.{" "}
            <Link href="/app/portfolios" className="font-medium text-indigo-700 hover:underline">
              포트폴리오 관리
            </Link>
          </p>
        </div>
        {!editing && (
          <div className="flex flex-wrap gap-1.5">
            <Button size="sm" variant="secondary" onClick={startEdit} disabled={busy !== null}>
              {portfolio ? "바꾸기" : "포트폴리오 붙이기"}
            </Button>
            {portfolio && (
              <Button size="sm" variant="ghost" onClick={detach} loading={busy === "detach"} disabled={busy !== null}>
                떼기
              </Button>
            )}
          </div>
        )}
      </div>

      {portfolio && !editing && (
        <div className="mt-3 space-y-2 text-sm">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone="info">{PORTFOLIO_KIND_LABELS[portfolio.kind]}</Badge>
            <Link href={`/app/portfolios/${portfolio.id}`} className="min-w-0 truncate font-medium text-slate-900 hover:text-indigo-700 hover:underline">
              {portfolio.title}
            </Link>
            {portfolio.kind === "file" ? (
              <>
                <span className="min-w-0 truncate text-xs text-slate-500">
                  {portfolio.fileName ?? "파일"}
                  {portfolio.chars !== null && ` · ${portfolio.chars.toLocaleString("ko-KR")}자`}
                </span>
                <button
                  type="button"
                  onClick={togglePreview}
                  disabled={busy !== null}
                  className="text-xs font-medium text-indigo-700 hover:underline disabled:opacity-50"
                >
                  {preview !== null ? "미리보기 닫기" : busy === "preview" ? "불러오는 중…" : "앞부분 미리보기"}
                </button>
              </>
            ) : (
              <>
                <span className="min-w-0 truncate text-xs text-slate-500">{portfolio.url}</span>
                <SourceLink url={portfolio.url} label="열기" />
              </>
            )}
          </p>
          {portfolio.description && <p className="line-clamp-3 text-xs whitespace-pre-wrap text-slate-600">{portfolio.description}</p>}
          {!portfolioReadable(portfolio) && (
            <p className="text-xs text-slate-500">링크 내용은 AI가 열어 보지 못합니다. 포트폴리오 설명에 역할·결과를 적거나 파일로 올리면 질문·진단에 반영됩니다.</p>
          )}
          <p className="text-xs text-slate-500">
            <time dateTime={new Date(portfolio.updatedAt).toISOString()}>{formatDateTime(portfolio.updatedAt)}</time> 수정
          </p>
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
            label="포트폴리오 고르는 방식"
            value={mode}
            onChange={(m) => {
              setMode(m);
              setError(null);
            }}
            options={[
              { value: "library", label: "보관함에서 고르기" },
              { value: "new", label: "새로 올리기" },
            ]}
          />
          {mode === "library" ? (
            choices.length === 0 ? (
              <p className="rounded-lg bg-slate-50 px-3 py-2.5 text-sm text-slate-600">
                {library.length === 0 ? "보관한 포트폴리오가 없습니다." : "고를 수 있는 다른 포트폴리오가 없습니다."} &lsquo;새로 올리기&rsquo;로 올리거나{" "}
                <Link href="/app/portfolios" className="font-medium text-indigo-700 hover:underline">
                  포트폴리오
                </Link>{" "}
                화면에서 추가해 주세요.
              </p>
            ) : (
              <>
                <label className="block">
                  <span className="block text-sm font-medium text-slate-800">내 포트폴리오</span>
                  <select value={picked} onChange={(e) => setPicked(e.target.value)} className={inputClass}>
                    <option value="">포트폴리오를 고르세요</option>
                    {choices.map((p) => (
                      <option key={p.id} value={p.id}>
                        {p.title} ({PORTFOLIO_KIND_LABELS[p.kind]} · {portfolioSourceLabel(p)})
                      </option>
                    ))}
                  </select>
                </label>
                <div className="flex justify-end gap-2">
                  <Button variant="ghost" size="sm" onClick={() => setEditing(false)} disabled={busy === "attach"}>
                    취소
                  </Button>
                  <Button size="sm" onClick={attach} loading={busy === "attach"} disabled={busy !== null || !picked}>
                    {portfolio ? "바꾸기" : "붙이기"}
                  </Button>
                </div>
              </>
            )
          ) : (
            <>
              <p className="text-xs text-slate-500">올린 포트폴리오는 보관함에 추가되고 이 이력서에 붙습니다.</p>
              <PortfolioContentForm
                endpoint={`/api/resumes/${resumeId}/portfolio`}
                method="PUT"
                maxBytes={maxBytes}
                withMeta
                submitLabel="올리고 붙이기"
                onCancel={() => setEditing(false)}
                onDone={(data, w) => {
                  const d = data as { resume: ResumeMeta; portfolio?: PortfolioInfo };
                  const created = d.portfolio;
                  if (created) setLibrary((l) => [toPortfolioPickOption(created), ...l.filter((p) => p.id !== created.id)]);
                  setWarnings(w);
                  attached(d.resume, "포트폴리오를 보관함에 추가하고 붙였습니다.");
                }}
              />
            </>
          )}
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
