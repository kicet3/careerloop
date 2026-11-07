/**
 * 심사 리포트 모델(순수). "JD대로 썼는가"의 근거를 한곳에 모은다:
 *   - 요건 표 행 = 저장된 JD 분석(R…)의 mustHave + niceToHave(모든 요건이 정확히 한 번).
 *   - 요건 충족 여부는 쓴 모델이 아니라 별도 심사 단계 fit의 판정(점수는 scoreFit으로 다시 계산).
 *   - resumeLine은 최종 문서에 실제로 있는 줄만(fit 인용 줄 → 그 요건을 인용한 줄 → 그 요건 근거를 인용한 줄 순).
 *   - 근거 표시는 이름·라벨·경로뿐(노드 id 없음).
 */
import type { JdAnalysis } from "@/lib/domain/schemas";
import { REVIEWER_IDS } from "@/lib/domain/schemas";
import { excludedRefs, linePaths, locateQuote, refsForLine, requirementsForLine } from "./citations";
import type { AgentDraft, AgentReport, ChangeRecord, EvidencePack, FinalPanelStepOutput, ResumeAgentPlan, ReviewRound, StopReason, VerifyReport } from "./schemas";

export function requirementChatPrompt(text: string, context: { company?: string; roleTitle?: string }): string {
  const where = context.company ? ` (${[context.company, context.roleTitle].filter(Boolean).join(" · ")} 공고에서 요구)` : "";
  return `'${text.slice(0, 80)}'${where} 관련 경험을 정리하고 싶어요. 어느 직무나 프로젝트에서 어떻게 했는지 물어봐 주세요.`;
}

export interface ReportInput {
  jd: JdAnalysis;
  pack: EvidencePack;
  plan: ResumeAgentPlan;
  rounds: readonly ReviewRound[];
  chosenRound: number | null;
  /** 최종 문서(인용 포함 — 저장 직전 문서와 같은 줄). */
  draft: AgentDraft;
  /** 라운드별 바뀐 점·요약(revise k → round k). */
  revisions: readonly { round: number; changes: readonly ChangeRecord[]; summary: string; questions: readonly { requirementId: string | null; question: string }[] }[];
  verifies: readonly VerifyReport[];
  finalPanel: FinalPanelStepOutput | null;
  stopReason: StopReason;
  company: string;
  roleTitle: string;
  graphChanged: boolean;
  notes: readonly string[];
  now: Date;
}

