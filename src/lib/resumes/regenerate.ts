import "server-only";
/**
 * 이미 만든 이력서 '다시 생성'. 빠른 초안 작업(draft-jobs.ts)·그래프 에이전트 작업(resume-agent/jobs.ts)이 새 이력서 대신
 * 대상 이력서(작업 행 target_resume_id)의 새 버전을 저장한다.
 *
 * - 입력은 이력서의 지금 메타(종류·회사·직무·JD·양식·공고)로 만들고, 사용자가 고친 JD·고른 양식·강조할 점만 바꾼다.
 * - 저장할 때 사용자가 직접 쓰는 칸은 현재 버전에서 그대로 가져온다: 지원 동기, 이름·메일·전화·링크·포트폴리오 주소
 *   (현재 값이 비었으면 생성된 값 — 메일은 로그인 메일 기본값). '사진 넣기' 설정은 건드리지 않는다.
 * - 같은 이력서의 진행 중인 다시 생성은 하나만(두 작업 종류에 걸쳐 이력서별 advisory lock 안에서 센다).
 * - 중복 버전 방지: 작업은 저장하기 전에 버전 id를 작업에 적어 두고(pendingVersionId), 다음 시도는 그 버전을 먼저 지운다.
 * - 실행 중에 이력서가 지워졌으면 저장 단계에서 FeatureError(404)로 작업이 실패한다.
 */
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import type { ResumeDocument } from "@/lib/domain/resumes";
import { discardVersion, getVersionDocument, RESUME_NOT_FOUND, saveVersion, updateResumeMeta } from "./service";
import { REGENERATE_VERSION_NOTES, type CreateResumeInput, type RegenerateResumeInput, type ResumeMeta, type ResumeVersionMeta } from "./types";

export type RegenerateMode = "agent" | "single";

export const REGENERATE_RUNNING = "이 이력서를 이미 다시 생성하고 있습니다. 진행 중인 작업이 끝난 뒤 다시 시도해 주세요.";
export const REGENERATE_TARGET_GONE = "다시 생성하는 동안 이력서가 삭제되어 결과를 저장하지 못했습니다.";

export class RegenerateBusyError extends FeatureError {
  constructor(readonly job: { mode: RegenerateMode; id: string }) {
    super(REGENERATE_RUNNING, 409);
    this.name = "RegenerateBusyError";
  }
}

/** 진행 화면 경로. */
export function regenerateJobHref(job: { mode: RegenerateMode; id: string }): string {
  return job.mode === "agent" ? `/app/resumes/agent/${job.id}` : `/app/resumes/drafts/${job.id}`;
}

/** 다시 생성이 끝난 뒤 열 이력서 경로(배너 ?regenerated=1, 에이전트는 리포트도 펼친다). 알림 링크·진행 화면이 같은 값을 쓴다. */
export function regeneratedResumeHref(resumeId: string, mode: RegenerateMode): string {
  return mode === "agent" ? `/app/resumes/${resumeId}?report=1&regenerated=1` : `/app/resumes/${resumeId}?regenerated=1`;
}

/** 작업 표시 이름: "다시 생성 · <이력서 제목>". */
export function regenerateLabel(meta: Pick<ResumeMeta, "title">): string {
  return `다시 생성 · ${meta.title}`.slice(0, 120);
}

/**
 * 다시 생성 작업 입력(CreateResumeInput 모양 — 두 작업이 그대로 쓴다). 출처는 경험 그래프(이력서 내용을 고쳐 쓰는 것이 아니라
 * 그래프에서 다시 쓴다). JD는 고친 값이 있으면 그것, 양식은 고른 값이 있으면 그것.
 */
export function regenerateInputFor(meta: ResumeMeta, body: RegenerateResumeInput, mode: RegenerateMode): CreateResumeInput {
  const general = meta.kind === "general";
  // JD를 실제로 고쳤을 때만 완료 뒤 이력서 JD 칸을 바꾼다(같은 값을 다시 보낸 경우·공용 이력서는 건드리지 않는다).
  const replaceJd = !general && body.jdText !== undefined && body.jdText.trim() !== (meta.jdText ?? "").trim();
  return {
    kind: meta.kind,
    company: general ? "" : meta.company,
    roleTitle: general ? "" : meta.roleTitle,
    jdText: general ? "" : (body.jdText ?? meta.jdText ?? ""),
    templateId: body.templateId ?? meta.templateId,
    title: meta.title,
    source: { kind: "graph" },
    provider: body.provider ?? null,
    postingId: general ? null : meta.postingId,
    sourceResumeId: null,
    mode,
    emphasis: body.note?.trim() || undefined,
    ...(replaceJd ? { replaceJd: true } : {}),
  };
}

