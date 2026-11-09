import "server-only";
/**
 * 단계 finalize: 최종 라운드 문서(목표 통과 → ATS 통과 → panelScore → 나중 라운드 순, stop.ts chooseBestRound)를 고르고,
 * 이름·메일을 서버가 채우고(이 값은 어떤 LLM 호출에도 들어가지 않았다), 리포트와 저장할 이력서 내용을 만든다.
 * 여기서는 아무것도 저장하지 않는다 — 이력서 생성·작업 완료·알림은 jobs.ts가 리스 안에서 한다(실패해도 고아 이력서가 남지 않게,
 * 만들기 전에 이력서 id를 단계 행에 적어 두고 다음 시도가 회수한다).
 */
import { prisma } from "@/lib/db/client";
import { StoredResumeDocumentSchema, type ResumeDocument } from "@/lib/domain/resumes";
import { extrasPathMapper, isNewcomerDocument, normalizeExtras } from "@/lib/resumes/extras-guide";
import { honorificLeftoverNote, normalizeDocumentHonorific } from "@/lib/resumes/honorific";
import type { CreateResumeParams } from "@/lib/resumes/service";
import type { MotivationSuggestResponse } from "@/lib/domain/resume-motivation";
import { MOTIVATION_DRAFT_MAX } from "@/lib/domain/resume-motivation";
import { SECTION_IDS, SECTION_LABELS, sectionStepKey, WRITING_SECTIONS } from "../job-types";
import { parsedOutput, type StepRowLike } from "../next-step";
import { composeOf, critiqueOf, isMotivationSection, sectionOutput, sectionOutputAt } from "../next-step-v2";
import { draftAt, evaluateAny, latestRound, packAt, pipelineOf, planOf } from "../pipeline";
import { buildAgentReport } from "../report";
import type { AgentReport, ChangeRecord, EvidencePack, StopReason, VerifyReport } from "../schemas";
import { humanizeRefs } from "../sections/common";
import { AgentStepError, type StepContext } from "./shared";

export const AGENT_RESUME_NOTE = "경험 그래프 에이전트로 만든 AI 초안";

export interface FinalizePlan {
  /** createResume에 넘길 값(id 제외 — jobs.ts가 정한다). */
  create: Omit<CreateResumeParams, "id">;
  report: AgentReport;
  stopReason: StopReason;
  missingInfo: string[];
  /** v2: 지원 동기 추천(에이전트가 미리 계산 — 완료 기록 때 이력서의 마지막 추천으로 저장한다). */
  motivationSuggestion: MotivationSuggestResponse["suggestion"] | null;
}

