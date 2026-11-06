"use client";
/**
 * 공고 상세의 '내 경력과 대조' 카드. 공고가 요구하는 기술을 경험 그래프와 맞춰 증명됨·보유만·없음으로 나눈다.
 * 스스로 GET /api/postings/[id]/match를 부른다. '없음'·'보유만' 항목은 그래프 채팅을 미리 채운 입력으로 연다.
 */
import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { Alert, Badge, Button, Card, CardBody, CardHeader, Spinner, buttonClass, cn } from "@/components/ui";
import { NODE_LABEL_META } from "@/lib/domain/graph";
import {
  graphChatPrompt,
  IMPORTANCE_LABELS,
  MATCH_STATUS_LABELS,
  type MatchStatus,
  type PostingMatchResponse,
  type RequirementMatch,
} from "@/lib/graph/match";
import { getJson, graphChatHref, IMPORTANCE_TONE, MatchApiError, STATUS_STYLE } from "./shared";

const STATUS_ORDER: MatchStatus[] = ["proven", "claimed", "missing"];

const SOURCE_TEXT: Record<PostingMatchResponse["source"], string> = {
  diagnosis: "이 공고로 한 진단의 JD 분석에서 요구 기술을 가져왔습니다.",
  keywords: "공고 본문에서 기술 키워드를 찾았습니다. 이 공고로 진단하면 더 정확한 요구 사항으로 대조합니다.",
  none: "",
};

type LoadState = { kind: "loading" } | { kind: "ready"; data: PostingMatchResponse } | { kind: "error"; message: string; status: number };

export function PostingMatchCard({ postingId }: { postingId: string }) {
  const [state, setState] = useState<LoadState>({ kind: "loading" });
  const [reloadKey, setReloadKey] = useState(0);

  useEffect(() => {
    const ctrl = new AbortController();
    getJson<PostingMatchResponse>(`/api/postings/${encodeURIComponent(postingId)}/match`, ctrl.signal)
      .then((data) => setState({ kind: "ready", data }))
      .catch((e: unknown) => {
        if (ctrl.signal.aborted) return;
        const status = e instanceof MatchApiError ? e.status : 0;
        setState({ kind: "error", message: e instanceof Error ? e.message : "대조 결과를 불러오지 못했습니다.", status });
      });
    return () => ctrl.abort();
  }, [postingId, reloadKey]);

  const reload = useCallback(() => {
    setState({ kind: "loading" });
    setReloadKey((k) => k + 1);
  }, []);

  return (
    <Card className="min-w-0">
      <CardHeader
        title="내 경력과 대조"
        description="공고가 요구하는 기술을 경험 그래프와 맞춰 봤습니다."
        action={
          <Button size="sm" variant="ghost" onClick={reload} disabled={state.kind === "loading"}>
            다시 대조
          </Button>
        }
      />
      <CardBody className="space-y-4">
        {state.kind === "loading" && (
          <p className="flex items-center gap-2 text-sm text-slate-500">
            <Spinner /> 경험 그래프와 맞춰 보는 중…
          </p>
        )}
        {state.kind === "error" &&
          (state.status === 503 ? (
            <Alert tone="warning" title="경험 그래프를 쓸 수 없습니다">
              {state.message} 그래프 저장소가 준비되면 이 공고와 내 경력을 대조할 수 있습니다.
            </Alert>
          ) : (
            <Alert tone="error">{state.message}</Alert>
          ))}
        {state.kind === "ready" && <MatchResult data={state.data} />}
      </CardBody>
    </Card>
  );
}

