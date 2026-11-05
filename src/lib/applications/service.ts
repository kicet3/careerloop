import "server-only";
/**
 * 지원 기록 저장소. 메타는 SQLite(applications·application_events), 제출 사본은 오브젝트 저장소
 * users/<userId>/applications/<id>/submitted.json(ResumeDocument) + submitted-meta.json(양식·이름·버전 번호).
 *
 * - 모든 함수는 userId 소유권을 확인한다. 남의 지원은 null/false(라우트에서 404). 연결하는 공고·이력서·진단도 같은 사용자 것만 받는다.
 * - 단계 변경과 이벤트 기록, 연결된 공고 상태 갱신은 한 batch(트랜잭션)로 쓴다. 단계 변경은 '지금 단계가 읽은 값일 때만'
 *   바꾸고(조건부 UPDATE), 이벤트는 그 UPDATE가 실제로 한 행을 바꿨을 때만(changes() = 1) 넣는다 — 동시에 눌러도 이벤트는 한 번.
 * - 제출 사본 고정: 이력서 버전을 지정하거나 지원서를 낸 단계(SUBMITTED_STAGES)로 들어갈 때 그 버전 본문을 복사한다
 *   (버전을 안 골랐으면 그때의 현재 버전). 원본 이력서를 지워도 사본은 남는다.
 * - 공고 상태: 지원서를 낸 지원이 생기면 공고를 '지원함'으로, 지원을 지워 그 공고의 지원이 하나도 안 남으면 '지원 예정'으로
 *   되돌린다(CareerLoop R-14 수정 — 다만 사용자가 이미 다른 상태로 바꿨다면 건드리지 않는다).
 */