/** 같은 이력서의 다시 생성 시작·다시 시도를 줄 세운다(두 작업 종류 공통 — 확인과 행 쓰기가 겹쳐 둘이 함께 통과하지 않게). */
export async function lockRegenerate(tx: Prisma.TransactionClient, resumeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`resume-regenerate:${resumeId}`}))`;
}

/** 이 이력서를 다시 생성 중인 작업(빠른 초안: 멈추지 않은 running, 에이전트: running·waiting). except는 지금 다시 시작하는 작업. */
export async function findActiveRegenerate(
  userId: string,
  resumeId: string,
  opts: { now?: number; db?: Prisma.TransactionClient; exceptDraftJobId?: string; exceptAgentJobId?: string } = {},
): Promise<{ mode: RegenerateMode; id: string } | null> {
  const db = opts.db ?? prisma;
  const now = opts.now ?? Date.now();
  // draft-jobs.ts가 이 모듈을 불러오므로 순환을 피해 실행 때 불러온다.
  const { draftStaleMs } = await import("./draft-jobs");
  const draft = await db.resumeDraftJob.findFirst({
    select: { id: true },
    where: {
      userId,
      targetResumeId: resumeId,
      status: "running",
      startedAt: { gt: new Date(now - draftStaleMs()) },
      ...(opts.exceptDraftJobId ? { id: { not: opts.exceptDraftJobId } } : {}),
    },
  });
  if (draft) return { mode: "single", id: draft.id };
  const agent = await db.resumeAgentJob.findFirst({
    select: { id: true },
    where: { userId, targetResumeId: resumeId, status: { in: ["running", "waiting"] }, ...(opts.exceptAgentJobId ? { id: { not: opts.exceptAgentJobId } } : {}) },
  });
  return agent ? { mode: "agent", id: agent.id } : null;
}

/** 잠금 안에서 확인한다(시작·다시 시도 트랜잭션에서 부른다). 대상 이력서가 없으면 404, 진행 중이면 409. */
export async function assertRegenerateSlot(
  tx: Prisma.TransactionClient,
  userId: string,
  resumeId: string,
  opts: { now: number; exceptDraftJobId?: string; exceptAgentJobId?: string },
): Promise<void> {
  await lockRegenerate(tx, resumeId);
  const owned = await tx.companyResume.findFirst({ select: { id: true }, where: { id: resumeId, userId } });
  if (!owned) throw new FeatureError(RESUME_NOT_FOUND, 404);
  const busy = await findActiveRegenerate(userId, resumeId, { ...opts, db: tx });
  if (busy) throw new RegenerateBusyError(busy);
}

const filled = (v: string | null | undefined) => {
  const t = (v ?? "").trim();
  return t !== "" && !/^\[ADD:[^\]]*\]$/.test(t);
};

/**
 * 생성된 문서에 현재 버전의 사용자 칸을 덮는다(순수). 지원 동기는 현재 값이 있으면 그것(비었으면 생성기 초안 — 에이전트 v2),
 * 이름·메일·전화·포트폴리오 주소는 현재 값이 있으면 그것, 링크는 현재 링크가 있으면 그것.
 */
export function preserveUserFields(generated: ResumeDocument, current: ResumeDocument | null): ResumeDocument {
  if (!current) return generated;
  const out = structuredClone(generated);
  out.motivation = current.motivation?.trim() ? current.motivation : (generated.motivation ?? "");
  const b = out.basics;
  const c = current.basics;
  if (filled(c.name)) b.name = c.name;
  if (filled(c.email)) b.email = c.email;
  if (filled(c.phone)) b.phone = c.phone;
  if (filled(c.portfolioUrl)) b.portfolioUrl = c.portfolioUrl;
  if (c.links.length > 0) b.links = structuredClone(c.links);
  return out;
}

/**
 * 다시 생성 결과를 대상 이력서의 새 버전으로 저장한다(source 'ai', 메모 REGENERATE_VERSION_NOTES[mode], 고른 양식도 함께).
 * versionId는 작업에 미리 적어 둔 값. 작업본(임시 저장본)은 지우지 않는다 — 편집 화면이 기준 버전이 바뀐 것을 충돌로 알린다.
 * 이력서가 없으면(그사이 삭제) FeatureError(404).
 */
export async function saveRegeneratedVersion(
  userId: string,
  resumeId: string,
  generated: ResumeDocument,
  opts: { mode: RegenerateMode; versionId: string; templateId: CreateResumeInput["templateId"] },
): Promise<ResumeVersionMeta> {
  // 읽은 현재 버전을 기준(baseVersionId)으로 저장한다: 읽은 뒤 사용자가 새 버전을 저장했으면(지원 동기·연락처를 고쳤을 수 있다)
  // 그 버전에서 다시 읽어 보존한다 — 오래된 값으로 사용자의 저장을 덮지 않게. 계속 겹치면 마지막에 기준 없이 저장한다.
  for (let attempt = 0; ; attempt++) {
    const row = await prisma.companyResume.findFirst({ select: { currentVersionId: true }, where: { id: resumeId, userId } });
    if (!row) throw new FeatureError(REGENERATE_TARGET_GONE, 404);
    let current: ResumeDocument | null = null;
    try {
      current = (await getVersionDocument(userId, resumeId, row.currentVersionId))?.document ?? null;
    } catch (err) {
      // 현재 버전 본문이 저장소에서 사라졌거나 깨졌으면 보존할 값 없이 저장한다.
      if (!(err instanceof FeatureError)) throw err;
    }
    const last = attempt >= REGENERATE_SAVE_ATTEMPTS - 1;
    try {
      const version = await saveVersion(userId, resumeId, preserveUserFields(generated, current), {
        source: "ai",
        note: REGENERATE_VERSION_NOTES[opts.mode],
        templateId: opts.templateId,
        versionId: opts.versionId,
        ...(last ? {} : { baseVersionId: row.currentVersionId }),
      });
      if (!version) throw new FeatureError(REGENERATE_TARGET_GONE, 404);
      return version;
    } catch (err) {
      // 기준 버전이 바뀌었거나 다른 저장이 먼저 번호를 예약했다(409) — 지금 버전에서 다시 읽어 저장한다(버전 수 한도면 마지막에 같은 409로 끝난다).
      if (last || !(err instanceof FeatureError) || err.status !== 409) throw err;
    }
  }
}

/** 기준 버전이 겹칠 때 다시 읽어 저장하는 횟수(마지막은 기준 없이). */
const REGENERATE_SAVE_ATTEMPTS = 3;

/** 이전 시도가 남긴(완료 기록 전에 끊긴) 버전을 지운다. 실패해도 던지지 않는다. */
export async function discardRegeneratedVersion(userId: string, resumeId: string, versionId: string): Promise<void> {
  try {
    await discardVersion(userId, resumeId, versionId);
  } catch (err) {
    console.error("[resume regenerate] 버려진 버전 삭제 실패", resumeId, (err as Error)?.name);
  }
}

/**
 * 완료 기록 뒤: 고친 JD를 이력서 JD 칸에 반영한다(지원처별 이력서에서 사용자가 JD를 고쳤을 때만 — replaceJd). 실패해도 던지지 않는다.
 * JD를 고치지 않았으면 건드리지 않는다: 에이전트 작업은 저장 입력의 JD를 잘라 두므로 비교만으로 반영하면 긴 JD가 잘린다.
 */
export async function applyRegeneratedMeta(userId: string, resumeId: string, input: Pick<CreateResumeInput, "kind" | "jdText" | "replaceJd">): Promise<void> {
  if (input.kind === "general" || !input.replaceJd) return;
  try {
    const meta = await prisma.companyResume.findFirst({ select: { jdText: true }, where: { id: resumeId, userId } });
    if (!meta) return;
    const next = input.jdText.trim() || null;
    if ((meta.jdText?.trim() || null) !== next) await updateResumeMeta(userId, resumeId, { jdText: next });
  } catch (err) {
    console.error("[resume regenerate] JD 반영 실패", resumeId, (err as Error)?.name);
  }
}