/** 저장할 이력서·리포트를 만든다(쓰기 없음). 문서 검증·리포트 생성이 실패하면 이력서를 만들기 전에 던진다. */
export async function prepareFinalize(ctx: StepContext, user: { name: string | null; email: string | null }, now: Date): Promise<FinalizePlan> {
  const version = pipelineOf(ctx.pipeline);
  const input = ctx.job.input;
  const state = evaluateAny(ctx.rows, { version, settings: ctx.settings, company: input.kind === "company" });
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const plan = planOf(ctx.rows, version);
  const ret = parsedOutput(ctx.rows, "retrieve", 0);
  const round = state.chosenRound ?? latestRound(ctx.rows, version);
  const draft = round === null ? null : draftAt(ctx.rows, version, round);
  if (!jd || !plan || !ret || !draft || round === null) throw new AgentStepError("missing_input", "저장할 초안이 없습니다.", false);
  const pack = packAt(ctx.rows, version, round) ?? ret.pack;

  const doc: ResumeDocument = structuredClone(draft.document);
  if (!doc.basics.name.trim() && user.name?.trim()) doc.basics.name = user.name.trim().slice(0, 80);
  const email = doc.basics.email.trim();
  if ((!email || /^\[ADD:[^\]]*\]$/.test(email)) && user.email?.trim()) doc.basics.email = user.email.trim().slice(0, 160);
  // 수상·기타 묶음 규칙(빈 묶음 생략, 2개 이하면 '수상·기타' 하나, 경력자/신입 순서, 묶음 안 최신순).
  // 신입 판정은 단일 초안·verify(extrasMissingQuestions)와 같은 규칙(경력 항목 없음)을 쓴다.
  // 묶음이 합쳐지거나 순서가 바뀌므로, 리포트가 읽는 인용 경로(extras[i].items[j])를 정리 뒤 문서에 맞춘다.
  const extrasBefore = doc.extras;
  doc.extras = normalizeExtras(doc.extras, { newcomer: isNewcomerDocument(doc) }).extras;
  const remap = extrasPathMapper(extrasBefore, doc.extras);
  const citations = draft.citations.flatMap((c) => {
    const path = remap(c.path);
    return path === null ? [] : [{ ...c, path }];
  });
  // 지원 동기: v1은 비워 둔다. v2 지원처별 이력서는 검증된 초안([ADD] 자리표시 포함)을 넣는다 — 사용자가 다듬는다.
  const motivationOn = version === 2 && input.kind === "company" && ctx.settings.motivation !== false;
  // 고른 라운드 이하의 가장 최근 초안(총괄 피드백·바뀐 본문으로 다시 쓴 초안이 있으면 그것).
  const motivationAt = motivationOn ? sectionOutputAt(ctx.rows, "motivation_draft", round) : null;
  const motivationDraft = motivationAt?.output.fragment.motivation ?? "";
  doc.motivation = motivationDraft;
  // 문장 끝 경어체 통일(v1·v2 공통, 결정적 — 줄 수·경로는 그대로라 인용 경로가 바뀌지 않는다). 판단할 수 없는 평어체는 리포트 notes로.
  const honorific = normalizeDocumentHonorific(doc);
  const honorificNote = honorificLeftoverNote(honorific.leftovers);
  const document = StoredResumeDocumentSchema.parse(honorific.document);

  // 그사이 연결할 공고가 지워졌으면 공고 없이 만든다(FK 위반 방지).
  let postingId = input.kind === "general" ? null : (input.postingId ?? null);
  if (postingId && !(await prisma.jobPosting.findFirst({ select: { id: true }, where: { id: postingId, userId: ctx.job.userId } }))) postingId = null;
  let revisions: { round: number; changes: ChangeRecord[]; summary: string; questions: { requirementId: string | null; question: string }[] }[];
  let verifies: VerifyReport[];
  let graphChanged: boolean;
  if (version === 2) {
    revisions = [1, 2].flatMap((k) => {
      const crit = critiqueOf(ctx.rows, k - 1);
      if (!crit || !composeOf(ctx.rows, k)) return [];
      const changes = WRITING_SECTIONS.flatMap((s) => sectionOutput(ctx.rows, s, k)?.changes ?? []).slice(0, 60);
      return [{ round: k, changes, summary: humanizeRefs(crit.summary, pack), questions: crit.questions }];
    });
    // 첫 질문 묶음(라운드 0 critique)은 라운드 1이 없어도 리포트 공백에 넣는다.
    const crit0 = critiqueOf(ctx.rows, 0);
    if (crit0 && !revisions.some((r) => r.round === 1)) revisions.push({ round: 1, changes: [], summary: "", questions: crit0.questions });
    verifies = [0, 1, 2].filter((k) => k <= round).flatMap((k) => (composeOf(ctx.rows, k) ? [composeOf(ctx.rows, k)!.verify] : []));
    graphChanged = [0, 1].some((k) => critiqueOf(ctx.rows, k)?.expand.graphChanged ?? false);
  } else {
    const revised = [1, 2].flatMap((k) => {
      const out = parsedOutput(ctx.rows, "revise", k);
      return out ? [{ k, out }] : [];
    });
    revisions = revised.map(({ k, out }) => ({ round: k, changes: out.changes, summary: out.summary, questions: out.questions }));
    // 사실 검증 요약은 최종 문서까지의 경로(첫 초안 + 선택 라운드까지의 수정)만.
    verifies = [parsedOutput(ctx.rows, "write_top", 0)!.verify, ...revised.filter((r) => r.k <= round).map((r) => r.out.verify)];
    graphChanged = revised.some((r) => r.out.expand.graphChanged);
  }
  const finalPanel = parsedOutput(ctx.rows, "final_panel", -1);
  const notes = [
    ...ret.warnings,
    ...(graphChanged ? ["실행 중 경험 그래프가 바뀌어 새 내용으로 이어서 썼습니다."] : []),
    ...draft.notes.slice(0, 4),
    ...(honorificNote && !draft.notes.slice(0, 4).includes(honorificNote) ? [honorificNote] : []),
  ];
  const base = buildAgentReport({
    jd: jd.jd,
    pack,
    plan,
    rounds: state.rounds,
    chosenRound: state.chosenRound,
    draft: { ...draft, document, citations },
    revisions,
    verifies,
    finalPanel: state.finalPanel === "done" ? finalPanel : null,
    stopReason: state.stopReason ?? "max_rounds",
    company: input.kind === "general" ? "" : input.company,
    roleTitle: input.kind === "general" ? "" : input.roleTitle,
    graphChanged,
    notes,
    now,
  });
  const suggestion = motivationOn ? (sectionOutput(ctx.rows, "motivation_suggest", 0)?.suggestion ?? null) : null;
  const report: AgentReport =
    version === 2
      ? {
          ...base,
          version: 2,
          sections: sectionReport(ctx.rows, round, pack, motivationOn, motivationDraft),
          orchestration: [0, 1].flatMap((k) => {
            const c = critiqueOf(ctx.rows, k);
            if (!c) return [];
            return [{ round: k, summary: humanizeRefs(c.summary, pack), feedback: [...c.feedback.map((f) => ({ section: SECTION_LABELS[f.section], instructions: f.instructions.map((x) => humanizeRefs(x, pack)).filter(Boolean) })), ...(c.composeFeedback.length ? [{ section: "요약·상단", instructions: c.composeFeedback.map((x) => humanizeRefs(x, pack)) }] : [])] }];
          }),
          motivation: input.kind === "company" ? { drafted: motivationDraft.trim().length > 0, placeholders: (motivationDraft.match(/\[ADD:[^\]]*\]/g) ?? []).length, suggestionSaved: suggestion !== null } : null,
          jdReused: jd.reusedFrom,
        }
      : base;
  const missingInfo = [...new Set([...report.gaps.map((g) => g.question), ...draft.missingInfo])].slice(0, 10);
  const create: FinalizePlan["create"] = {
    kind: input.kind,
    company: input.company,
    roleTitle: input.roleTitle,
    jdText: input.jdText,
    templateId: input.templateId,
    title: input.title,
    document,
    source: "ai",
    postingId,
    note: AGENT_RESUME_NOTE,
  };
  return { create, report, stopReason: report.stopReason, missingInfo, motivationSuggestion: suggestion };
}

