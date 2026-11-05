import "server-only";
/**
 * 회사별 이력서 저장소. 메타·버전 목록은 SQLite(company_resumes·resume_versions), 버전 본문(ResumeDocument JSON)은
 * 오브젝트 저장소 users/<userId>/resumes/<resumeId>/v<n>.json(R2 또는 로컬 폴백).
 *
 * - 모든 함수는 userId 소유권을 확인한다. 남의 이력서는 null/false(라우트에서 404).
 * - 저장할 때마다 새 버전(n+1)을 만든다. 버전 번호를 한 문장으로 먼저 예약(행 insert)하고, 본문을 쓴 뒤 현재 버전을 옮긴다.
 *   본문을 못 쓰면 예약한 행을 지운다.
 * - 복원은 고른 버전의 본문을 새 버전으로 복사한다(이력이 한 줄로 이어진다).
 */
import { and, count, desc, eq, inArray, max, sql } from "drizzle-orm";
import { customAlphabet } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { db } from "@/lib/db/client";
import { companyResumes, resumeVersions, type CompanyResume, type ResumeVersion } from "@/lib/db/schema";
import { parseResumeDocument, ResumeDocumentSchema, type ResumeDocument, type ResumeTemplateId, type ResumeVersionSource } from "@/lib/domain/resumes";
import { deleteObject, getJson, listByPrefix, putJson, userKey, userPrefix } from "@/lib/storage";
import {
  MAX_RESUMES_PER_USER,
  MAX_VERSIONS_PER_RESUME,
  type ResumeDetail,
  type ResumeListItem,
  type ResumeMeta,
  type ResumeVersionMeta,
  type UpdateResumeMeta,
} from "./types";

// 저장소 키 조각은 영문·숫자로 시작해야 하므로 '-'·'_' 없는 알파벳을 쓴다.
const newId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

export const RESUME_NOT_FOUND = "이력서를 찾을 수 없습니다.";

export function toResumeMeta(row: CompanyResume): ResumeMeta {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.roleTitle,
    jdText: row.jdText,
    templateId: row.templateId,
    title: row.title,
    currentVersionId: row.currentVersionId,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toVersionMeta(row: ResumeVersion): ResumeVersionMeta {
  return { id: row.id, versionNo: row.versionNo, note: row.note, source: row.source, createdAt: row.createdAt.getTime() };
}

export function versionStorageKey(userId: string, resumeId: string, versionNo: number): string {
  return userKey(userId, "resumes", resumeId, `v${versionNo}.json`);
}

async function ownedRow(userId: string, resumeId: string): Promise<CompanyResume | null> {
  const [row] = await db
    .select()
    .from(companyResumes)
    .where(and(eq(companyResumes.id, resumeId), eq(companyResumes.userId, userId)))
    .limit(1);
  return row ?? null;
}

export function defaultResumeTitle(company: string, roleTitle: string): string {
  return `${company} ${roleTitle}`.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

export async function listResumes(userId: string): Promise<ResumeListItem[]> {
  const rows = await db
    .select()
    .from(companyResumes)
    .where(eq(companyResumes.userId, userId))
    .orderBy(desc(companyResumes.updatedAt))
    .limit(MAX_RESUMES_PER_USER);
  if (rows.length === 0) return [];
  const stats = await db
    .select({ resumeId: resumeVersions.resumeId, n: count(), latest: max(resumeVersions.versionNo) })
    .from(resumeVersions)
    .where(
      inArray(
        resumeVersions.resumeId,
        rows.map((r) => r.id),
      ),
    )
    .groupBy(resumeVersions.resumeId);
  const currentIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
  const currentNos = currentIds.length
    ? await db
        .select({ id: resumeVersions.id, versionNo: resumeVersions.versionNo })
        .from(resumeVersions)
        .where(inArray(resumeVersions.id, currentIds))
    : [];
  const statBy = new Map(stats.map((s) => [s.resumeId, s]));
  const noBy = new Map(currentNos.map((v) => [v.id, v.versionNo]));
  return rows.map((r) => ({
    ...toResumeMeta(r),
    versionCount: statBy.get(r.id)?.n ?? 0,
    currentVersionNo: r.currentVersionId ? (noBy.get(r.currentVersionId) ?? null) : null,
  }));
}

export async function getResumeMeta(userId: string, resumeId: string): Promise<ResumeMeta | null> {
  const row = await ownedRow(userId, resumeId);
  return row ? toResumeMeta(row) : null;
}

async function versionRows(resumeId: string): Promise<ResumeVersion[]> {
  return db.select().from(resumeVersions).where(eq(resumeVersions.resumeId, resumeId)).orderBy(desc(resumeVersions.versionNo));
}

export async function listVersions(userId: string, resumeId: string): Promise<ResumeVersionMeta[] | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  return (await versionRows(resumeId)).map(toVersionMeta);
}

async function readDocument(storageKey: string): Promise<ResumeDocument> {
  const raw = await getJson(storageKey);
  if (raw === null) throw new FeatureError("저장된 이력서 본문을 찾지 못했습니다. 다른 버전을 복원해 주세요.", 404);
  // 필드가 늘기 전에 저장한 버전도 열리게 보정한 뒤 검증한다.
  const parsed = parseResumeDocument(raw);
  if (!parsed.success) throw new FeatureError("저장된 이력서 본문 형식이 올바르지 않습니다.", 500);
  return parsed.data;
}

/** 메타 + 버전 목록 + 현재 버전 본문. 남의 이력서면 null. */
export async function getResumeDetail(userId: string, resumeId: string): Promise<ResumeDetail | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  const versions = await versionRows(resumeId);
  const cur = versions.find((v) => v.id === row.currentVersionId) ?? versions[0];
  return {
    resume: toResumeMeta(row),
    versions: versions.map(toVersionMeta),
    current: cur ? { versionId: cur.id, versionNo: cur.versionNo, document: await readDocument(cur.storageKey) } : null,
  };
}

