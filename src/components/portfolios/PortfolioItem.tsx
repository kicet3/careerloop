"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { formatDateTime } from "@/components/app/stages";
import { SourceLink } from "@/components/postings/SourceLink";
import { inputClass, textareaClass } from "@/components/resumes/styles";
import { Alert } from "@/components/ui/Alert";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { portfolioOpenItems } from "@/lib/domain/graph-portfolio";
import {
  MAX_PORTFOLIO_DESCRIPTION_CHARS,
  MAX_PORTFOLIO_TITLE_CHARS,
  PORTFOLIO_KIND_LABELS,
  portfolioReadable,
  portfolioSourceLabel,
  portfolioUnreadableHint,
  type PortfolioListItem,
  type PortfolioUploadConfig,
} from "@/lib/domain/portfolios";
import { NETWORK_ERROR, readError } from "./api";
import { PortfolioContentForm } from "./PortfolioContentForm";
import { PortfolioOriginalViewer } from "./PortfolioOriginalViewer";

type Panel = "meta" | "content" | "original" | null;

/**
 * 포트폴리오 하나: 이름·종류·파일 이름/주소·글자 수·수정 시각·첨부한 이력서 + 이름·설명 고치기, 내용 바꾸기, 지우기.
 * variant 'card'는 보관함 목록 카드(이름이 상세 링크, 원본 파일을 펼쳐 볼 수 있다), 'detail'은 상세 화면 머리(지우면 목록으로 간다 —
 * 원본 보기는 상세 화면이 따로 그린다).
 * 바꾼 뒤에는 서버 화면을 새로 그린다(router.refresh — 목록·미리보기가 함께 갱신된다).
 */