function MatchResult({ data }: { data: PostingMatchResponse }) {
  if (data.source === "none") {
    return (
      <Alert tone="info" title="요구 기술을 찾지 못했습니다">
        공고 본문(JD)을 채우거나 이 공고로 진단을 돌리면 요구 기술을 뽑아 대조합니다.
      </Alert>
    );
  }

  const { summary } = data;
  const context = { company: data.company, roleTitle: data.roleTitle };
  return (
    <div className="space-y-4">
      <div className="space-y-2">
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-sm">
          {STATUS_ORDER.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5 text-slate-700">
              <span aria-hidden className={cn("size-2.5 rounded-full", STATUS_STYLE[s].dot)} />
              {MATCH_STATUS_LABELS[s]} <strong className="tabular-nums text-slate-900">{summary[s]}</strong>
            </span>
          ))}
        </div>
        <div className="flex h-2 overflow-hidden rounded-full bg-slate-100" aria-hidden>
          {STATUS_ORDER.map((s) =>
            summary[s] > 0 ? <div key={s} className={STATUS_STYLE[s].bar} style={{ width: `${(summary[s] / summary.total) * 100}%` }} /> : null,
          )}
        </div>
        <p className="text-xs text-slate-500">
          {SOURCE_TEXT[data.source]}
          {data.diagnosisId && (
            <>
              {" "}
              <Link href={`/app/d/${encodeURIComponent(data.diagnosisId)}`} className="font-medium text-indigo-700 hover:underline">
                진단 보기
              </Link>
            </>
          )}
        </p>
      </div>

      {data.graphEmpty && (
        <Alert tone="info" title="경험 그래프가 비어 있습니다">
          그래프에 직무·프로젝트와 쓴 기술을 정리하면 이 공고와 무엇이 맞는지 보입니다.{" "}
          <Link href="/app/graph" className="font-medium underline">
            경험 그래프로 가기
          </Link>
        </Alert>
      )}

      {STATUS_ORDER.map((s) => {
        const items = data.items.filter((i) => i.status === s);
        if (items.length === 0) return null;
        return (
          <section key={s} aria-label={MATCH_STATUS_LABELS[s]} className="space-y-2">
            <h3 className="flex items-center gap-1.5 text-sm font-semibold text-slate-800">
              <span aria-hidden className={cn("size-2.5 rounded-full", STATUS_STYLE[s].dot)} />
              {MATCH_STATUS_LABELS[s]} <span className="font-normal text-slate-500">{items.length}</span>
            </h3>
            {s === "missing" ? (
              <ul className="flex flex-wrap gap-2">
                {items.map((item) => (
                  <MissingChip key={item.key} item={item} context={context} />
                ))}
              </ul>
            ) : (
              <ul className="space-y-2">
                {items.map((item) => (
                  <MatchRow key={item.key} item={item} context={context} />
                ))}
              </ul>
            )}
          </section>
        );
      })}
    </div>
  );
}

type Ctx = { company: string; roleTitle: string };

function MatchRow({ item, context }: { item: RequirementMatch; context: Ctx }) {
  const style = STATUS_STYLE[item.status];
  return (
    <li className={cn("min-w-0 rounded-lg border px-3 py-2.5", style.chip)}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 font-medium break-words">{item.name}</span>
        <Badge tone={IMPORTANCE_TONE[item.importance]}>{IMPORTANCE_LABELS[item.importance]}</Badge>
        {item.skills.some((sk) => sk.name !== item.name) && (
          <span className="text-xs opacity-80">그래프: {item.skills.map((sk) => sk.name).join(", ")}</span>
        )}
      </div>
      {item.status === "proven" ? (
        <div className="mt-1.5 space-y-1 text-sm">
          <p className="break-words">
            {item.provenBy.map((p, i) => (
              <span key={p.id}>
                {i > 0 && ", "}
                {p.name}
                <span className="text-xs opacity-70"> ({NODE_LABEL_META[p.label].name})</span>
              </span>
            ))}
            에서 사용
          </p>
          {item.achievements.length > 0 && (
            <ul className="list-disc space-y-0.5 pl-5 text-xs text-emerald-900/90">
              {item.achievements.map((a) => (
                <li key={a.id} className="break-words">
                  {a.summary}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <div className="mt-1.5 flex flex-wrap items-center justify-between gap-2 text-sm">
          <p className="min-w-0">어느 직무·프로젝트에서 썼는지 이어 주면 &lsquo;증명됨&rsquo;이 됩니다.</p>
          <Link href={graphChatHref(graphChatPrompt(item.name, context))} className={buttonClass("secondary", "sm")}>
            그래프 채팅으로 이어 주기
          </Link>
        </div>
      )}
      {item.evidence && <p className="mt-1.5 text-xs break-words opacity-70">공고: {item.evidence}</p>}
    </li>
  );
}

function MissingChip({ item, context }: { item: RequirementMatch; context: Ctx }) {
  return (
    <li className={cn("flex max-w-full min-w-0 items-center gap-1.5 rounded-lg border py-1 pr-1 pl-2.5 text-sm", STATUS_STYLE.missing.chip)}>
      <span className="min-w-0 truncate" title={item.evidence ?? undefined}>
        {item.name}
      </span>
      {item.importance !== "keyword" && <Badge tone={IMPORTANCE_TONE[item.importance]}>{IMPORTANCE_LABELS[item.importance]}</Badge>}
      <Link
        href={graphChatHref(graphChatPrompt(item.name, context))}
        className="shrink-0 rounded-md px-1.5 py-0.5 text-xs font-medium whitespace-nowrap text-indigo-700 hover:bg-indigo-50"
        aria-label={`${item.name} 경험을 그래프 채팅으로 추가`}
      >
        그래프 채팅으로 추가
      </Link>
    </li>
  );
}