/** 특정 버전(생략하면 현재 버전) 본문. 이력서가 남의 것이거나 버전이 없으면 null. */
export async function getVersionDocument(
  userId: string,
  resumeId: string,
  versionId?: string | null,
): Promise<{ resume: ResumeMeta; version: ResumeVersionMeta; document: ResumeDocument } | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  const wanted = versionId || row.currentVersionId;
  let version: ResumeVersion | undefined;
  if (wanted) {
    [version] = await db
      .select()
      .from(resumeVersions)
      .where(and(eq(resumeVersions.id, wanted), eq(resumeVersions.resumeId, resumeId)))
      .limit(1);
  } else {
    [version] = await versionRows(resumeId);
  }
  if (!version) return null;
  return { resume: toResumeMeta(row), version: toVersionMeta(version), document: await readDocument(version.storageKey) };
}

// ---------------------------------------------------------------------------
// 변경
// ---------------------------------------------------------------------------

function isUniqueViolation(err: unknown): boolean {
  const e = err as { message?: unknown; cause?: { message?: unknown } } | null;
  return /UNIQUE constraint failed/i.test(`${String(e?.message ?? "")} ${String(e?.cause?.message ?? "")}`);
}

export interface SaveVersionOptions {
  source: ResumeVersionSource;
  note?: string | null;
  /** 지정하면 현재 버전이 이것과 같을 때만 저장(다른 탭의 저장을 덮어쓰지 않게). */
  baseVersionId?: string | null;
}

/**
 * 버전 번호 예약: 소유권·기준 버전·버전 수 한도를 조건으로 한 INSERT … SELECT 한 문장.
 * SQLite에서 한 문장은 원자적이라 동시 저장도 서로 다른 번호를 받는다(대화형 트랜잭션의 잠금 경합이 없다).
 * 조건에 걸려 아무것도 넣지 못했으면 null.
 */
