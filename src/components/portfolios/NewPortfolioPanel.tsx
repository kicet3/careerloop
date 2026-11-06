"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { Button } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { MAX_PORTFOLIOS_PER_USER } from "@/lib/domain/portfolios";
import { PortfolioContentForm } from "./PortfolioContentForm";

/** 보관함 화면의 '새 포트폴리오' 버튼 + 올리기 폼. 만들면 서버 화면을 새로 그린다. */
export function NewPortfolioPanel({ maxBytes, count, startOpen }: { maxBytes: number; count: number; startOpen: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(startOpen);
  const [notice, setNotice] = useState<string | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const full = count >= MAX_PORTFOLIOS_PER_USER;

  return (
    <div className="space-y-3">
      {!open && (
        <div className="flex flex-wrap items-center gap-3">
          <Button
            onClick={() => {
              setOpen(true);
              setNotice(null);
              setWarnings([]);
            }}
            disabled={full}
          >
            새 포트폴리오
          </Button>
          {full && <span className="text-sm text-slate-500">포트폴리오는 {MAX_PORTFOLIOS_PER_USER}개까지 보관할 수 있습니다.</span>}
        </div>
      )}
      {open && (
        <Card className="p-4 sm:p-5">
          <h2 className="mb-3 text-sm font-semibold text-slate-900">새 포트폴리오</h2>
          <PortfolioContentForm
            endpoint="/api/portfolios"
            method="POST"
            maxBytes={maxBytes}
            withMeta
            submitLabel="보관함에 추가"
            onCancel={count > 0 ? () => setOpen(false) : undefined}
            onDone={(_data, w) => {
              setOpen(false);
              setWarnings(w);
              setNotice("포트폴리오를 추가했습니다. 이력서 편집 화면에서 골라 붙일 수 있습니다.");
              router.refresh();
            }}
          />
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
