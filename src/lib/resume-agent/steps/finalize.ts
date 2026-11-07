import "server-only";
/**
 * 단계 finalize: 최종 라운드 문서(목표 통과 → ATS 통과 → panelScore → 나중 라운드 순, stop.ts chooseBestRound)를 고르고,
 * 이름·메일을 서버가 채우고(이 값은 어떤 LLM 호출에도 들어가지 않았다), 리포트와 저장할 이력서 내용을 만든다.
 * 여기서는 아무것도 저장하지 않는다 — 이력서 생성·작업 완료·알림은 jobs.ts가 리스 안에서 한다(실패해도 고아 이력서가 남지 않게,
 * 만들기 전에 이력서 id를 단계 행에 적어 두고 다음 시도가 회수한다).
 */
import { prisma } from "@/lib/db/client";
import { StoredResumeDocumentSchema, type ResumeDocument } from "@/lib/domain/resumes";
import type { CreateResumeParams } from "@/lib/resumes/service";
import { draftOfRound, evaluateRun, latestDraftRound, parsedOutput, currentPack } from "../next-step";
import { buildAgentReport } from "../report";
import type { AgentReport, StopReason, VerifyReport } from "../schemas";
import { AgentStepError, type StepContext } from "./shared";

export const AGENT_RESUME_NOTE = "경험 그래프 에이전트로 만든 AI 초안";

export interface FinalizePlan {
  /** createResume에 넘길 값(id 제외 — jobs.ts가 정한다). */
  create: Omit<CreateResumeParams, "id">;
  report: AgentReport;
  stopReason: StopReason;
  missingInfo: string[];
}

/** 저장할 이력서·리포트를 만든다(쓰기 없음). 문서 검증·리포트 생성이 실패하면 이력서를 만들기 전에 던진다. */
export async function prepareFinalize(ctx: StepContext, user: { name: string | null; email: string | null }, now: Date): Promise<FinalizePlan> {
  const state = evaluateRun(ctx.rows, { maxRevisions: ctx.settings.maxRevisions, minFit: ctx.settings.minFit, panel: ctx.settings.panel });
  const jd = parsedOutput(ctx.rows, "jd", 0);
  const plan = parsedOutput(ctx.rows, "plan", 0);
  const ret = parsedOutput(ctx.rows, "retrieve", 0);
  const round = state.chosenRound ?? latestDraftRound(ctx.rows);
  const draft = round === null ? null : draftOfRound(ctx.rows, round);
  if (!jd || !plan || !ret || !draft || round === null) throw new AgentStepError("missing_input", "저장할 초안이 없습니다.", false);
  const pack = currentPack(ctx.rows, round) ?? ret.pack;
  const input = ctx.job.input;

  const doc: ResumeDocument = structuredClone(draft.document);
  if (!doc.basics.name.trim() && user.name?.trim()) doc.basics.name = user.name.trim().slice(0, 80);
  const email = doc.basics.email.trim();
  if ((!email || /^\[ADD:[^\]]*\]$/.test(email)) && user.email?.trim()) doc.basics.email = user.email.trim().slice(0, 160);
  const document = StoredResumeDocumentSchema.parse(doc);

  // 그사이 연결할 공고가 지워졌으면 공고 없이 만든다(FK 위반 방지).
  let postingId = input.kind === "general" ? null : (input.postingId ?? null);
  if (postingId && !(await prisma.jobPosting.findFirst({ select: { id: true }, where: { id: postingId, userId: ctx.job.userId } }))) postingId = null;
  const revised = [1, 2].flatMap((k) => {
    const out = parsedOutput(ctx.rows, "revise", k);
    return out ? [{ k, out }] : [];
  });
  const revisions = revised.map(({ k, out }) => ({ round: k, changes: out.changes, summary: out.summary, questions: out.questions }));
  // 사실 검증 요약은 최종 문서까지의 경로(첫 초안 + 선택 라운드까지의 수정)만.
  const verifies: VerifyReport[] = [parsedOutput(ctx.rows, "write_top", 0)!.verify, ...revised.filter((r) => r.k <= round).map((r) => r.out.verify)];
  const finalPanel = parsedOutput(ctx.rows, "final_panel", -1);
  const graphChanged = revised.some((r) => r.out.expand.graphChanged);
  const notes = [
    ...ret.warnings,
    ...(graphChanged ? ["실행 중 경험 그래프가 바뀌어 새 내용으로 이어서 썼습니다."] : []),
    ...draft.notes.slice(0, 4),
  ];
  const report = buildAgentReport({
    jd: jd.jd,
    pack,
    plan: plan.plan,
    rounds: state.rounds,
    chosenRound: state.chosenRound,
    draft: { ...draft, document },
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
  return { create, report, stopReason: report.stopReason, missingInfo };
}
