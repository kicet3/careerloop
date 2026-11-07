"use client";
/**
 * 범위 밖 요청 안내(scope-guard.ts): 오류가 아니라 안내로 보인다 — 무엇에 쓰는 대화인지 예시와 함께.
 */
import { Alert } from "@/components/ui";
import { type ChatScopeMode, SCOPE_EXAMPLES } from "@/lib/chat/scope-guard";

export function ScopeNotice({ text, mode }: { text: string; mode: ChatScopeMode }) {
  return (
    <Alert tone="info" title={mode === "qa" ? "경험 그래프에 대한 질문만 답해요" : "경험 정리에 쓰는 대화예요"}>
      <p className="whitespace-pre-wrap break-words">{text}</p>
      <p className="mt-2 text-xs font-medium">이렇게 써 보세요</p>
      <ul className="mt-1 list-disc space-y-0.5 pl-4 text-xs">
        {SCOPE_EXAMPLES[mode].map((x) => (
          <li key={x}>{x}</li>
        ))}
      </ul>
      <p className="mt-2 text-xs">관련 없는 요청이 짧은 시간에 여러 번 반복되면 경험 대화가 잠시 멈춰요.</p>
    </Alert>
  );
}
