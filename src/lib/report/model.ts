/**
 * DB 행(diagnoses + diagnosis_stages) → ReportModel.
 * 완료(done)되고 스키마를 통과한 단계만 쓰므로, 일부 단계가 없어도 부분 보고서를 만든다.
 * 렌더러(웹·PDF·Markdown)가 공유하는 표시용 라벨·포맷 헬퍼도 여기서 내보낸다.
 */
import type { Diagnosis, DiagnosisStage } from "@/lib/db/schema";
import {
  REVIEWER_IDS,
  STAGE_KEYS,
  STAGE_SCHEMAS,
  type FitItem,
  type ImprovementPlan,
  type Mistake,
  type ReviewerId,
  type StageKey,
  type StageOutputs,
} from "@/lib/domain/schemas";
import {
  REVIEWERS,
  SITUATION_LABELS,
  STAGE_LABELS,
  isPositiveVerdict,
  verdictLabel,
} from "@/lib/domain/reviewers";
import { scoreFit } from "@/lib/panel/fit-score";
import { verifyQuote } from "@/lib/panel/quotes";
import type {
  CheckedQuote,
  FitRow,
  MistakeView,
  ReportModel,
  ReviewerCard,
  VerdictView,
} from "./types";

// ---------------------------------------------------------------------------
// 표시용 라벨 (웹·PDF·Markdown 공용)
// ---------------------------------------------------------------------------

export const SEVERITY_LABELS: Record<Mistake["severity"], string> = {
  critical: "치명적",
  major: "중요",
  minor: "사소",
};

export const FIT_STATUS_LABELS: Record<FitItem["status"], string> = {
  met: "충족",
  partial: "부분 충족",
  missing: "미충족",
};

export const PRIORITY_LABELS: Record<FitRow["priority"], string> = {
  must: "필수",
  nice: "우대",
};

export const LEVEL_LABELS: Record<"high" | "medium" | "low", string> = {
  high: "높음",
  medium: "보통",
  low: "낮음",
};

export const CATEGORY_LABELS: Record<string, string> = {
  skill: "기술",
  experience: "경력",
  education: "학력",
  domain: "도메인",
  soft: "소프트 스킬",
  other: "기타",
};

export const PENDING_VERDICT: VerdictView = { raw: "PENDING", label: "미완료", tone: "neutral" };

export const CREDIT_LINE = "원본: /hiring-panel by Alex Chen (@nocodealex) · MIT";

export const DISCLAIMER_TEXT =
  "이 보고서는 언어 모델이 만든 구조화된 두 번째 의견입니다. 실제 채용 담당자의 판단을 대신하지 않으며, 면접이나 합격을 보장하지 않습니다. 재작성된 이력서의 사실 관계는 반드시 직접 확인하세요.";

/** Date 또는 ISO 문자열(JSON 직렬화된 ReportModel) → "2026년 10월 22일". */
export function formatReportDate(value: Date | string | null | undefined): string {
  if (!value) return "-";
  const d = typeof value === "string" ? new Date(value) : value;
  if (Number.isNaN(d.getTime())) return "-";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d);
}

/**
 * JD 키워드가 이력서에서 찾은 것인지(present), 서류 자동 필터가 못 찾은 것인지(missing) 판정한다(웹·PDF 공용).
 * 정확히 같은 missing 항목이 있으면 missing, 아니면 부분 일치로 present → missing 순으로 본다.
 */
export function keywordStatus(keyword: string, present: string[], missing: string[]): "present" | "missing" | "unknown" {
  const k = keyword.toLowerCase();
  const hit = (list: string[]) => list.some((x) => x.toLowerCase().includes(k) || k.includes(x.toLowerCase()));
  if (missing.some((x) => x.toLowerCase() === k)) return "missing";
  if (hit(present)) return "present";
  if (hit(missing)) return "missing";
  return "unknown";
}

/** ImprovementPlan의 impact/effort를 우선순위 정렬용 점수로(높을수록 먼저). */
export function priorityScore(p: ImprovementPlan["priorities"][number]): number {
  const impact = { high: 3, medium: 2, low: 1 }[p.impact];
  const effort = { low: 3, medium: 2, high: 1 }[p.effort];
  return impact * 10 + effort;
}

// ---------------------------------------------------------------------------
// 빌더
// ---------------------------------------------------------------------------

type Outputs = Partial<StageOutputs>;