import { and, asc, count, desc, eq, inArray, ne, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { db } from "@/lib/db/client";
import { applicationEvents, applications, diagnoses, diagnosisStages, jobPostings, type ApplicationEventRow, type ApplicationRow } from "@/lib/db/schema";
import {
  SUBMITTED_STAGES,
  type ApplicationCreateInput,
  type ApplicationDetail,
  type ApplicationEvent,
  type ApplicationStage,
  type ApplicationStageInput,
  type ApplicationUpdateInput,
  type JobApplication,
} from "@/lib/domain/applications";
import { DEFAULT_RESUME_TEMPLATE, parseResumeDocument, RESUME_TEMPLATE_IDS, type ResumeDocument, type ResumeTemplateId } from "@/lib/domain/resumes";
import { getResumeMeta, getVersionDocument } from "@/lib/resumes/service";
import { deleteObject, getJson, listByPrefix, putJson, userKey, userPrefix } from "@/lib/storage";
import { kstToday } from "@/lib/time/kst";

// 저장소 키 조각은 영문·숫자로 시작해야 하므로 '-'·'_' 없는 알파벳을 쓴다.
const newId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

export const APPLICATION_NOT_FOUND = "지원 기록을 찾을 수 없습니다.";
/** 사용자당 지원 기록 상한(목록·집계를 한 번에 읽는 크기). */
export const MAX_APPLICATIONS_PER_USER = 1000;

const isSubmitted = (s: ApplicationStage) => SUBMITTED_STAGES.includes(s);

export function toApplication(row: ApplicationRow): JobApplication {
  return {
    id: row.id,
    postingId: row.postingId,
    company: row.company,
    roleTitle: row.roleTitle,
    stage: row.stage,
    appliedAt: row.appliedAt,
    nextStep: row.nextStep ?? "",
    nextDate: row.nextDate,
    note: row.note ?? "",
    favorite: row.favorite,
    resumeId: row.resumeId,
    resumeVersionId: row.resumeVersionId,
    resumeLabel: row.resumeLabel,
    hasSubmittedCopy: !!row.submittedKey,
    diagnosisId: row.diagnosisId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toEvent(row: ApplicationEventRow): ApplicationEvent {
  return {
    id: row.id,
    applicationId: row.applicationId,
    fromStage: row.fromStage,
    toStage: row.toStage,
    note: row.note ?? "",
    at: row.at.getTime(),
  };
}

export function submittedKey(userId: string, applicationId: string): string {
  return userKey(userId, "applications", applicationId, "submitted.json");
}
function submittedMetaKey(userId: string, applicationId: string): string {
  return userKey(userId, "applications", applicationId, "submitted-meta.json");
}

async function ownedRow(userId: string, id: string): Promise<ApplicationRow | null> {
  const [row] = await db
    .select()
    .from(applications)
    .where(and(eq(applications.id, id), eq(applications.userId, userId)))
    .limit(1);
  return row ?? null;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

export async function listApplications(userId: string, opts: { postingId?: string | null } = {}): Promise<JobApplication[]> {
  const rows = await db
    .select()
    .from(applications)
    .where(and(eq(applications.userId, userId), opts.postingId ? eq(applications.postingId, opts.postingId) : undefined))
    .orderBy(desc(applications.updatedAt))
    .limit(MAX_APPLICATIONS_PER_USER);
  return rows.map(toApplication);
}

/** 지원들의 단계 이벤트(시간순). 지원 id 목록이 비면 빈 배열. */
export async function listEvents(applicationIds: string[]): Promise<ApplicationEvent[]> {
  if (applicationIds.length === 0) return [];
  const rows = [];
  // SQLite 바인딩 변수 수 제한을 넘지 않게 나눠 읽는다.
  for (let i = 0; i < applicationIds.length; i += 500) {
    rows.push(
      ...(await db
        .select()
        .from(applicationEvents)
        .where(inArray(applicationEvents.applicationId, applicationIds.slice(i, i + 500)))
        .orderBy(asc(applicationEvents.at), asc(applicationEvents.id))),
    );
  }
  return rows.map(toEvent);
}

export async function getApplication(userId: string, id: string): Promise<ApplicationDetail | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  return { ...toApplication(row), events: await listEvents([row.id]) };
}

export interface SubmittedCopy {
  document: ResumeDocument;
  templateId: ResumeTemplateId;
  /** 사본을 만들 때의 이력서 이름·버전(원본을 지워도 남는다). */
  resumeTitle: string | null;
  versionNo: number | null;
  copiedAt: number | null;
}

/** 고정된 제출 사본. 지원이 남의 것이거나 사본이 없으면 null. */
export async function getSubmittedCopy(userId: string, id: string): Promise<SubmittedCopy | null> {
  const row = await ownedRow(userId, id);
  if (!row?.submittedKey) return null;
  const raw = await getJson(row.submittedKey);
  if (raw === null) return null;
  const parsed = parseResumeDocument(raw);
  if (!parsed.success) throw new FeatureError("저장된 제출 사본 형식이 올바르지 않습니다.", 500);
  const meta = ((await getJson(submittedMetaKey(userId, id)).catch(() => null)) ?? {}) as Record<string, unknown>;
  const templateId = RESUME_TEMPLATE_IDS.find((t) => t === meta.templateId) ?? DEFAULT_RESUME_TEMPLATE;
  return {
    document: parsed.data,
    templateId,
    resumeTitle: typeof meta.resumeTitle === "string" ? meta.resumeTitle : null,
    versionNo: typeof meta.versionNo === "number" ? meta.versionNo : null,
    copiedAt: typeof meta.copiedAt === "number" ? meta.copiedAt : null,
  };
}

// ---------------------------------------------------------------------------
// 연결 확인·제출 사본
// ---------------------------------------------------------------------------

async function ownedPosting(userId: string, postingId: string) {
  const [p] = await db
    .select({ id: jobPostings.id, company: jobPostings.company, roleTitle: jobPostings.roleTitle })
    .from(jobPostings)
    .where(and(eq(jobPostings.id, postingId), eq(jobPostings.userId, userId)))
    .limit(1);
  if (!p) throw new FeatureError("연결할 공고를 찾을 수 없습니다.", 404);
  return p;
}

async function assertOwnedDiagnosis(userId: string, diagnosisId: string): Promise<void> {
  const [d] = await db
    .select({ id: diagnoses.id })
    .from(diagnoses)
    .where(and(eq(diagnoses.id, diagnosisId), eq(diagnoses.userId, userId)))
    .limit(1);
  if (!d) throw new FeatureError("연결할 진단을 찾을 수 없습니다.", 404);
}

interface Snapshot {
  resumeVersionId: string;
  resumeLabel: string;
  submittedKey: string;
}

/**
 * 이력서 버전(생략하면 현재 버전) 본문을 지원의 제출 사본으로 복사한다. 이력서·버전이 남의 것이거나 없으면 FeatureError(404).
 * 키가 지원 id로 정해져 있어 다시 복사하면 덮어쓴다.
 */
async function copySubmitted(userId: string, applicationId: string, resumeId: string, versionId: string | null): Promise<Snapshot> {
  const found = await getVersionDocument(userId, resumeId, versionId);
  if (!found) throw new FeatureError(versionId ? "고른 이력서 버전을 찾을 수 없습니다." : "고른 이력서에 저장된 버전이 없습니다.", 404);
  const key = submittedKey(userId, applicationId);
  await putJson(key, found.document);
  await putJson(submittedMetaKey(userId, applicationId), {
    templateId: found.resume.templateId,
    resumeTitle: found.resume.title,
    versionNo: found.version.versionNo,
    resumeId,
    resumeVersionId: found.version.id,
    copiedAt: Date.now(),
  });
  return {
    resumeVersionId: found.version.id,
    resumeLabel: `${found.resume.title} · v${found.version.versionNo}`.slice(0, 200),
    submittedKey: key,
  };
}

async function removeSubmitted(userId: string, applicationId: string): Promise<void> {
  try {
    for (const k of await listByPrefix(userPrefix(userId, "applications", applicationId))) await deleteObject(k);
  } catch (err) {
    console.error("[applications] 제출 사본 삭제 실패", applicationId, err);
  }
}

/** 공고 상태 갱신 쿼리: 지원서를 낸 지원이 생기면 '지원함'(마감으로 정리한 공고는 그대로). */
function markPostingApplied(userId: string, postingId: string) {
  return db
    .update(jobPostings)
    .set({ status: "applied", updatedAt: new Date() })
    .where(and(eq(jobPostings.id, postingId), eq(jobPostings.userId, userId), ne(jobPostings.status, "closed"), ne(jobPostings.status, "applied")));
}

/** 공고 상태 복원 쿼리: 이 공고에 남은 지원이 없고 지금 '지원함'이면 '지원 예정'으로(R-14). exceptId는 곧 떠날 지원. */
function restorePostingIfOrphan(userId: string, postingId: string, exceptId: string) {
  return db.run(sql`
    UPDATE job_postings SET status = 'planned', updated_at = ${Date.now()}
    WHERE id = ${postingId} AND user_id = ${userId} AND status = 'applied'
      AND NOT EXISTS (SELECT 1 FROM applications WHERE posting_id = ${postingId} AND user_id = ${userId} AND id <> ${exceptId})`);
}

// ---------------------------------------------------------------------------
// 변경
// ---------------------------------------------------------------------------

export async function createApplication(userId: string, input: ApplicationCreateInput): Promise<ApplicationDetail> {
  const [stat] = await db.select({ n: count() }).from(applications).where(eq(applications.userId, userId));
  if ((stat?.n ?? 0) >= MAX_APPLICATIONS_PER_USER) {
    throw new FeatureError(`지원 기록은 ${MAX_APPLICATIONS_PER_USER}건까지 남길 수 있습니다. 오래된 기록을 지워 주세요.`, 409);
  }
  const posting = input.postingId ? await ownedPosting(userId, input.postingId) : null;
  const company = input.company || posting?.company || "";
  const roleTitle = input.roleTitle || posting?.roleTitle || "";
  if (!company || !roleTitle) throw new FeatureError("공고를 고르거나 회사와 직무를 입력하세요.", 400);
  if (input.diagnosisId) await assertOwnedDiagnosis(userId, input.diagnosisId);

  const id = newId();
  const submitted = isSubmitted(input.stage);
  // 버전을 골랐거나 지원서를 낸 단계면 지금 사본을 고정한다(본문을 먼저 쓰고, DB 쓰기가 실패하면 지운다).
  const snap = input.resumeId && (input.resumeVersionId || submitted) ? await copySubmitted(userId, id, input.resumeId, input.resumeVersionId) : null;
  // 관심 단계에서 이력서만 고른 경우: 소유권만 확인하고 이름을 남긴다.
  const titleOnly = input.resumeId && !snap ? await resumeTitleLabel(userId, input.resumeId) : null;
  if (input.resumeId && !snap && !titleOnly) throw new FeatureError("고른 이력서를 찾을 수 없습니다.", 404);
  const now = new Date();
  try {
    await db.batch([
      db.insert(applications).values({
        id,
        userId,
        postingId: posting?.id ?? null,
        company: company.slice(0, 150),
        roleTitle: roleTitle.slice(0, 250),
        stage: input.stage,
        appliedAt: input.appliedAt ?? (submitted ? kstToday(now) : null),
        nextStep: input.nextStep || null,
        nextDate: input.nextDate,
        note: input.note.trim() || null,
        favorite: input.favorite,
        resumeId: input.resumeId,
        resumeVersionId: snap?.resumeVersionId ?? null,
        resumeLabel: snap?.resumeLabel ?? titleOnly,
        submittedKey: snap?.submittedKey ?? null,
        diagnosisId: input.diagnosisId,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(applicationEvents).values({ applicationId: id, fromStage: null, toStage: input.stage, at: now }),
      ...(posting && submitted ? [markPostingApplied(userId, posting.id)] : []),
    ]);
  } catch (err) {
    if (snap) await removeSubmitted(userId, id);
    throw err;
  }
  return (await getApplication(userId, id))!;
}

/** 버전 없이 이력서만 연결할 때의 표시 이름. 남의 이력서·없는 이력서면 null. */
async function resumeTitleLabel(userId: string, resumeId: string): Promise<string | null> {
  const meta = await getResumeMeta(userId, resumeId);
  return meta ? meta.title.slice(0, 200) : null;
}

/** 지원 수정(단계 제외). 남의 지원이면 null. */
export async function updateApplication(userId: string, id: string, patch: ApplicationUpdateInput): Promise<ApplicationDetail | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const set: Partial<typeof applications.$inferInsert> = { updatedAt: new Date() };

  // 공고 연결
  const postingChanged = patch.postingId !== undefined && patch.postingId !== row.postingId;
  const posting = postingChanged && patch.postingId ? await ownedPosting(userId, patch.postingId) : null;
  if (postingChanged) set.postingId = posting?.id ?? null;

  // 회사·직무: 비우면 연결된 공고 값으로, 공고도 없으면 거절.
  const company = patch.company !== undefined ? patch.company || posting?.company || "" : row.company;
  const roleTitle = patch.roleTitle !== undefined ? patch.roleTitle || posting?.roleTitle || "" : row.roleTitle;
  if (!company || !roleTitle) throw new FeatureError("회사와 직무를 입력하세요.", 400);
  if (patch.company !== undefined) set.company = company.slice(0, 150);
  if (patch.roleTitle !== undefined) set.roleTitle = roleTitle.slice(0, 250);

  if (patch.appliedAt !== undefined) set.appliedAt = patch.appliedAt;
  if (patch.nextStep !== undefined) set.nextStep = patch.nextStep || null;
  if (patch.nextDate !== undefined) set.nextDate = patch.nextDate;
  if (patch.note !== undefined) set.note = patch.note.trim() || null;
  if (patch.favorite !== undefined) set.favorite = patch.favorite;
  if (patch.diagnosisId !== undefined) {
    if (patch.diagnosisId) await assertOwnedDiagnosis(userId, patch.diagnosisId);
    set.diagnosisId = patch.diagnosisId;
  }

  // 이력서·버전: 바뀐 경우만 다시 고정한다.
  const resumeId = patch.resumeId !== undefined ? patch.resumeId : row.resumeId;
  const resumeChanged = patch.resumeId !== undefined && patch.resumeId !== row.resumeId;
  // 이력서를 바꾸면서 버전을 안 주면 예전 버전(다른 이력서 것)은 버린다.
  const versionId = patch.resumeVersionId !== undefined ? patch.resumeVersionId : resumeChanged ? null : row.resumeVersionId;
  // 요청에 버전이 들어왔을 때만 검사한다. 원본 이력서를 지운 지원은 resumeId=null인데 resume_version_id(FK 없음)가 남아 있어,
  // 행에서 이어받은 값으로 검사하면 메모·즐겨찾기 같은 무관한 수정까지 막힌다.
  if (patch.resumeVersionId && !resumeId) throw new FeatureError("이력서 버전을 고르려면 이력서도 골라야 합니다.", 400);
  let snap: Snapshot | null = null;
  let dropCopy = false;
  if (!resumeId) {
    if (resumeChanged) {
      // 사용자가 이력서 연결을 지웠다: 기록·사본도 함께 지운다.
      Object.assign(set, { resumeId: null, resumeVersionId: null, resumeLabel: null, submittedKey: null });
      dropCopy = !!row.submittedKey;
    }
  } else if (resumeChanged || versionId !== row.resumeVersionId) {
    if (versionId || isSubmitted(row.stage)) {
      snap = await copySubmitted(userId, id, resumeId, versionId);
      Object.assign(set, { resumeId, ...snap });
    } else {
      const label = await resumeTitleLabel(userId, resumeId);
      if (!label) throw new FeatureError("고른 이력서를 찾을 수 없습니다.", 404);
      Object.assign(set, { resumeId, resumeVersionId: null, resumeLabel: label, submittedKey: null });
      dropCopy = !!row.submittedKey;
    }
  }

  await db.batch([
    db
      .update(applications)
      .set(set)
      .where(and(eq(applications.id, id), eq(applications.userId, userId))),
    ...(postingChanged && row.postingId ? [restorePostingIfOrphan(userId, row.postingId, id)] : []),
    ...(posting && isSubmitted(row.stage) ? [markPostingApplied(userId, posting.id)] : []),
  ]);
  if (dropCopy) await removeSubmitted(userId, id);
  return getApplication(userId, id);
}

/**
 * 단계 변경 + 이벤트(한 batch). 같은 단계면 아무것도 쓰지 않는다. 읽은 뒤 다른 요청이 먼저 단계를 바꿨으면 409.
 * 지원서를 낸 단계로 처음 들어가면 지원일(비어 있으면 오늘)과 제출 사본(이력서가 연결돼 있고 아직 없으면)을 채운다.
 */
export async function changeStage(userId: string, id: string, input: ApplicationStageInput): Promise<ApplicationDetail | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  if (row.stage === input.stage) return getApplication(userId, id);

  const entering = isSubmitted(input.stage);
  const set: Partial<typeof applications.$inferInsert> = { stage: input.stage, updatedAt: new Date() };
  if (entering && !row.appliedAt) set.appliedAt = kstToday();
  if (entering && !row.submittedKey && row.resumeId) {
    try {
      Object.assign(set, await copySubmitted(userId, id, row.resumeId, row.resumeVersionId));
    } catch (err) {
      // 이력서 버전이 사라졌거나 본문을 못 읽어도 단계 변경 자체는 막지 않는다(사본만 없음).
      console.warn("[changeStage] 제출 사본을 고정하지 못했습니다", id, err instanceof Error ? err.message : err);
    }
  }
  const now = Date.now();
  const [updated] = await db.batch([
    db
      .update(applications)
      .set(set)
      .where(and(eq(applications.id, id), eq(applications.userId, userId), eq(applications.stage, row.stage)))
      .returning({ id: applications.id }),
    // 바로 앞 UPDATE가 실제로 한 행을 바꿨을 때만 이벤트를 남긴다(동시 요청이면 한 번만).
    db.run(sql`
      INSERT INTO application_events (application_id, from_stage, to_stage, note, at)
      SELECT ${id}, ${row.stage}, ${input.stage}, ${input.note || null}, ${now} WHERE changes() = 1`),
    ...(entering && row.postingId
      ? [
          db.run(sql`
            UPDATE job_postings SET status = 'applied', updated_at = ${now}
            WHERE id = ${row.postingId} AND user_id = ${userId} AND status NOT IN ('applied', 'closed')
              AND EXISTS (SELECT 1 FROM applications WHERE id = ${id} AND stage = ${input.stage})`),
        ]
      : []),
  ]);
  if (updated.length === 0) throw new FeatureError("다른 곳에서 이 지원의 단계를 먼저 바꿨습니다. 새로고침한 뒤 다시 시도해 주세요.", 409);
  return getApplication(userId, id);
}

/** 지원 삭제(이벤트는 cascade) + 제출 사본 삭제 + 연결된 공고 상태 복원. 남의 지원이면 false. */
export async function deleteApplication(userId: string, id: string): Promise<boolean> {
  const row = await ownedRow(userId, id);
  if (!row) return false;
  const [deleted] = await db.batch([
    db
      .delete(applications)
      .where(and(eq(applications.id, id), eq(applications.userId, userId)))
      .returning({ id: applications.id }),
    ...(row.postingId ? [restorePostingIfOrphan(userId, row.postingId, id)] : []),
  ]);
  if (deleted.length === 0) return false;
  await removeSubmitted(userId, id);
  return true;
}

// ---------------------------------------------------------------------------
// 인사이트 입력
// ---------------------------------------------------------------------------

/**
 * 지원별 적합도 점수(완료 진단의 fit.matchScore). 지원에 진단을 직접 연결했으면 그 진단, 없으면 같은 공고로 받은
 * 가장 최근 완료 진단. 지원 id → 점수.
 */
export async function matchScoresFor(userId: string, apps: readonly JobApplication[]): Promise<Map<string, number>> {
  const postingIds = [...new Set(apps.map((a) => a.postingId).filter((x): x is string => !!x))];
  const directIds = [...new Set(apps.map((a) => a.diagnosisId).filter((x): x is string => !!x))];
  if (postingIds.length === 0 && directIds.length === 0) return new Map();
  const diagRows = await db
    .select({ id: diagnoses.id, postingId: diagnoses.postingId, createdAt: diagnoses.createdAt })
    .from(diagnoses)
    .where(
      and(
        eq(diagnoses.userId, userId),
        eq(diagnoses.status, "done"),
        sql`(${directIds.length ? inArray(diagnoses.id, directIds) : sql`0`} OR ${postingIds.length ? inArray(diagnoses.postingId, postingIds) : sql`0`})`,
      ),
    )
    .orderBy(desc(diagnoses.createdAt))
    .limit(2000);
  if (diagRows.length === 0) return new Map();
  const fits = await db
    .select({ diagnosisId: diagnosisStages.diagnosisId, output: diagnosisStages.output })
    .from(diagnosisStages)
    .where(
      and(
        inArray(
          diagnosisStages.diagnosisId,
          diagRows.map((d) => d.id),
        ),
        eq(diagnosisStages.stage, "fit"),
        eq(diagnosisStages.status, "done"),
      ),
    );
  const scoreByDiag = new Map<string, number>();
  for (const f of fits) {
    const s = (f.output as { matchScore?: unknown } | null)?.matchScore;
    if (typeof s === "number" && Number.isFinite(s)) scoreByDiag.set(f.diagnosisId, s);
  }
  // 공고별 가장 최근(diagRows가 최신순) 점수 있는 진단.
  const latestByPosting = new Map<string, number>();
  for (const d of diagRows) {
    const s = scoreByDiag.get(d.id);
    if (d.postingId && s !== undefined && !latestByPosting.has(d.postingId)) latestByPosting.set(d.postingId, s);
  }
  const out = new Map<string, number>();
  for (const a of apps) {
    const s = (a.diagnosisId ? scoreByDiag.get(a.diagnosisId) : undefined) ?? (a.postingId ? latestByPosting.get(a.postingId) : undefined);
    if (s !== undefined) out.set(a.id, s);
  }
  return out;
}
