"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { ResumeApplyStatus, ResumeKind } from "@/lib/domain/resumes";
import { ResumeStatusControl } from "./ResumeStatusControl";

/** 이력서 목록 카드의 지원 상태 빠른 변경. 바꾸면 안내를 잠깐 보여 주고 목록을 다시 읽는다(필터·배지 반영). */
export function ResumeListStatus({
  resumeId,
  kind,
  status,
  hasPosting,
  hasApplication,
}: {
  resumeId: string;
  kind: ResumeKind;
  status: ResumeApplyStatus | null;
  hasPosting: boolean;
  hasApplication: boolean;
}) {
  const router = useRouter();
  const [message, setMessage] = useState<string | null>(null);
  return (
    <span className="inline-flex flex-col items-start gap-1">
      <ResumeStatusControl
        resumeId={resumeId}
        kind={kind}
        status={status}
        hasPosting={hasPosting}
        hasApplication={hasApplication}
        size="sm"
        onChanged={(_result, msg) => {
          setMessage(msg);
          router.refresh();
        }}
      />
      {message && (
        <span role="status" className="text-xs text-slate-500">
          {message}
        </span>
      )}
    </span>
  );
}