function parseStageOutputs(stages: DiagnosisStage[]): Outputs {
  const out: Outputs = {};
  for (const row of stages) {
    if (row.status !== "done" || !(STAGE_KEYS as readonly string[]).includes(row.stage)) continue;
    let raw = row.output;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        continue;
      }
    }
    const parsed = STAGE_SCHEMAS[row.stage].safeParse(raw);
    if (parsed.success) (out as Record<StageKey, unknown>)[row.stage] = parsed.data;
  }
  return out;
}

/** 실패한 진단이라도 이 단계들이 모두 끝났으면 부분 보고서를 보여 준다(판정 7개 + JD 적합도). */
export const PARTIAL_REPORT_STAGES: readonly StageKey[] = ["jd", ...REVIEWER_IDS, "fit"];

/**
 * 보고서를 보여 줄 수 있는지. done이면 전체 보고서, failed라도 PARTIAL_REPORT_STAGES가 끝났으면 부분 보고서.
 * missing은 부분 보고서에 빠진 단계의 표시 이름(재시도로 채울 수 있는 것).
 */
export function reportAvailability(
  status: Diagnosis["status"],
  stages: Pick<DiagnosisStage, "stage" | "status">[],
): { show: boolean; partial: boolean; missing: string[] } {
  if (status === "done") return { show: true, partial: false, missing: [] };
  if (status !== "failed") return { show: false, partial: false, missing: [] };
  const done = new Set(stages.filter((s) => s.status === "done").map((s) => s.stage));
  if (!PARTIAL_REPORT_STAGES.every((k) => done.has(k))) return { show: false, partial: false, missing: [] };
  const missing = STAGE_KEYS.filter((k) => !done.has(k)).map((k) => STAGE_LABELS[k]);
  return { show: true, partial: true, missing };
}

export function buildReportModel(diagnosis: Diagnosis, stages: DiagnosisStage[]): ReportModel {
  const o = parseStageOutputs(stages);
  const resume = diagnosis.resumeText;
  const check = (text: string): CheckedQuote => ({ text, verified: safeVerify(resume, text) });
  const jdText = diagnosis.jdText ?? "";
  const checkJd = (text: string): CheckedQuote => ({ text, verified: safeVerify(jdText, text) });

  const reviewers = buildReviewerCards(o, check);
  const positiveCount = reviewers.filter((r) => isPositiveVerdict(r.id, r.verdict.raw)).length;

  const ats = o.ats;
  const rescreen = o.rescreen;
  const toView = (r: { verdict: string }): VerdictView => {
    const v = verdictLabel("ats", r.verdict);
    return { raw: r.verdict, label: v.label, tone: v.tone };
  };

  const synthesis = o.synthesis;
  const closest = synthesis?.closestToReject ?? null;

  return {
    meta: {
      diagnosisId: diagnosis.id,
      title: diagnosis.title,
      targetRole: diagnosis.targetRole,
      situation: diagnosis.situation,
      situationLabel: SITUATION_LABELS[diagnosis.situation] ?? diagnosis.situation,
      hasJd: Boolean(diagnosis.jdText?.trim()),
      resumeFileName: diagnosis.resumeFileName,
      createdAt: diagnosis.createdAt,
      completedAt: diagnosis.completedAt,
      model: diagnosis.model,
    },
    summary: {
      headline: synthesis?.headline ?? fallbackHeadline(reviewers.length, positiveCount),
      positiveCount,
      totalReviewers: REVIEWER_IDS.length,
      // 모델이 계산한 값 대신 매트릭스에서 다시 계산한다(머리 점수와 매트릭스가 어긋나지 않도록).
      matchScore: o.fit ? (o.jd ? scoreFit(o.jd, o.fit) : o.fit.matchScore) : null,
      atsBefore: ats ? toView(ats) : PENDING_VERDICT,
      atsAfter: rescreen ? toView(rescreen) : null,
      strengths: synthesis?.strengths ?? [],
      closestToReject: closest
        ? { reviewerName: REVIEWERS[closest.reviewer].name, why: closest.why }
        : null,
    },
    reviewers,
    jd: buildJd(o, check, checkJd),
    mistakes: buildMistakes(o, check),
    plan: o.plan ?? null,
    rewrite: o.rewrite ? buildRewrite(o.rewrite, rescreen ?? null) : null,
    originalResume: resume,
  };
}

function safeVerify(resume: string, quote: string): boolean {
  if (!quote.trim()) return false;
  try {
    return verifyQuote(resume, quote);
  } catch {
    return false;
  }
}

