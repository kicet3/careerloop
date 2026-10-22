"use client";

import { useEffect, useState } from "react";
import { Alert } from "@/components/ui/Alert";
import { takeCreationWarnings } from "./creation-warnings";

/** 진단을 만든 직후 같은 탭에서 한 번만 보여 주는 입력 경고(sessionStorage에서 읽고 지운다). */
export function CreationWarnings({ id }: { id: string }) {
  const [warnings, setWarnings] = useState<string[]>([]);
  useEffect(() => {
    const taken = takeCreationWarnings(id);
    if (taken.length > 0) {
      // 하이드레이션 뒤 외부 저장소(sessionStorage)에서 읽은 값을 한 번 반영한다.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setWarnings(taken);
    }
  }, [id]);
  if (warnings.length === 0) return null;
  return (
    <Alert tone="warning" title="입력 확인">
      <ul className="list-disc space-y-0.5 pl-4">
        {warnings.map((w, i) => (
          <li key={i}>{w}</li>
        ))}
      </ul>
    </Alert>
  );
}