export function buildAgentReport(input: ReportInput): AgentReport {
  const { jd, pack, plan, draft } = input;
  const doc = draft.document;
  const chosen = input.rounds.find((r) => r.round === input.chosenRound) ?? input.rounds.at(-1) ?? null;
  const lines = linePaths(doc).filter((l) => l.value.trim() && !/^\s*\[ADD:[^\]]*\]\s*$/.test(l.value));
  const fitOf = new Map((chosen?.fitItems ?? []).map((i) => [i.requirementId, i]));
  const reqRefs = new Map(pack.byRequirement.map((b) => [b.requirementId, new Set(b.refs)]));
  const planOf = new Map(plan.requirementMap.map((r) => [r.requirementId, r]));
  const itemByRef = new Map(pack.items.map((i) => [i.ref, i]));

  const lineFor = (reqId: string, quote: string | null): string | null => {
    const byQuote = locateQuote(doc, quote)[0];
    if (byQuote) return lines.find((l) => l.path === byQuote)?.value ?? null;
    const cited = lines.find((l) => requirementsForLine(draft.citations, l.path).includes(reqId));
    if (cited) return cited.value;
    const refs = new Set([...(reqRefs.get(reqId) ?? []), ...(planOf.get(reqId)?.refs ?? [])]);
    const byRef = lines.find((l) => l.path !== "summary" && refsForLine(draft.citations, l.path).some((r) => refs.has(r)));
    return byRef?.value ?? null;
  };

  const requirements: AgentReport["requirements"] = [
    ...jd.mustHave.map((r) => ({ r, must: true })),
    ...jd.niceToHave.map((r) => ({ r, must: false })),
  ].map(({ r, must }) => {
    const fit = fitOf.get(r.id);
    const status = fit?.status ?? "missing";
    const refs = [...(planOf.get(r.id)?.refs ?? []), ...(reqRefs.get(r.id) ?? [])];
    const evidence = [...new Set(refs)]
      .map((ref) => itemByRef.get(ref))
      .filter((i): i is NonNullable<typeof i> => !!i)
      .slice(0, 4)
      .map((i) => ({ name: i.name, label: i.label, path: i.path }));
    return {
      requirementId: r.id,
      text: r.text,
      must,
      status,
      resumeLine: status === "missing" ? null : lineFor(r.id, fit?.evidenceQuote ?? null),
      evidence,
      inferred: jd.source === "inferred",
    };
  });

  const ctx = { company: input.company || undefined, roleTitle: input.roleTitle || undefined };
  const reqText = new Map([...jd.mustHave, ...jd.niceToHave].map((r) => [r.id, r.text]));
  const gaps: AgentReport["gaps"] = [];
  const seen = new Set<string>();
  const addGap = (requirementId: string | null, question: string) => {
    const key = requirementId ?? question;
    if (seen.has(key) || gaps.length >= 15) return;
    seen.add(key);
    const text = (requirementId && reqText.get(requirementId)) || question;
    gaps.push({ requirementId, question: question.slice(0, 200), chatPrompt: requirementChatPrompt(text, ctx) });
  };
  // 우선순위: 공백 필수 → 공백 우대 → 부분 충족(필수 먼저) → 요건 없는 수정 질문. 최종 판정이 충족(met)인 요건의 질문은 넣지 않는다.
  // 요건별 질문은 전략·수정 단계가 만든 질문이 있으면 그것(전략 먼저), 없으면 기본 문장.
  const questionFor = new Map<string, string>();
  for (const g of plan.gapQuestions) if (!questionFor.has(g.requirementId)) questionFor.set(g.requirementId, g.question);
  for (const rev of input.revisions) for (const q of rev.questions) if (q.requirementId && !questionFor.has(q.requirementId)) questionFor.set(q.requirementId, q.question);
  const ordered = [
    ...requirements.filter((r) => r.status === "missing" && r.must),
    ...requirements.filter((r) => r.status === "missing" && !r.must),
    ...requirements.filter((r) => r.status === "partial" && r.must),
    ...requirements.filter((r) => r.status === "partial" && !r.must),
  ];
  for (const req of ordered) {
    const fallback =
      req.status === "missing"
        ? `${req.text} 경험이 있나요? 있다면 어느 직무·프로젝트에서 했는지 알려 주세요.`
        : `${req.text} 경험을 더 구체적으로 알려 주세요. 어느 직무·프로젝트에서 무엇을 했고 결과가 어땠나요?`;
    addGap(req.requirementId, questionFor.get(req.requirementId) ?? fallback);
  }
  for (const rev of input.revisions) for (const q of rev.questions) if (q.requirementId === null) addGap(null, q.question);

  // '제외' 표시는 실제로 뺀 근거만(넣기로도 한 ref는 제외가 아니다 — 초안·검증과 같은 집합).
  const excludedSet = excludedRefs(plan);
  const factCheck = input.verifies.reduce(
    (a, v) => ({ numbersFlagged: a.numbersFlagged + v.numbersFlagged.length, dropped: a.dropped + v.dropped.length, corrected: a.corrected + v.corrected.length }),
    { numbersFlagged: 0, dropped: 0, corrected: 0 },
  );

  let finalPanel: AgentReport["finalPanel"] = null;
  if (input.finalPanel && chosen) {
    const verdicts = REVIEWER_IDS.map((reviewer) => {
      const fromFinal = input.finalPanel!.verdicts.find((v) => v.reviewer === reviewer);
      if (fromFinal) return fromFinal;
      const core = chosen.verdicts.find((v) => v.reviewer === reviewer);
      return core ? { reviewer, verdict: core.verdict, positive: core.positive, oneLiner: core.oneLiner } : { reviewer, verdict: null, positive: false, oneLiner: "심사 못 함" };
    });
    finalPanel = { passCount: verdicts.filter((v) => v.positive).length, total: 7, verdicts };
  }

  return {
    version: 1,
    jd: { source: jd.source, roleTitle: input.roleTitle || jd.roleTitle, company: input.company || jd.company, mustTotal: jd.mustHave.length, niceTotal: jd.niceToHave.length },
    rounds: input.rounds.map((r) => {
      const rev = input.revisions.find((x) => x.round === r.round);
      return {
        round: r.round,
        passCount: r.passCount,
        passTotal: r.passTotal,
        matchScore: r.matchScore,
        panelScore: r.panelScore,
        atsPass: r.atsPass,
        verdicts: r.verdicts,
        changes: [...(rev?.changes ?? [])].slice(0, 60),
        summary: rev?.summary ?? (r.round === 0 ? "첫 초안" : ""),
      };
    }),
    chosenRound: chosen?.round ?? 0,
    finalPanel,
    stopReason: input.stopReason,
    generatedAt: input.now.toISOString(),
    requirements,
    gaps,
    factCheck,
    excluded: plan.exclude
      .filter((e) => excludedSet.has(e.ref))
      .map((e) => ({ name: itemByRef.get(e.ref)?.name ?? "", reason: e.reason }))
      .filter((e) => e.name)
      .slice(0, 20),
    notes: [...new Set(input.notes)].slice(0, 10),
    graphChanged: input.graphChanged,
  };
}
