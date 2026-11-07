"use client";
/**
 * 이력서 편집 화면의 '심사 리포트' 카드(에이전트로 만든 이력서). ?report=1이면 펼친 채로 연다.
 * - 최종 심사: 심사위원 7명 판정(진단과 같은 "7명 중 n명 통과"), 라운드별 핵심 심사·적합도·바뀐 점(전/후).
 * - 요건 표: JD 요건마다 충족/부분/공백, 이력서 줄, 근거(그래프 노드 이름·경로). 작성 시점 기준 — 이후 고친 줄은 흐리게.
 * - 남은 공백: 그래프 채팅으로 답하기(/app/graph?ask=…#graph-chat). '그래프를 채운 뒤 다시 실행'은 새 이력서를 하나 더 만들고 하루 한도 1회를 쓴다.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { graphChatHref } from "@/components/graph/api";
import { Badge } from "@/components/ui/Badge";
import { Button, buttonClass } from "@/components/ui/Button";
import { Card } from "@/components/ui/Card";
import { normalizeForQuote } from "@/lib/panel/quotes";
import { NODE_LABEL_META } from "@/lib/domain/graph";
import { REVIEWERS } from "@/lib/domain/reviewers";
import type { ReviewerId } from "@/lib/domain/schemas";
import { EXTRA_REVIEWER_LABELS, PATCH_OP_LABELS, STOP_REASON_LABELS, type FinalPanelView } from "@/lib/resume-agent/job-types";
import type { AgentReport as AgentReportModel } from "@/lib/resume-agent/schemas";
import { AgentRoundScores, roundTitle } from "./AgentRoundScores";

const STATUS: Record<"met" | "partial" | "missing", { label: string; tone: "positive" | "warning" | "negative" }> = {
  met: { label: "충족", tone: "positive" },
  partial: { label: "부분", tone: "warning" },
  missing: { label: "공백", tone: "negative" },
};

/** 리포트의 이력서 줄이 지금 문서에 아직 있는가(편집 뒤에는 없을 수 있다). */
export function lineStillPresent(line: string | null, currentText: string): boolean {
  if (!line) return false;
  return normalizeForQuote(currentText).includes(normalizeForQuote(line));
}

/** 심사를 끝내지 못했는가(수정 루프 심사 실패, 또는 최종 7명 심사 결과 없음). 진단으로 다시 심사하게 안내한다. */
export function reviewIncomplete(report: Pick<AgentReportModel, "stopReason" | "finalPanel">): boolean {
  return report.stopReason === "review_failed" || !report.finalPanel;
}

export function reportHeadline(report: Pick<AgentReportModel, "stopReason" | "gaps" | "finalPanel">): string {
  if (reviewIncomplete(report)) return "심사를 끝내지 못했습니다 — 진단에서 다시 심사할 수 있어요";
  if (report.stopReason === "passed") return `목표 달성 · 최종 심사 7명 중 ${report.finalPanel!.passCount}명 통과`;
  if (report.stopReason === "budget") return "비용 상한에 걸려 마지막 회차까지 다듬지 못했습니다";
  if (report.gaps.length === 0) return "목표 기준에는 못 미쳤습니다 — 리포트의 심사 지적을 참고해 직접 다듬어 주세요";
  return `목표 기준에는 못 미쳤습니다 — 채울 정보 ${report.gaps.length}개를 답하면 올라갑니다`;
}

const reviewerName = (id: string): string => REVIEWERS[id as ReviewerId]?.name ?? EXTRA_REVIEWER_LABELS[id] ?? id;

