import "server-only";
/**
 * 이력서 지원 상태(지원 전·지원 중·지원 완료)와 공고·지원 기록 동기화.
 *
 * changeResumeApplyStatus 규칙(계약):
 * - 공용 이력서(kind='general')는 FeatureError(400, "공용 이력서에는 지원 상태가 없습니다.").
 * - 같은 상태로 바꾸면 아무것도 하지 않고 현재 값을 돌려준다(멱등).
 * - → 'submitted':
 *   - 연결 공고(postingId)가 있으면: 그 공고의 지원 기록(stage가 withdrawn이 아닌 것. 이 이력서 기록 → 이력서 없는 기록 → 다른 이력서 기록 순)을 잇거나,
 *     없으면 applications/service.ts createApplication({ postingId, resumeId, resumeVersionId: currentVersionId, stage: 'applied', ... })으로 만든다
 *     (제출 사본 고정·공고 '지원함'은 createApplication이 한다). 이은 기록에 사본이 없으면 현재 버전으로 고정한다.
 *   - 공고가 없으면 상태만 바꾼다(application null).
 *   - company_resumes.submitted_application_id에 그 기록 id를 적는다.
 * - 'submitted' → 다른 상태(되돌리기, 화면이 확인을 받은 뒤):
 *   - revertPosting: 공고가 지금 '지원함'이면 '지원 예정'으로(다른 상태면 두기).
 *   - revertApplication: 'keep' 그대로 / 'withdraw' 연결 기록을 changeStage(..., 'withdrawn') / 'delete' deleteApplication
 *     (submitted_application_id가 가리키는 기록만. 이 상태 변경이 이은 기존 기록도 같은 규칙).
 *   - submitted_application_id는 'keep'이면 남기고, 나머지는 null.
 * - 상태 행 쓰기는 조건부 UPDATE(읽은 apply_status일 때만)로 동시 클릭을 막는다. 409면 화면이 다시 읽는다.
 *
 * 순서: 상태를 먼저 조건부로 바꿔 '이 요청이 바꿨다'를 확정한 뒤 지원 기록·공고를 맞춘다(동시에 두 번 눌러도 지원 기록은 하나).
 * '지원 완료'로 갈 때 지원 기록 동기화가 실패하면 상태를 원래 값으로 되돌리고 오류를 그대로 던진다.
 */
import { FeatureError } from "@/lib/api/errors";
import {
  changeStage,
  createApplication,
  deleteApplication,
  freezeSubmittedCopy,
  getApplication,
} from "@/lib/applications/service";
import { prisma } from "@/lib/db/client";
import type { CompanyResume } from "@/lib/db/types";
import { POSTING_STATUSES, type PostingStatus } from "@/lib/domain/postings";
import { resumeApplyStatusOf, type ResumeApplyStatus } from "@/lib/domain/resumes";
import { RESUME_INCLUDE, toResumeMeta, type ResumeRow } from "./service";
import type { ChangeResumeStatusInput, ChangeResumeStatusResult } from "./types";

export const GENERAL_RESUME_STATUS_ERROR = "공용 이력서에는 지원 상태가 없습니다.";
export const RESUME_STATUS_CONFLICT = "다른 곳에서 이 이력서의 지원 상태를 먼저 바꿨습니다. 새로고침한 뒤 다시 시도해 주세요.";

type AppLink = ChangeResumeStatusResult["application"];

async function ownedRow(userId: string, resumeId: string): Promise<ResumeRow | null> {
  return ((await prisma.companyResume.findFirst({ where: { id: resumeId, userId }, include: RESUME_INCLUDE })) as ResumeRow | null) ?? null;
}

async function postingStatusOf(userId: string, postingId: string | null): Promise<PostingStatus | null> {
  if (!postingId) return null;
  const p = await prisma.jobPosting.findFirst({ select: { status: true }, where: { id: postingId, userId } });
  if (!p) return null;
  return (POSTING_STATUSES as readonly string[]).includes(p.status) ? (p.status as PostingStatus) : null;
}

