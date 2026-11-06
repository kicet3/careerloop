"use client";
/**
 * 그래프 페이지의 '보관한 공고들이 요구하지만 없는 기술 Top N'. GET /api/insights/skills를 부르고,
 * 그래프가 바뀌면('career-graph:changed') 다시 읽는다. 항목을 누르면 그래프 채팅 입력을 미리 채운다.
 */
import Link from "next/link";
import { useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner } from "@/components/ui";
import { GRAPH_CHANGED_EVENT } from "@/components/graph/api";
import { graphChatPrompt, type SkillGapResponse } from "@/lib/graph/match";
import { getJson, graphChatHref } from "./shared";

const SHOWN = 10;

type LoadState = { kind: "loading" } | { kind: "ready"; data: SkillGapResponse } | { kind: "error"; message: string };

/** bare: 다른 카드 안(경험 그래프 화면의 오른쪽 탭)에 넣을 때 — 카드 테두리 없이 그린다. */
export function SkillGapPanel({ bare = false }: { bare?: boolean } = {}) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    const ctrl = new AbortController();
    getJson<SkillGapResponse>("/api/insights/skills", ctrl.signal)
      .then((data) => setState({ kind: "ready", data }))
      .catch((e: unknown) => {
        if (!ctrl.signal.aborted) setState({ kind: "error", message: e instanceof Error ? e.message : "불러오지 못했습니다." });
      });
    return () => ctrl.abort();
  }, [reloadKey]);

  // 그래프를 직접 고치거나 채팅 변경안을 적용하면 다시 센다.
  useEffect(() => {
    const onChange = () => setReloadKey((k) => k + 1);
    window.addEventListener(GRAPH_CHANGED_EVENT, onChange);
    return () => window.removeEventListener(GRAPH_CHANGED_EVENT, onChange);
  }, []);

  const items = state.kind === "ready" ? state.data.items : [];
  const shown = expanded ? items : items.slice(0, SHOWN);

  return (
    <Wrapper bare={bare}>
      <CardHeader
        className={bare ? "px-4 pt-4 sm:px-5" : undefined}
        title="공고가 요구하지만 내 그래프에 없는 기술"
        description="보관한 공고(마감 제외, 최근 50개)를 경험 그래프와 대조해 많이 요구하는 순으로 모았습니다."
        action={
          <Button size="sm" variant="ghost" onClick={() => setReloadKey((k) => k + 1)} disabled={state.kind === "loading"}>
            새로 고침
          </Button>
        }
      />
      <CardBody className={bare ? "px-4 sm:px-5" : undefined}>
        {state.kind === "loading" && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> 공고와 대조하는 중…
          </p>
        )}
        {state.kind === "error" && <Alert tone="error">{state.message}</Alert>}
        {state.kind === "ready" && state.data.postingsConsidered === 0 && (
          <p className="text-sm text-slate-500">
            요구 기술을 대조할 공고가 아직 없습니다.{" "}
            <Link href="/app/postings" className="font-medium text-indigo-700 hover:underline">
              공고 보관함
            </Link>
            에 JD가 있는 공고를 담아 보세요.
          </p>
        )}
        {state.kind === "ready" && state.data.postingsConsidered > 0 && items.length === 0 && (
          <p className="text-sm text-slate-500">
            공고 {state.data.postingsConsidered}개가 요구하는 기술이 모두 그래프에 있습니다.
          </p>
        )}
        {items.length > 0 && (
          <div className="space-y-3">
            <p className="text-xs text-slate-500">공고 {state.kind === "ready" ? state.data.postingsConsidered : 0}개 기준</p>
            <ol className="divide-y divide-slate-100">
              {shown.map((g, i) => (
                <li key={g.key} className="flex flex-wrap items-start justify-between gap-x-3 gap-y-1.5 py-2.5 first:pt-0">
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-1.5">
                      <span className="w-5 text-xs text-slate-400 tabular-nums">{i + 1}</span>
                      <span className="font-medium break-words text-slate-900">{g.name}</span>
                      <Badge>공고 {g.postings}개</Badge>
                      {g.mustCount > 0 && <Badge tone="accent">필수 {g.mustCount}</Badge>}
                    </p>
                    <p className="mt-0.5 truncate pl-6.5 text-xs text-slate-500">
                      {g.examples.map((e, j) => (
                        <span key={e.postingId}>
                          {j > 0 && ", "}
                          <Link href={`/app/postings/${encodeURIComponent(e.postingId)}`} className="hover:text-indigo-700 hover:underline">
                            {e.company}
                          </Link>
                        </span>
                      ))}
                      {g.postings > g.examples.length && ` 외 ${g.postings - g.examples.length}개`}
                    </p>
                  </div>
                  <Link
                    href={graphChatHref(graphChatPrompt(g.name, g.examples[0]))}
                    scroll={false}
                    className="shrink-0 rounded-md px-2 py-1 text-xs font-medium text-indigo-700 hover:bg-indigo-50"
                    aria-label={`${g.name} 경험을 그래프 채팅으로 정리`}
                  >
                    채팅으로 정리
                  </Link>
                </li>
              ))}
            </ol>
            {items.length > SHOWN && (
              <Button size="sm" variant="ghost" onClick={() => setExpanded((v) => !v)}>
                {expanded ? "접기" : `${items.length - SHOWN}개 더 보기`}
              </Button>
            )}
          </div>
        )}
      </CardBody>
    </Wrapper>
  );
}

function Wrapper({ bare, children }: { bare: boolean; children: React.ReactNode }) {
  return bare ? <div className="min-w-0">{children}</div> : <Card className="min-w-0">{children}</Card>;
}
