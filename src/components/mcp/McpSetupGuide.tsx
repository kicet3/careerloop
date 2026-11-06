"use client";

/**
 * 외부 AI 앱 연결 방법: 엔드포인트 주소와 클라이언트별 설정 예시(domain/mcp.ts buildClientSnippets).
 * 방금 만든 토큰이 있으면 예시에 그대로 넣고, 없으면 "<토큰>" 자리 표시자를 둔다.
 */
import { useState } from "react";
import { cn } from "@/components/ui/cn";
import { buildClientSnippets, type McpClientSnippet } from "@/lib/domain/mcp";

export function CopyButton({ text, label = "복사" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "done" | "failed">("idle");
  async function copy() {
    try {
      await navigator.clipboard.writeText(text);
      setState("done");
    } catch {
      setState("failed");
    }
    setTimeout(() => setState("idle"), 2000);
  }
  return (
    <button
      type="button"
      onClick={copy}
      className="shrink-0 rounded-md border border-slate-300 bg-white px-2 py-1 text-xs font-medium text-slate-700 hover:bg-slate-50"
      aria-live="polite"
    >
      {state === "done" ? "복사됨" : state === "failed" ? "복사 실패" : label}
    </button>
  );
}

function SnippetBlock({ s }: { s: McpClientSnippet }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-slate-600">{s.note}</p>
      {s.code && (
        <div className="relative">
          <pre className="overflow-x-auto rounded-lg bg-slate-900 p-3 pr-16 text-xs leading-relaxed text-slate-100">
            <code>{s.code}</code>
          </pre>
          <div className="absolute top-2 right-2">
            <CopyButton text={s.code} />
          </div>
        </div>
      )}
    </div>
  );
}

export function McpSetupGuide({ endpoint, token }: { endpoint: string; token?: string | null }) {
  const snippets = buildClientSnippets(endpoint, token);
  const [active, setActive] = useState<McpClientSnippet["id"]>("claude-code");
  const current = snippets.find((s) => s.id === active) ?? snippets[0]!;
  return (
    <div className="space-y-4">
      <div>
        <p className="mb-1 text-sm font-medium text-slate-800">서버 주소</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800">{endpoint}</code>
          <CopyButton text={endpoint} />
        </div>
        <p className="mt-1 text-xs text-slate-500">
          Streamable HTTP 방식이고, 요청마다 <code>Authorization: Bearer &lt;토큰&gt;</code> 헤더가 필요합니다.
        </p>
      </div>
      <div>
        <div role="tablist" aria-label="연결할 앱" className="flex flex-wrap gap-1 border-b border-slate-200">
          {snippets.map((s) => (
            <button
              key={s.id}
              type="button"
              role="tab"
              aria-selected={s.id === current.id}
              onClick={() => setActive(s.id)}
              className={cn(
                "-mb-px border-b-2 px-3 py-2 text-sm font-medium",
                s.id === current.id ? "border-indigo-600 text-indigo-700" : "border-transparent text-slate-500 hover:text-slate-800",
              )}
            >
              {s.title}
            </button>
          ))}
        </div>
        <div role="tabpanel" className="pt-3">
          <SnippetBlock s={current} />
        </div>
      </div>
      {!token && <p className="text-xs text-slate-500">토큰을 새로 만들면 위 예시에 그 토큰이 들어갑니다.</p>}
    </div>
  );
}