async function appLink(userId: string, applicationId: string | null, created = false): Promise<AppLink> {
  if (!applicationId) return null;
  const app = await prisma.application.findFirst({ select: { id: true, stage: true }, where: { id: applicationId, userId } });
  return app ? { id: app.id, created, stage: app.stage } : null;
}

/** 읽은 상태(raw)일 때만 상태를 바꾼다. 바꿨으면 true. */
async function claimStatus(
  userId: string,
  row: CompanyResume,
  next: ResumeApplyStatus,
  extra: { submittedApplicationId?: string | null } = {},
): Promise<boolean> {
  const now = new Date();
  const { count } = await prisma.companyResume.updateMany({
    where: { id: row.id, userId, applyStatus: row.applyStatus ?? null },
    data: { applyStatus: next, applyStatusChangedAt: now, updatedAt: now, ...extra },
  });
  return count > 0;
}

/**
 * '지원 완료' 동기화: 연결 공고의 지원 기록을 잇거나 만든다. 이은(또는 만든) 지원 id와 새로 만들었는지.
 * 이을 후보는 같은 공고의 지원 취소가 아닌 기록이며, 우선순위는
 * ① 이 이력서가 이미 가리키는 기록 ② 이 이력서가 이어진 최신 기록 ③ 이력서가 없는 최신 기록 ④ 다른 이력서가 이어진 최신 기록.
 * (지원 목록에서 이력서 없이 먼저 추적하던 공고를 지원 완료로 바꿔도 기록이 둘로 늘지 않는다.)
 * 다른 이력서의 제출 사본이 이미 있는 기록이면 그 사본은 그대로 둔다.
 */
