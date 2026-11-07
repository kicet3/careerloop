"use client";
/**
 * 경험 그래프로 만든 포트폴리오 상세: A4 쪽 미리보기(인쇄·PDF 저장), 본문 고치기(Markdown), 다시 만들기, AI가 남긴 '채워야 할 정보'.
 * 고친 본문은 PUT /api/portfolios/[id]/text로 저장한다(면접 질문·진단에는 저장한 본문이 들어간다).
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { SegmentedTabs } from "@/components/app/Tabs";
import { textareaClass } from "@/components/resumes/styles";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { countPortfolioAddMarkers } from "@/lib/domain/graph-portfolio";
import { MAX_PORTFOLIO_TEXT_CHARS, type PortfolioListItem } from "@/lib/domain/portfolios";
import type { ProviderId, ProviderOption } from "@/lib/domain/providers";
import { NETWORK_ERROR, readError } from "./api";
import { GraphPortfolioForm, type GraphPostingOption } from "./GraphPortfolioForm";
import { PortfolioSheet } from "./PortfolioSheet";

type Tab = "preview" | "edit";

export function GraphPortfolioView({
  portfolio: p,
  text,
  postings,
  providers,
  defaultProvider,
  regeneratingJobId = null,
}: {
  portfolio: PortfolioListItem;
  /** 저장된 본문(없으면 빈 문자열 — 다시 만들기만 할 수 있다). */
  text: string;
  /** 이 포트폴리오를 다시 만드는 진행 중 작업 id. 있으면 저장·다시 만들기를 막는다(끝나면 본문을 덮어쓰므로). */
  regeneratingJobId?: string | null;
  postings: GraphPostingOption[];
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("preview");
  const [draft, setDraft] = useState(text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [regenOpen, setRegenOpen] = useState(!text && !regeneratingJobId);
  const dirty = draft !== text;
  const regenerating = !!regeneratingJobId;
  // 수는 저장한 본문에 남은 [ADD] 자리로 센다(직접 채우고 저장하면 줄어든다). AI가 남긴 목록은 자리가 남아 있을 때의 안내로만 보인다.
  const openMarkers = countPortfolioAddMarkers(text);
  const hints = p.graphSource?.missingInfo ?? [];

  async function save() {
    if (regenerating) {
      setError("이 포트폴리오를 다시 만드는 중입니다. 끝난 뒤 고쳐 주세요.");
      return;
    }
    if (!draft.trim()) {
      setError("본문을 입력해 주세요.");
      return;
    }
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const res = await fetch(`/api/portfolios/${encodeURIComponent(p.id)}/text`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: draft }),
      });
      if (!res.ok) {
        setError(await readError(res, "본문을 저장하지 못했습니다."));
        return;
      }
      setNotice("본문을 저장했습니다.");
      setTab("preview");
      router.refresh();
    } catch {
      setError(NETWORK_ERROR);
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2 print:hidden">
        <SegmentedTabs
          label="포트폴리오 보기 방식"
          value={tab}
          onChange={(t) => {
            setTab(t);
            setError(null);
          }}
          options={[
            { value: "preview", label: "A4 미리보기" },
            { value: "edit", label: dirty ? "본문 고치기 •" : "본문 고치기" },
          ]}
        />
        <div className="ml-auto flex flex-wrap gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => window.print()} disabled={tab !== "preview" || dirty || !text}>
            인쇄·PDF 저장
          </Button>
          <Button size="sm" variant="secondary" onClick={() => setRegenOpen((v) => !v)} disabled={regenerating}>
            다시 만들기
          </Button>
        </div>
      </div>
      {dirty && tab === "preview" && (
        <p className="text-xs text-amber-700 print:hidden">고친 본문을 아직 저장하지 않았습니다. 미리보기는 저장하지 않은 내용입니다 — 인쇄하려면 먼저 저장해 주세요.</p>
      )}

      {regeneratingJobId && (
        <Alert tone="info" title="다시 만드는 중입니다" className="print:hidden">
          끝나면 본문이 새로 바뀝니다. 그동안은 본문을 저장할 수 없습니다.{" "}
          <Link href={`/app/portfolios/drafts/${encodeURIComponent(regeneratingJobId)}`} className="font-medium underline">
            진행 화면 보기
          </Link>
        </Alert>
      )}
      {!text && !regenerating && (
        <Alert tone="warning" title="저장된 본문이 없습니다" className="print:hidden">
          아래에서 경험 그래프로 다시 만들면 이 포트폴리오(이름·붙인 이력서 그대로)에 본문이 채워집니다. 본문 고치기로 직접 써도 됩니다.
        </Alert>
      )}

      {regenOpen && !regenerating && (
        <Card className="p-4 sm:p-5 print:hidden">
          <h2 className="mb-1 text-sm font-semibold text-slate-900">경험 그래프로 다시 만들기</h2>
          <p className="mb-3 text-xs text-slate-500">그래프를 고친 뒤 다시 만들면 최신 내용이 반영됩니다. 이름·설명·붙인 이력서는 그대로입니다.</p>
          <GraphPortfolioForm
            postings={postings}
            providers={providers}
            defaultProvider={defaultProvider}
            regenerate={{
              portfolioId: p.id,
              title: p.title,
              projectIds: p.graphSource?.projectIds ?? [],
              postingId: p.graphSource?.postingId ?? null,
              notes: p.graphSource?.notes ?? "",
            }}
            onCancel={() => setRegenOpen(false)}
          />
        </Card>
      )}

      {(openMarkers > 0 || hints.length > 0) && (
        <Alert tone="warning" title={openMarkers > 0 ? `채워야 할 자리 ${openMarkers}개` : "AI가 남긴 확인할 점"} className="print:hidden">
          {hints.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5">
              {hints.map((m, i) => (
                <li key={i}>{m}</li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs">
            본문의 <strong>[ADD: …]</strong> 자리를 직접 채우거나,{" "}
            <Link href="/app/graph" className="font-medium underline">
              경험 그래프
            </Link>
            에 정보를 더한 뒤 다시 만들어 주세요.
          </p>
        </Alert>
      )}

      {error && (
        <Alert tone="error" className="print:hidden">
          {error}
        </Alert>
      )}
      {notice && !error && (
        <Alert tone="info" className="print:hidden">
          {notice}
        </Alert>
      )}

      {tab === "preview" ? (
        <PortfolioSheet source={draft} />
      ) : (
        <Card className="p-4 sm:p-5 print:hidden">
          <label className="block">
            <span className="block text-sm font-medium text-slate-800">
              본문(Markdown) <span className="font-normal text-slate-400"># 제목, ## 프로젝트, ### 소제목, - 목록, **굵게**, [이름](https://주소)</span>
            </span>
            <textarea
              value={draft}
              maxLength={MAX_PORTFOLIO_TEXT_CHARS}
              onChange={(e) => setDraft(e.target.value)}
              rows={28}
              spellCheck={false}
              className={`${textareaClass} font-mono text-xs leading-relaxed`}
            />
            <span className="mt-1 block text-right text-xs text-slate-400">
              {draft.length.toLocaleString("ko-KR")}/{MAX_PORTFOLIO_TEXT_CHARS.toLocaleString("ko-KR")}
            </span>
          </label>
          <div className="mt-2 flex justify-end gap-2">
            <Button variant="ghost" size="sm" onClick={() => setDraft(text)} disabled={!dirty || saving}>
              되돌리기
            </Button>
            <Button size="sm" onClick={() => void save()} loading={saving} disabled={!dirty || saving || regenerating}>
              저장
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}