function fallbackHeadline(available: number, positive: number): string {
  if (available === 0) return "심사가 아직 끝나지 않아 요약을 만들 수 없습니다.";
  if (available < REVIEWER_IDS.length)
    return `심사위원 ${available}명의 판정만 도착했습니다(그중 ${positive}명 통과). 종합 결과는 아직 없습니다.`;
  return `심사위원 ${REVIEWER_IDS.length}명 중 ${positive}명이 통과 판정을 냈습니다. 종합 결과는 아직 없습니다.`;
}

function buildReviewerCards(o: Outputs, check: (t: string) => CheckedQuote): ReviewerCard[] {
  const cards: ReviewerCard[] = [];
  for (const id of REVIEWER_IDS) {
    const meta = REVIEWERS[id];
    const base = (verdict: string, oneLiner: string) => {
      const v = verdictLabel(id, verdict);
      return { id, name: meta.name, role: meta.role, verdict: { raw: verdict, label: v.label, tone: v.tone }, oneLiner };
    };
    if (id === "ats") {
      const r = o.ats;
      if (!r) continue;
      cards.push({
        ...base(r.verdict, r.oneLiner),
        detail: { kind: "ats", result: r, reasons: r.reasons.map((x) => ({ quote: check(x.quote), issue: x.issue })) },
      });
    } else if (id === "gatekeeper") {
      const r = o.gatekeeper;
      if (!r) continue;
      cards.push({
        ...base(r.verdict, r.oneLiner),
        detail: {
          kind: "gatekeeper",
          result: r,
          weakestLines: r.weakestLines.map((x) => ({ quote: check(x.quote), issue: x.issue })),
        },
      });
    } else {
      const r = o[id];
      if (!r) continue;
      cards.push({
        ...base(r.verdict, r.oneLiner),
        detail: {
          kind: "reader",
          result: r,
          worstLine: { quote: check(r.worstLine.quote), issue: r.worstLine.issue },
        },
      });
    }
  }
  return cards;
}

function buildRewrite(rw: StageOutputs["rewrite"], rescreen: StageOutputs["rescreen"] | null): ReportModel["rewrite"] {
  const md = rw.resumeMarkdown;
  return {
    ...rw,
    rescreen,
    rescreenReasons: (rescreen?.reasons ?? []).map((x) => ({
      quote: { text: x.quote, verified: safeVerify(md, x.quote) },
      issue: x.issue,
    })),
  };
}

function buildJd(
  o: Outputs,
  check: (t: string) => CheckedQuote,
  checkJd: (t: string) => CheckedQuote,
): ReportModel["jd"] {
  const analysis = o.jd;
  if (!analysis) return null;
  const fit = o.fit;
  const items = new Map<string, FitItem>();
  for (const item of fit?.items ?? []) {
    if (!items.has(item.requirementId)) items.set(item.requirementId, item);
  }
  const rows: FitRow[] = [
    ...analysis.mustHave.map((requirement) => ({ requirement, priority: "must" as const })),
    ...analysis.niceToHave.map((requirement) => ({ requirement, priority: "nice" as const })),
  ].map(({ requirement, priority }) => {
    const item = items.get(requirement.id) ?? null;
    return {
      requirement,
      jdQuote: analysis.source === "jd" && requirement.jdQuote?.trim() ? checkJd(requirement.jdQuote) : null,
      priority,
      item,
      evidence: item?.evidenceQuote ? check(item.evidenceQuote) : null,
    };
  });
  const counts = { met: 0, partial: 0, missing: 0 };
  for (const row of rows) if (row.item) counts[row.item.status] += 1;
  return {
    analysis,
    rows,
    fitSummary: fit?.summary ?? "",
    untappedStrengths: fit?.untappedStrengths ?? [],
    counts,
  };
}

function buildMistakes(o: Outputs, check: (t: string) => CheckedQuote): MistakeView[] {
  const mistakes = o.synthesis?.mistakes ?? [];
  return [...mistakes]
    .sort((a, b) => a.rank - b.rank)
    .map((m) => {
      const seen = new Set<ReviewerId>();
      const flaggedBy = m.flaggedBy
        .filter((id) => (seen.has(id) ? false : (seen.add(id), true)))
        .map((id) => ({ id, name: REVIEWERS[id].name }));
      return { ...m, quote: m.quote ? check(m.quote) : null, flaggedBy };
    });
}