export function AgentReport({
  report,
  currentText,
  defaultOpen,
  rerun,
}: {
  report: AgentReportModel;
  currentText: string;
  defaultOpen: boolean;
  /** '그래프를 채운 뒤 다시 실행'에 쓸 입력(이력서의 연결 공고·회사·직무·현재 JD 칸). 공용 이력서면 kind general. */
  rerun: { kind: "company" | "general"; company: string; roleTitle: string; jdText: string; postingId: string | null; templateId: string } | null;
}) {
  const router = useRouter();
  const [starting, setStarting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const finalPanel: FinalPanelView | null = report.finalPanel;

  async function startAgain() {
    if (!rerun) return;
    setStarting(true);
    setError(null);
    try {
      const res = await fetch("/api/resumes", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...rerun, title: "", source: { kind: "graph" }, mode: "agent" }),
      });
      const data = (await res.json().catch(() => null)) as { agentJob?: { id: string }; draftJob?: { id: string }; error?: string; agentJobId?: string } | null;
      if (data?.agentJob) return router.push(`/app/resumes/agent/${encodeURIComponent(data.agentJob.id)}`);
      if (data?.draftJob) return router.push(`/app/resumes/drafts/${encodeURIComponent(data.draftJob.id)}`);
      if (res.status === 409 && data?.agentJobId) return router.push(`/app/resumes/agent/${encodeURIComponent(data.agentJobId)}`);
      setError(data?.error ?? "다시 실행하지 못했습니다.");
    } catch {
      setError("서버에 연결하지 못했습니다.");
    } finally {
      setStarting(false);
    }
  }

  return (
    <Card className="p-0">
      <details open={defaultOpen} className="group">
        <summary className="flex cursor-pointer flex-wrap items-center justify-between gap-2 px-5 py-4">
          <span>
            <span className="text-base font-semibold text-slate-900">심사 리포트</span>
            <span className="ml-2 text-sm text-slate-600">{reportHeadline(report)}</span>
          </span>
          <span className="text-xs text-slate-500 group-open:hidden">펼치기 ▸</span>
        </summary>
        <div className="grid gap-6 border-t border-slate-100 px-5 py-5">
          <p className="text-xs text-slate-500" suppressHydrationWarning>
            작성 시점({new Date(report.generatedAt).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" })}) 기준 — 이후 편집한 내용은 반영되지 않습니다.
            {report.jd.source === "inferred" && " 공고 없이 직무명으로 요건을 추정했습니다(추정)."}
          </p>

          <section aria-label="라운드별 심사">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">심사위원 심사</h3>
            <AgentRoundScores
              rounds={report.rounds.map((r) => ({ ...r, incomplete: false }))}
              finalPanel={finalPanel}
              chosenRound={report.chosenRound}
            />
            <p className="mt-2 text-xs text-slate-500">멈춘 이유: {STOP_REASON_LABELS[report.stopReason]}</p>
            {reviewIncomplete(report) && (
              <Link href="/app/new" className={`${buttonClass("secondary", "sm")} mt-2`}>
                진단 시작하기
              </Link>
            )}
          </section>

          <section aria-label="JD 요건 표">
            <h3 className="mb-2 text-sm font-semibold text-slate-900">
              JD 요건별 반영 (필수 {report.jd.mustTotal} · 우대 {report.jd.niceTotal})
            </h3>
            <ul className="grid gap-2">
              {report.requirements.map((r) => {
                const s = STATUS[r.status];
                const present = lineStillPresent(r.resumeLine, currentText);
                return (
                  <li key={r.requirementId} className="rounded-lg border border-slate-200 px-3 py-2 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-mono text-xs text-slate-400">{r.requirementId}</span>
                      <span className="font-medium text-slate-900">{r.text}</span>
                      <Badge tone={r.must ? "accent" : "neutral"}>{r.must ? "필수" : "우대"}</Badge>
                      <Badge tone={s.tone}>{s.label}</Badge>
                      {r.inferred && <Badge tone="neutral">추정</Badge>}
                    </div>
                    {r.resumeLine && <p className={`mt-1 text-slate-700 ${present ? "" : "opacity-50"}`}>“{r.resumeLine}”{!present && " (편집으로 바뀜)"}</p>}
                    {r.evidence.length > 0 && (
                      <p className="mt-1 text-xs text-slate-500">근거: {r.evidence.map((e) => `${e.name}(${NODE_LABEL_META[e.label].name})`).join(", ")}</p>
                    )}
                  </li>
                );
              })}
            </ul>
          </section>

          {report.rounds.some((r) => r.changes.length > 0) && (
            <section aria-label="바뀐 점">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">심사 지적으로 바뀐 점</h3>
              <ul className="grid gap-2 text-sm">
                {report.rounds.flatMap((r) =>
                  r.changes.map((c, i) => (
                    <li key={`${r.round}-${i}`} className="rounded-lg bg-slate-50 px-3 py-2">
                      <p className="text-xs text-slate-500">
                        {roundTitle(r.round)} · {PATCH_OP_LABELS[c.op] ?? "수정"}
                        {c.reviewers.length > 0 && ` · 지적: ${c.reviewers.map(reviewerName).join(", ")}`}
                      </p>
                      {c.before && <p className="text-slate-500 line-through">{c.before}</p>}
                      {c.after && <p className="text-slate-800">{c.after}</p>}
                    </li>
                  )),
                )}
              </ul>
            </section>
          )}

          {report.gaps.length > 0 && (
            <section aria-label="남은 공백">
              <h3 className="mb-2 text-sm font-semibold text-slate-900">채울 정보(그래프에 없어 지어내지 않은 것)</h3>
              <ul className="grid gap-2 text-sm">
                {report.gaps.map((g) => (
                  <li key={g.requirementId ?? g.question} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2">
                    <span className="text-slate-800">{g.question}</span>
                    <Link href={graphChatHref(g.chatPrompt)} className="text-sm font-medium text-indigo-700 hover:underline">
                      그래프 채팅에서 답하기
                    </Link>
                  </li>
                ))}
              </ul>
              {rerun && (
                <div className="mt-3 flex flex-wrap items-center gap-2">
                  <Button type="button" size="sm" variant="secondary" loading={starting} onClick={() => void startAgain()}>
                    그래프를 채운 뒤 다시 실행
                  </Button>
                  <span className="text-xs text-slate-500">새 이력서가 하나 더 생기고 하루 한도(5회) 중 1회를 씁니다.</span>
                  {error && <span className="text-xs text-red-700">{error}</span>}
                </div>
              )}
            </section>
          )}

          <section aria-label="사실 검증" className="text-sm text-slate-600">
            <h3 className="mb-1 text-sm font-semibold text-slate-900">사실 검증</h3>
            <p>
              수치 확인 필요 {report.factCheck.numbersFlagged}건 · 근거가 없어 뺀 줄 {report.factCheck.dropped}개 · 그래프 값으로 고친 곳 {report.factCheck.corrected}곳
            </p>
            {report.excluded.length > 0 && (
              <p className="mt-1 text-xs text-slate-500">뺀 항목: {report.excluded.map((e) => `${e.name}(${e.reason})`).join(", ")}</p>
            )}
            {report.notes.length > 0 && (
              <ul className="mt-1 list-disc pl-5 text-xs text-slate-500">
                {report.notes.map((n) => (
                  <li key={n}>{n}</li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </details>
    </Card>
  );
}