async function linkApplication(userId: string, row: CompanyResume, postingId: string): Promise<{ id: string; created: boolean }> {
  const candidates = await prisma.application.findMany({
    select: { id: true, stage: true, submittedKey: true, resumeId: true },
    where: { userId, postingId, stage: { not: "withdrawn" } },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  const existing =
    candidates.find((c) => c.id === row.submittedApplicationId) ??
    candidates.find((c) => c.resumeId === row.id) ??
    candidates.find((c) => !c.resumeId) ??
    candidates[0];
  if (!existing) {
    const created = await createApplication(userId, {
      postingId,
      company: "",
      roleTitle: "",
      stage: "applied",
      appliedAt: null,
      nextStep: "",
      nextDate: null,
      note: "",
      favorite: false,
      resumeId: row.id,
      resumeVersionId: row.currentVersionId,
      diagnosisId: null,
    });
    return { id: created.id, created: true };
  }
  if (existing.stage === "interested") {
    // 관심 단계 기록: 지원 단계로 옮긴다(이벤트·지원일·공고 '지원함'·사본 고정은 changeStage가 한다).
    if (existing.resumeId !== row.id && !existing.submittedKey) {
      // 다른 이력서가 이어져 있고 사본이 없으면 이 이력서의 현재 버전으로 먼저 고정한다(있던 사본은 그대로 둔다).
      await freezeSubmittedCopy(userId, existing.id, row.id, row.currentVersionId);
    }
    await changeStage(userId, existing.id, { stage: "applied", note: "이력서를 지원 완료로 바꿈" });
  } else if (!existing.submittedKey) {
    // 이미 지원서를 낸 단계인데 사본이 없으면 이 이력서의 현재 버전으로 고정한다(공고 '지원함'도 맞춘다).
    await freezeSubmittedCopy(userId, existing.id, row.id, row.currentVersionId);
  } else {
    // 사본이 이미 있으면 그대로 두고 공고 상태만 맞춘다(마감·이미 지원함이면 그대로).
    await prisma.jobPosting.updateMany({
      where: { id: postingId, userId, status: { notIn: ["closed", "applied"] } },
      data: { status: "applied", updatedAt: new Date() },
    });
  }
  return { id: existing.id, created: false };
}

export async function changeResumeApplyStatus(
  userId: string,
  resumeId: string,
  input: ChangeResumeStatusInput,
): Promise<ChangeResumeStatusResult | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  if (row.kind === "general") throw new FeatureError(GENERAL_RESUME_STATUS_ERROR, 400);
  const current = resumeApplyStatusOf("company", row.applyStatus);
  const next = input.status;

  if (current === next) {
    return {
      resume: toResumeMeta(row),
      application: await appLink(userId, row.submittedApplicationId),
      postingStatus: await postingStatusOf(userId, row.postingId),
    };
  }

  // ---- → 지원 완료
  if (next === "submitted") {
    if (!(await claimStatus(userId, row, next))) throw new FeatureError(RESUME_STATUS_CONFLICT, 409);
    let link: { id: string; created: boolean } | null = null;
    if (row.postingId) {
      const postingExists = await prisma.jobPosting.count({ where: { id: row.postingId, userId } });
      if (postingExists) {
        try {
          link = await linkApplication(userId, row, row.postingId);
        } catch (err) {
          // 지원 기록을 못 맞췄으면 상태도 되돌린다(이 요청이 바꾼 값일 때만).
          await prisma.companyResume
            .updateMany({
              where: { id: row.id, userId, applyStatus: next },
              data: { applyStatus: row.applyStatus ?? null, applyStatusChangedAt: row.applyStatusChangedAt ?? null },
            })
            .catch(() => undefined);
          throw err;
        }
        await prisma.companyResume.updateMany({ where: { id: row.id, userId }, data: { submittedApplicationId: link.id } });
      }
    }
    const after = (await ownedRow(userId, resumeId))!;
    return {
      resume: toResumeMeta(after),
      application: await appLink(userId, link?.id ?? null, link?.created ?? false),
      postingStatus: await postingStatusOf(userId, row.postingId),
    };
  }

  // ---- 지원 완료 → 다른 상태(되돌리기)
  if (current === "submitted") {
    const appId = row.submittedApplicationId;
    const keep = input.revertApplication === "keep";
    if (!(await claimStatus(userId, row, next, keep ? {} : { submittedApplicationId: null }))) {
      throw new FeatureError(RESUME_STATUS_CONFLICT, 409);
    }
    let application: AppLink = null;
    if (appId) {
      const app = await getApplication(userId, appId);
      if (app && input.revertApplication === "withdraw" && app.stage !== "withdrawn") {
        try {
          await changeStage(userId, appId, { stage: "withdrawn", note: "이력서 지원 상태를 되돌림" });
        } catch (err) {
          // 다른 곳에서 먼저 단계를 바꿨으면 그대로 둔다(상태 되돌리기는 이미 끝났다).
          if (!(err instanceof FeatureError && err.status === 409)) throw err;
        }
      } else if (app && input.revertApplication === "delete") {
        await deleteApplication(userId, appId);
      }
      application = input.revertApplication === "delete" ? null : await appLink(userId, appId);
    }
    if (input.revertPosting && row.postingId) {
      await prisma.jobPosting.updateMany({
        where: { id: row.postingId, userId, status: "applied" },
        data: { status: "planned", updatedAt: new Date() },
      });
    }
    const after = (await ownedRow(userId, resumeId))!;
    return { resume: toResumeMeta(after), application, postingStatus: await postingStatusOf(userId, row.postingId) };
  }

  // ---- 지원 전 ↔ 지원 중: 상태만
  if (!(await claimStatus(userId, row, next))) throw new FeatureError(RESUME_STATUS_CONFLICT, 409);
  const after = (await ownedRow(userId, resumeId))!;
  return {
    resume: toResumeMeta(after),
    application: await appLink(userId, after.submittedApplicationId),
    postingStatus: await postingStatusOf(userId, row.postingId),
  };
}
