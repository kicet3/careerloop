"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SegmentedTabs } from "@/components/app/Tabs";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import type { PortfolioUploadConfig } from "@/lib/domain/portfolios";
import type { ProviderId, ProviderOption } from "@/lib/domain/providers";
import { GraphPortfolioForm, type GraphPostingOption } from "./GraphPortfolioForm";
import { PortfolioContentForm } from "./PortfolioContentForm";

export type NewPortfolioMode = "file" | "url" | "graph";

/**
 * 보관함 화면의 '새 포트폴리오' 버튼 + 만들기 폼: 파일 올리기 · 링크 · 경험 그래프로 만들기(AI 작업 — 진행 화면으로 옮긴다).
 * 파일·링크로 만들면 서버 화면을 새로 그린다.
 */
export function NewPortfolioPanel({
  upload,
  count,
  startOpen,
  initialMode = "file",
  postings,
  providers,
  defaultProvider,
}: {
  upload: PortfolioUploadConfig;
  count: number;
  startOpen: boolean;
  initialMode?: NewPortfolioMode;
  postings: GraphPostingOption[];
  providers: ProviderOption[];
  defaultProvider: ProviderId | null;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [mode, setMode] = useState<NewPortfolioMode>(initialMode);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const close = count > 0 ? () => setOpen(false) : undefined;

  return (
    <div className="space-y-3">
      {!open && (
        <div className="flex flex-wrap items-center gap-2">
          <Button
            onClick={() => {
              setOpen(true);
              setMode("file");
              setNotice(null);
              setWarnings([]);
            }}
          >
            새 포트폴리오
          </Button>
          <Button
            variant="secondary"
            onClick={() => {
              setOpen(true);
              setMode("graph");
              setNotice(null);
              setWarnings([]);
            }}
          >
            경험 그래프로 만들기
          </Button>
        </div>
      )}
      {open && (
        <Card className="p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">새 포트폴리오</h2>
          <div className="mb-3">
            <SegmentedTabs
              label="포트폴리오 만드는 방식"
              value={mode}
              onChange={setMode}
              options={[
                { value: "file", label: "파일 올리기" },
                { value: "url", label: "링크" },
                { value: "graph", label: "경험 그래프로 만들기" },
              ]}
            />
          </div>
          {mode === "graph" ? (
            <>
              <p className="mb-3 text-xs text-slate-500">
                경험 그래프에 정리한 프로젝트로 AI가 프로젝트별 개요·역할·기술·문제·해결·성과를 정리한 포트폴리오를 씁니다. 만든 뒤 고치고 인쇄(PDF)할 수 있습니다.
              </p>
              <GraphPortfolioForm postings={postings} providers={providers} defaultProvider={defaultProvider} onCancel={close} />
            </>
          ) : (
            <PortfolioContentForm
              key={mode}
              endpoint="/api/portfolios"
              method="POST"
              upload={upload}
              withMeta
              submitLabel="보관함에 추가"
              initialMode={mode}
              showModeTabs={false}
              onCancel={close}
              onDone={(_data, w) => {
                setOpen(false);
                setWarnings(w);
                setNotice("포트폴리오를 추가했습니다. 이력서 편집 화면에서 골라 붙일 수 있습니다.");
                router.refresh();
              }}
            />
          )}
        </Card>
      )}
      {notice && <Alert tone="info">{notice}</Alert>}
      {warnings.length > 0 && (
        <Alert tone="warning">
          <ul className="list-disc pl-5">
            {warnings.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </Alert>
      )}
    </div>
  );
}