/** v2 리포트 '구역별 작성' 표. */
function sectionReport(rows: readonly StepRowLike[], round: number, pack: EvidencePack, motivationOn: boolean, motivationDraft: string): NonNullable<AgentReport["sections"]> {
  const brief = parsedOutput(rows, "brief", 0)?.brief;
  const compose = composeOf(rows, round);
  const scores = new Map<string, number | null>();
  for (const k of [0, 1]) for (const s of critiqueOf(rows, k)?.sectionScores ?? []) if (s.score !== null) scores.set(s.section, s.score);
  return SECTION_IDS.flatMap((s) => {
    if (isMotivationSection(s)) {
      if (!motivationOn) return [];
      const row = rows.find((r) => r.key === sectionStepKey(s, 0));
      const at = s === "motivation_draft" ? sectionOutputAt(rows, s, round) : null;
      const out = at?.output ?? sectionOutput(rows, s, 0);
      const rewrites = s === "motivation_draft" ? [1, 2].filter((k) => k <= round && sectionOutput(rows, s, k)).length : 0;
      return [
        {
          section: s,
          label: SECTION_LABELS[s],
          requirementIds: [],
          finalRound: at?.round ?? 0,
          rewrites,
          score: null,
          chars: s === "motivation_draft" ? motivationDraft.length : 0,
          budget: s === "motivation_draft" ? MOTIVATION_DRAFT_MAX : 0,
          fallback: (row?.status === "failed" && !at) || !out,
          notes: [],
        },
      ];
    }
    const used = compose?.sectionsUsed.find((u) => u.section === s);
    const out = used ? sectionOutput(rows, s, used.round) : null;
    const budget = compose?.budgetReport.find((b) => b.section === s);
    const rewrites = [1, 2].filter((k) => k <= round && rows.some((r) => r.key === sectionStepKey(s, k) && r.status === "done")).length;
    return [
      {
        section: s,
        label: SECTION_LABELS[s],
        requirementIds: brief?.assignments.find((a) => a.section === s)?.primaryRequirementIds ?? [],
        finalRound: used?.round ?? 0,
        rewrites,
        score: scores.get(s) ?? null,
        chars: budget?.chars ?? 0,
        budget: budget?.budget ?? 0,
        fallback: (used?.fallback ?? false) || (out?.fallback ?? null) !== null,
        notes: (out?.notes ?? []).map((n) => humanizeRefs(n, pack)).slice(0, 5),
      },
    ];
  });
}