async function reserveVersion(userId: string, resumeId: string, opts: SaveVersionOptions): Promise<ResumeVersion | null> {
  // 키 형식 검사를 먼저 통과시킨 뒤, 번호만 SQL에서 붙인다.
  const keyPrefix = versionStorageKey(userId, resumeId, 1).slice(0, -"1.json".length);
  const id = newId();
  const baseCond =
    opts.baseVersionId === undefined
      ? sql``
      : opts.baseVersionId === null
        ? sql` AND r.current_version_id IS NULL`
        : // 기준 버전이 현재 포인터이고, 그보다 새 번호가 아직 예약되지 않았을 때만(본문 쓰기 중인 다른 저장도 막는다).
          sql` AND r.current_version_id = ${opts.baseVersionId} AND NOT EXISTS (
            SELECT 1 FROM resume_versions nv WHERE nv.resume_id = r.id
              AND nv.version_no > (SELECT bv.version_no FROM resume_versions bv WHERE bv.id = ${opts.baseVersionId}))`;
  const rows = await db.all<{ id: string }>(sql`
    INSERT INTO resume_versions (id, resume_id, version_no, storage_key, note, source)
    SELECT ${id}, r.id, n.next_no, ${keyPrefix} || n.next_no || '.json', ${opts.note?.trim() || null}, ${opts.source}
    FROM company_resumes r,
      (SELECT COALESCE(MAX(version_no), 0) + 1 AS next_no, COUNT(*) AS total FROM resume_versions WHERE resume_id = ${resumeId}) n
    WHERE r.id = ${resumeId} AND r.user_id = ${userId} AND n.total < ${MAX_VERSIONS_PER_RESUME}${baseCond}
    RETURNING id`);
  if (rows.length === 0) return null;
  const [row] = await db.select().from(resumeVersions).where(eq(resumeVersions.id, id)).limit(1);
  return row ?? null;
}

/** 새 버전을 저장하고 현재 버전으로 삼는다. 남의 이력서면 null. */
export async function saveVersion(
  userId: string,
  resumeId: string,
  document: ResumeDocument,
  opts: SaveVersionOptions,
): Promise<ResumeVersionMeta | null> {
  const doc = ResumeDocumentSchema.parse(document);
  let reserved: ResumeVersion | null;
  try {
    reserved = await reserveVersion(userId, resumeId, opts);
  } catch (err) {
    if (isUniqueViolation(err)) throw new FeatureError("동시에 저장한 요청이 있습니다. 잠시 후 다시 저장해 주세요.", 409);
    throw err;
  }
  if (!reserved) {
    // 왜 못 넣었는지 가려서 알려 준다.
    const row = await ownedRow(userId, resumeId);
    if (!row) return null;
    const [stat] = await db.select({ n: count() }).from(resumeVersions).where(eq(resumeVersions.resumeId, resumeId));
    if (opts.baseVersionId !== undefined && (stat?.n ?? 0) < MAX_VERSIONS_PER_RESUME) {
      // 기준 버전이 현재가 아니거나, 다른 저장이 그보다 새 번호를 먼저 예약했다.
      throw new FeatureError("다른 곳에서 이 이력서를 먼저 저장했습니다. 새로고침한 뒤 다시 저장해 주세요.", 409);
    }
    throw new FeatureError(`버전은 이력서당 ${MAX_VERSIONS_PER_RESUME}개까지 저장할 수 있습니다. 새 이력서를 만들어 주세요.`, 409);
  }

  try {
    await putJson(reserved.storageKey, doc);
  } catch (err) {
    // 본문을 못 쓴 버전 행은 지운다(목록에 깨진 버전이 남지 않게).
    await db.delete(resumeVersions).where(eq(resumeVersions.id, reserved.id));
    throw err;
  }
  // 포인터는 앞으로만 옮긴다: 더 새 번호가 이미 현재 버전이면(본문 쓰기가 늦게 끝난 경우) 되돌리지 않는다.
  const moved = await db.all<{ id: string }>(sql`
    UPDATE company_resumes SET current_version_id = ${reserved.id}, updated_at = ${Date.now()}
    WHERE id = ${resumeId} AND user_id = ${userId} AND (
      current_version_id IS NULL OR NOT EXISTS (
        SELECT 1 FROM resume_versions cv WHERE cv.id = company_resumes.current_version_id AND cv.version_no >= ${reserved.versionNo}))
    RETURNING id`);
  if (moved.length === 0 && opts.baseVersionId !== undefined) {
    // 기준 버전을 정해 저장했는데 그 사이 더 새 버전(기준 없이 저장한 복원·AI 초안 등)이 현재가 됐다: 이 저장은 취소한다.
    await db.delete(resumeVersions).where(eq(resumeVersions.id, reserved.id));
    await deleteObject(reserved.storageKey).catch(() => undefined);
    throw new FeatureError("다른 곳에서 이 이력서를 먼저 저장했습니다. 새로고침한 뒤 다시 저장해 주세요.", 409);
  }
  return toVersionMeta(reserved);
}