export function PortfolioItem({
  portfolio: p,
  upload,
  variant,
  shared = false,
}: {
  portfolio: PortfolioListItem;
  upload: PortfolioUploadConfig;
  variant: "card" | "detail";
  /** 공개 링크로 공개 중('공개 중' 표시). */
  shared?: boolean;
}) {
  const router = useRouter();
  const [panel, setPanel] = useState<Panel>(null);
  const [title, setTitle] = useState(p.title);
  const [description, setDescription] = useState(p.description ?? "");
  const [busy, setBusy] = useState<"meta" | "delete" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);

  function open(next: Panel) {
    setPanel((cur) => (cur === next ? null : next));
    setError(null);
    setNotice(null);
    setTitle(p.title);
    setDescription(p.description ?? "");
  }

  async function saveMeta() {
    if (!title.trim()) {
      setError("이름을 입력해 주세요.");
      return;
    }
    setBusy("meta");
    setError(null);
    try {
      const res = await fetch(`/api/portfolios/${p.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title: title.trim(), description: description.trim() || null }),
      });
      if (!res.ok) {
        setError(await readError(res, "저장하지 못했습니다."));
        return;
      }
      setPanel(null);
      setNotice("이름·설명을 저장했습니다.");
      router.refresh();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setBusy(null);
    }
  }

  async function remove() {
    const used = p.resumes.length > 0 ? `\n이 포트폴리오를 붙인 이력서 ${p.resumes.length}개에서도 떨어집니다(이력서는 남습니다).` : "";
    const publicNote = shared ? "\n공개 중인 링크도 함께 사라집니다." : "";
    if (!window.confirm(`'${p.title}' 포트폴리오를 지울까요? 보관한 원본 파일과 저장해 둔 글도 함께 지워집니다.${used}${publicNote}`)) return;
    setBusy("delete");
    setError(null);
    try {
      const res = await fetch(`/api/portfolios/${p.id}`, { method: "DELETE" });
      if (!res.ok && res.status !== 404) {
        setError(await readError(res, "지우지 못했습니다."));
        setBusy(null);
        return;
      }
      if (variant === "detail") router.push("/app/portfolios");
      else router.refresh();
    } catch {
      setError(NETWORK_ERROR);
      setBusy(null);
    }
  }

  const heading =
    variant === "card" ? (
      <h2 className="min-w-0 truncate text-base font-semibold text-slate-900">
        <Link href={`/app/portfolios/${p.id}`} className="hover:text-indigo-700 hover:underline">
          {p.title}
        </Link>
      </h2>
    ) : (
      <h1 className="min-w-0 text-2xl font-bold tracking-tight break-words text-slate-900">{p.title}</h1>
    );

  return (
    <Card className="p-4 sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1 space-y-1.5">
          <div className="flex min-w-0 items-center gap-2">
            <Badge tone={p.kind === "graph" ? "accent" : "info"}>{PORTFOLIO_KIND_LABELS[p.kind]}</Badge>
            {heading}
            {shared && (
              <Badge tone="positive" className="shrink-0">
                공개 중
              </Badge>
            )}
          </div>
          <p className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-sm text-slate-600">
            {p.kind === "graph" ? (
              <>
                <span className="min-w-0 truncate">
                  {portfolioSourceLabel(p)}
                  {p.graphSource && p.graphSource.projectIds.length > 0 && ` · 프로젝트 ${p.graphSource.projectIds.length}개`}
                </span>
                {p.chars !== null && <span className="text-xs text-slate-500">{p.chars.toLocaleString("ko-KR")}자</span>}
                {portfolioOpenItems(p.graphSource) > 0 && (
                  <span className="text-xs text-amber-700">채워야 할 자리 {portfolioOpenItems(p.graphSource)}개</span>
                )}
              </>
            ) : p.kind === "file" ? (
              <>
                <span className="min-w-0 truncate">{p.fileName ?? "파일"}</span>
                {p.chars !== null && p.chars > 0 && <span className="text-xs text-slate-500">{p.chars.toLocaleString("ko-KR")}자</span>}
                {p.original ? (
                  <span className="text-xs text-emerald-700">원본 보관</span>
                ) : (
                  <span className="text-xs text-slate-500" title="원본 보관 기능 전에 올린 파일입니다. ‘내용 바꾸기’로 다시 올리면 원본을 그대로 볼 수 있습니다.">
                    원본 없음(예전 업로드)
                  </span>
                )}
              </>
            ) : (
              <>
                <span className="min-w-0 truncate">{p.url}</span>
                <SourceLink url={p.url} label="열기" />
              </>
            )}
            <span className="text-xs text-slate-500">
              · <time dateTime={new Date(p.updatedAt).toISOString()}>{formatDateTime(p.updatedAt)}</time> 수정
            </span>
          </p>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => open("meta")} disabled={busy !== null}>
            이름·설명
          </Button>
          {variant === "card" && p.kind === "file" && p.original && (
            <Button size="sm" variant="secondary" onClick={() => open("original")} disabled={busy !== null} aria-expanded={panel === "original"}>
              {panel === "original" ? "원본 접기" : "원본 보기"}
            </Button>
          )}
          {p.kind === "graph" ? (
            variant === "card" && (
              <Link href={`/app/portfolios/${p.id}`} className={buttonClass("secondary", "sm")}>
                보기·고치기
              </Link>
            )
          ) : (
            <Button size="sm" variant="secondary" onClick={() => open("content")} disabled={busy !== null}>
              내용 바꾸기
            </Button>
          )}
          <Button size="sm" variant="danger" onClick={remove} loading={busy === "delete"} disabled={busy !== null}>
            지우기
          </Button>
        </div>
      </div>

      {p.description && panel !== "meta" && (
        <p className={`mt-3 text-sm whitespace-pre-wrap text-slate-700 ${variant === "card" ? "line-clamp-3" : ""}`}>{p.description}</p>
      )}
      {!portfolioReadable(p) && <p className="mt-2 text-xs text-amber-700">{portfolioUnreadableHint(p)}</p>}

      {panel === "original" && p.original && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <PortfolioOriginalViewer portfolioId={p.id} fileName={p.fileName} original={p.original} version={p.updatedAt} height="60vh" />
        </div>
      )}

      <div className="mt-3 text-sm">
        {p.resumes.length === 0 ? (
          <p className="text-xs text-slate-500">아직 붙인 이력서가 없습니다. 이력서 편집 화면의 포트폴리오 칸에서 고를 수 있습니다.</p>
        ) : (
          <p className="flex flex-wrap items-center gap-1.5 text-xs text-slate-600">
            <span>붙인 이력서</span>
            {p.resumes.map((r) => (
              <Link
                key={r.id}
                href={`/app/resumes/${r.id}`}
                className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-slate-700 hover:border-indigo-300 hover:text-indigo-700"
              >
                {r.kind === "general" ? `[공용] ${r.title}` : r.title}
              </Link>
            ))}
          </p>
        )}
      </div>

      {panel === "meta" && (
        <div className="mt-4 space-y-3 border-t border-slate-100 pt-4">
          <label className="block">
            <span className="block text-sm font-medium text-slate-800">이름</span>
            <input value={title} maxLength={MAX_PORTFOLIO_TITLE_CHARS} onChange={(e) => setTitle(e.target.value)} className={inputClass} />
          </label>
          <label className="block">
            <span className="block text-sm font-medium text-slate-800">
              설명 <span className="font-normal text-slate-400">(면접 질문·진단에 함께 쓰입니다)</span>
            </span>
            <textarea
              value={description}
              maxLength={MAX_PORTFOLIO_DESCRIPTION_CHARS}
              onChange={(e) => setDescription(e.target.value)}
              rows={4}
              placeholder="내 역할과 결과를 적어 주세요."
              className={textareaClass}
            />
            <span className="mt-1 block text-right text-xs text-slate-400">
              {description.length}/{MAX_PORTFOLIO_DESCRIPTION_CHARS}
            </span>
          </label>
          <div className="flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setPanel(null)} disabled={busy === "meta"}>
              취소
            </Button>
            <Button size="sm" onClick={saveMeta} loading={busy === "meta"} disabled={busy !== null}>
              저장
            </Button>
          </div>
        </div>
      )}

      {panel === "content" && p.kind !== "graph" && (
        <div className="mt-4 border-t border-slate-100 pt-4">
          <p className="mb-3 text-xs text-slate-500">
            새 파일이나 링크로 바꿉니다. 이름·설명과 붙인 이력서는 그대로이고, 저장해 둔 이전 원본 파일과 글은 지워집니다.
          </p>
          <PortfolioContentForm
            endpoint={`/api/portfolios/${p.id}`}
            method="PUT"
            upload={upload}
            withMeta={false}
            submitLabel="바꾸기"
            initialMode={p.kind === "url" ? "url" : "file"}
            onCancel={() => setPanel(null)}
            onDone={(_data, w) => {
              setPanel(null);
              setWarnings(w);
              setNotice("내용을 바꿨습니다.");
              router.refresh();
            }}
          />
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