export interface CreateResumeParams {
  company: string;
  roleTitle: string;
  jdText?: string | null;
  templateId: ResumeTemplateId;
  title?: string | null;
  document: ResumeDocument;
  source: ResumeVersionSource;
  note?: string | null;
  /** 이 이력서를 만든 보관 공고(호출자가 소유권을 확인한 id). */
  postingId?: string | null;
}

/** 메타 + 첫 버전(v1). 본문 저장이 실패하면 메타도 지운다. */
export async function createResume(userId: string, p: CreateResumeParams): Promise<{ resume: ResumeMeta; version: ResumeVersionMeta }> {
  const [stat] = await db.select({ n: count() }).from(companyResumes).where(eq(companyResumes.userId, userId));
  if ((stat?.n ?? 0) >= MAX_RESUMES_PER_USER) {
    throw new FeatureError(`이력서는 ${MAX_RESUMES_PER_USER}개까지 만들 수 있습니다. 쓰지 않는 이력서를 지워 주세요.`, 409);
  }
  const id = newId();
  await db.insert(companyResumes).values({
    id,
    userId,
    company: p.company.trim(),
    roleTitle: p.roleTitle.trim(),
    jdText: p.jdText?.trim() || null,
    templateId: p.templateId,
    title: p.title?.trim() || defaultResumeTitle(p.company.trim(), p.roleTitle.trim()),
    postingId: p.postingId ?? null,
  });
  try {
    const version = await saveVersion(userId, id, p.document, { source: p.source, note: p.note });
    const row = await ownedRow(userId, id);
    return { resume: toResumeMeta(row!), version: version! };
  } catch (err) {
    await db.delete(companyResumes).where(eq(companyResumes.id, id));
    throw err;
  }
}

/** 메타 수정(양식 전환 포함). 남의 이력서면 null. */
export async function updateResumeMeta(userId: string, resumeId: string, patch: UpdateResumeMeta): Promise<ResumeMeta | null> {
  const set: Partial<typeof companyResumes.$inferInsert> = { updatedAt: new Date() };
  if (patch.company !== undefined) set.company = patch.company;
  if (patch.roleTitle !== undefined) set.roleTitle = patch.roleTitle;
  if (patch.jdText !== undefined) set.jdText = patch.jdText?.trim() || null;
  if (patch.templateId !== undefined) set.templateId = patch.templateId;
  if (patch.title !== undefined) set.title = patch.title;
  const [row] = await db
    .update(companyResumes)
    .set(set)
    .where(and(eq(companyResumes.id, resumeId), eq(companyResumes.userId, userId)))
    .returning();
  return row ? toResumeMeta(row) : null;
}

/** 고른 버전 본문을 새 버전으로 복사한다. 이력서·버전이 없으면 null. */
export async function restoreVersion(userId: string, resumeId: string, versionId: string): Promise<ResumeVersionMeta | null> {
  const found = await getVersionDocument(userId, resumeId, versionId);
  if (!found) return null;
  return saveVersion(userId, resumeId, found.document, { source: "manual", note: `v${found.version.versionNo}에서 복원` });
}

/**
 * 이력서 삭제: 메타(버전 행은 cascade)를 먼저 지우고 저장소 객체를 지운다.
 * 객체 삭제가 실패해도 이력서는 이미 사라졌으므로 로그만 남긴다(고아 객체는 같은 접두사로 다시 지울 수 있다).
 */
export async function deleteResume(userId: string, resumeId: string): Promise<boolean> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return false;
  const keys = new Set((await versionRows(resumeId)).map((v) => v.storageKey));
  const deleted = await db
    .delete(companyResumes)
    .where(and(eq(companyResumes.id, resumeId), eq(companyResumes.userId, userId)))
    .returning({ id: companyResumes.id });
  if (deleted.length === 0) return false;
  try {
    for (const k of await listByPrefix(userPrefix(userId, "resumes", resumeId))) keys.add(k);
    for (const k of keys) await deleteObject(k);
  } catch (err) {
    console.error("[deleteResume] 저장소 객체 삭제 실패", resumeId, err);
  }
  return true;
}
