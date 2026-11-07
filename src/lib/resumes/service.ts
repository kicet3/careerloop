import "server-only";
/**
 * 회사별 이력서 저장소. 메타·버전 목록은 PostgreSQL(company_resumes·resume_versions, Prisma), 버전 본문(ResumeDocument JSON)은
 * 오브젝트 저장소 users/<userId>/resumes/<resumeId>/v<n>.json(R2 또는 로컬 폴백).
 *
 * - 모든 함수는 userId 소유권을 확인한다. 남의 이력서는 null/false(라우트에서 404).
 * - 저장할 때마다 새 버전(n+1)을 만든다. 버전 번호를 이력서별 잠금을 건 트랜잭션에서 먼저 예약(행 insert)하고, 본문을 쓴 뒤 현재 버전을 옮긴다.
 *   본문을 못 쓰면 예약한 행을 지운다.
 * - 복원은 고른 버전의 본문을 새 버전으로 복사한다(이력이 한 줄로 이어진다).
 */
import { customAlphabet } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma, type Tx } from "@/lib/db/client";
import { isUniqueViolation, stripNul } from "@/lib/db/errors";
import type { CompanyResume, PortfolioRow, ResumeVersion } from "@/lib/db/types";
import { portfolioKeysInUse, toPortfolioInfo } from "@/lib/portfolios/service";
import { resumeIdsWithEditDraft } from "./edit-draft";
import {
  DEFAULT_RESUME_APPLY_STATUS,
  GENERAL_RESUME_DEFAULT_TITLE,
  parseResumeDocument,
  resumeApplyStatusOf,
  RESUME_APPLY_STATUSES,
  ResumeDocumentSchema,
  type ResumeDocument,
  type ResumeKind,
  type ResumePortfolioInfo,
  type ResumeTemplateId,
  type ResumeVersionSource,
} from "@/lib/domain/resumes";
import { deleteObject, getJson, listByPrefix, putJson, userKey, userPrefix } from "@/lib/storage";
import { POSTING_STATUSES, type PostingStatus } from "@/lib/domain/postings";
import {
  MAX_RESUMES_PER_USER,
  MAX_VERSIONS_PER_RESUME,
  RESUME_LIST_STATUS_FILTERS,
  type ResumeDetail,
  type ResumeListStatusFilter,
  type ResumePostingLink,
  type ResumeListItem,
  type ResumeMeta,
  type ResumeVersionMeta,
  type UpdateResumeMeta,
} from "./types";

// 저장소 키 조각은 영문·숫자로 시작해야 하므로 '-'·'_' 없는 알파벳을 쓴다.
const newId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

export const RESUME_NOT_FOUND = "이력서를 찾을 수 없습니다.";

/** 이력서 행 + 첨부 포트폴리오(보관함 항목). 이력서를 읽는 쿼리는 RESUME_INCLUDE로 함께 읽는다. */
export type ResumeRow = CompanyResume & { portfolio: PortfolioRow | null };
export const RESUME_INCLUDE = { portfolio: true } as const;

/** 첨부 포트폴리오 → 화면 정보(없으면 null). */
export function resumePortfolioInfo(row: ResumeRow): ResumePortfolioInfo | null {
  return row.portfolio ? toPortfolioInfo(row.portfolio) : null;
}

export function toResumeMeta(row: ResumeRow): ResumeMeta {
  const kind: ResumeKind = row.kind === "general" ? "general" : "company";
  return {
    id: row.id,
    kind,
    company: row.company,
    roleTitle: row.roleTitle,
    jdText: row.jdText,
    templateId: row.templateId,
    title: row.title,
    currentVersionId: row.currentVersionId,
    postingId: row.postingId ?? null,
    sourceResumeId: row.sourceResumeId ?? null,
    applyStatus: resumeApplyStatusOf(kind, row.applyStatus),
    applyStatusChangedAt: row.applyStatusChangedAt?.getTime() ?? null,
    submittedApplicationId: row.submittedApplicationId ?? null,
    portfolio: resumePortfolioInfo(row),
    includePhoto: row.includePhoto ?? true,
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

async function ownedRow(userId: string, resumeId: string): Promise<ResumeRow | null> {
  const row = await prisma.companyResume.findFirst({ where: { id: resumeId, userId }, include: RESUME_INCLUDE });
  return (row as ResumeRow | null) ?? null;
}

export function defaultResumeTitle(company: string, roleTitle: string): string {
  return `${company} ${roleTitle}`.trim().slice(0, 120);
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/**
 * 목록 상태 필터 → where 조각. 'general'은 공용 이력서만, 'draft'는 상태가 비어 있는 예전 지원처별 행도 포함한다.
 * 'all'·생략은 조건 없음.
 */
export function resumeStatusWhere(status: ResumeListStatusFilter | undefined): Prisma.CompanyResumeWhereInput {
  switch (status) {
    case "general":
      return { kind: "general" };
    case "draft":
      return { kind: { not: "general" }, OR: [{ applyStatus: "draft" }, { applyStatus: null }, { applyStatus: { notIn: [...RESUME_APPLY_STATUSES] } }] };
    case "applying":
    case "submitted":
      return { kind: { not: "general" }, applyStatus: status };
    default:
      return {};
  }
}

/** 목록 쿼리 ?status= 해석. 모르는 값은 'all'. */
export function parseResumeStatusFilter(raw: string | null | undefined): ResumeListStatusFilter {
  return (RESUME_LIST_STATUS_FILTERS as readonly string[]).includes(raw ?? "") ? (raw as ResumeListStatusFilter) : "all";
}

/** 이력서 목록(최근 수정 순). kind를 주면 그 종류만(이력서 화면은 공용·지원처별을 나눠 보여 준다), status를 주면 그 지원 상태만. */
export async function listResumes(
  userId: string,
  opts: { kind?: ResumeKind; status?: ResumeListStatusFilter } = {},
): Promise<ResumeListItem[]> {
  const rows = (await prisma.companyResume.findMany({
    where: { AND: [{ userId, ...(opts.kind ? { kind: opts.kind } : {}) }, resumeStatusWhere(opts.status)] },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: MAX_RESUMES_PER_USER,
    include: RESUME_INCLUDE,
  })) as ResumeRow[];
  if (rows.length === 0) return [];
  const stats = await prisma.resumeVersion.groupBy({
    by: ["resumeId"],
    where: { resumeId: { in: rows.map((r) => r.id) } },
    _count: { _all: true },
  });
  const currentIds = rows.map((r) => r.currentVersionId).filter((x): x is string => !!x);
  const currentNos = currentIds.length
    ? await prisma.resumeVersion.findMany({ select: { id: true, versionNo: true }, where: { id: { in: currentIds } } })
    : [];
  const countBy = new Map(stats.map((s) => [s.resumeId, s._count._all]));
  const noBy = new Map(currentNos.map((v) => [v.id, v.versionNo]));
  const withDraft = await resumeIdsWithEditDraft(userId, rows.map((r) => r.id));
  return rows.map((r) => ({
    ...toResumeMeta(r),
    versionCount: countBy.get(r.id) ?? 0,
    currentVersionNo: r.currentVersionId ? (noBy.get(r.currentVersionId) ?? null) : null,
    hasEditDraft: withDraft.has(r.id),
  }));
}

export async function getResumeMeta(userId: string, resumeId: string): Promise<ResumeMeta | null> {
  const row = await ownedRow(userId, resumeId);
  return row ? toResumeMeta(row) : null;
}

async function versionRows(resumeId: string): Promise<ResumeVersion[]> {
  return (await prisma.resumeVersion.findMany({ where: { resumeId }, orderBy: { versionNo: "desc" } })) as ResumeVersion[];
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
    posting: await getResumePostingLink(userId, row.postingId),
  };
}

/** 여러 이력서의 연결 공고 요약(공고 id → 요약). 남의 공고는 빠진다. */
export async function listResumePostingLinks(userId: string, postingIds: readonly (string | null)[]): Promise<Map<string, ResumePostingLink>> {
  const ids = [...new Set(postingIds.filter((x): x is string => !!x))];
  if (ids.length === 0) return new Map();
  const rows = await prisma.jobPosting.findMany({
    select: { id: true, company: true, roleTitle: true, url: true, status: true, sharedPostingId: true },
    where: { userId, id: { in: ids } },
  });
  return new Map(rows.map((p) => [p.id, toPostingLink(p)]));
}

function toPostingLink(p: { id: string; company: string; roleTitle: string; url: string | null; status: string; sharedPostingId: string | null }): ResumePostingLink {
  return {
    id: p.id,
    company: p.company,
    roleTitle: p.roleTitle,
    url: p.url ?? "",
    status: (POSTING_STATUSES as readonly string[]).includes(p.status) ? (p.status as PostingStatus) : "saved",
    sharedPostingId: p.sharedPostingId ?? null,
  };
}

/** 이력서에 연결된 내 공고 요약(없거나 남의 것이면 null). */
export async function getResumePostingLink(userId: string, postingId: string | null | undefined): Promise<ResumePostingLink | null> {
  if (!postingId) return null;
  const p = await prisma.jobPosting.findFirst({
    select: { id: true, company: true, roleTitle: true, url: true, status: true, sharedPostingId: true },
    where: { id: postingId, userId },
  });
  return p ? toPostingLink(p) : null;
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
    version = ((await prisma.resumeVersion.findFirst({ where: { id: wanted, resumeId } })) as ResumeVersion | null) ?? undefined;
  } else {
    [version] = await versionRows(resumeId);
  }
  if (!version) return null;
  return { resume: toResumeMeta(row), version: toVersionMeta(version), document: await readDocument(version.storageKey) };
}

// ---------------------------------------------------------------------------
// 변경
// ---------------------------------------------------------------------------

/** 같은 이력서의 버전 쓰기를 트랜잭션 끝까지 직렬화한다(READ COMMITTED에서 번호·개수 확인과 삽입 사이에 끼어들지 않게). */
async function lockResume(tx: Tx, resumeId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`resume:${resumeId}`}))`;
}

export interface SaveVersionOptions {
  source: ResumeVersionSource;
  note?: string | null;
  /** 지정하면 현재 버전이 이것과 같을 때만 저장(다른 탭의 저장을 덮어쓰지 않게). */
  baseVersionId?: string | null;
  /** 이 저장으로 함께 바꿀 양식. 현재 버전 포인터를 옮기는 트랜잭션에서 같이 바꾼다(저장이 취소되면 양식도 그대로). */
  templateId?: ResumeTemplateId;
  /**
   * 저장이 현재 버전이 되면 임시 저장본(resume_edit_drafts)도 같은 트랜잭션에서 지운다. 편집 화면의 '저장(새 버전)'·복원만 켠다 —
   * AI 다듬기 적용·AI 초안처럼 작업본과 상관없는 저장은 작업본을 남겨 두고, 화면이 기준 버전이 바뀐 것을 충돌로 알린다.
   */
  clearEditDraft?: boolean;
}

/**
 * 버전 번호 예약: 이력서별 잠금을 건 트랜잭션에서 소유권·기준 버전·버전 수 한도를 확인하고 다음 번호의 행을 넣는다.
 * 동시 저장도 차례로 서로 다른 번호를 받는다. 조건에 걸려 아무것도 넣지 못했으면 null.
 */
async function reserveVersion(userId: string, resumeId: string, opts: SaveVersionOptions): Promise<(ResumeVersion & { resumeKind: string }) | null> {
  return prisma.$transaction(async (tx) => {
    await lockResume(tx, resumeId);
    const r = await tx.companyResume.findFirst({ select: { id: true, currentVersionId: true, kind: true }, where: { id: resumeId, userId } });
    if (!r) return null;
    if (opts.baseVersionId === null && r.currentVersionId !== null) return null;
    if (typeof opts.baseVersionId === "string") {
      // 기준 버전이 현재 포인터이고, 그보다 새 번호가 아직 예약되지 않았을 때만(본문 쓰기 중인 다른 저장도 막는다).
      if (r.currentVersionId !== opts.baseVersionId) return null;
      const base = await tx.resumeVersion.findUnique({ select: { versionNo: true }, where: { id: opts.baseVersionId } });
      if (base && (await tx.resumeVersion.count({ where: { resumeId, versionNo: { gt: base.versionNo } } })) > 0) return null;
    }
    const agg = await tx.resumeVersion.aggregate({ where: { resumeId }, _count: { _all: true }, _max: { versionNo: true } });
    if (agg._count._all >= MAX_VERSIONS_PER_RESUME) return null;
    const versionNo = (agg._max.versionNo ?? 0) + 1;
    const row = await tx.resumeVersion.create({
      data: {
        id: newId(),
        resumeId,
        versionNo,
        storageKey: versionStorageKey(userId, resumeId, versionNo),
        note: stripNul(opts.note?.trim() || null),
        source: opts.source,
      },
    });
    return { ...(row as ResumeVersion), resumeKind: r.kind };
  });
}

/** 새 버전을 저장하고 현재 버전으로 삼는다. 남의 이력서면 null. */
export async function saveVersion(
  userId: string,
  resumeId: string,
  document: ResumeDocument,
  opts: SaveVersionOptions,
): Promise<ResumeVersionMeta | null> {
  const doc = ResumeDocumentSchema.parse(document);
  let reserved: Awaited<ReturnType<typeof reserveVersion>>;
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
    const n = await prisma.resumeVersion.count({ where: { resumeId } });
    if (opts.baseVersionId !== undefined && n < MAX_VERSIONS_PER_RESUME) {
      // 기준 버전이 현재가 아니거나, 다른 저장이 그보다 새 번호를 먼저 예약했다.
      throw new FeatureError("다른 곳에서 이 이력서를 먼저 저장했습니다. 새로고침한 뒤 다시 저장해 주세요.", 409);
    }
    throw new FeatureError(`버전은 이력서당 ${MAX_VERSIONS_PER_RESUME}개까지 저장할 수 있습니다. 새 이력서를 만들어 주세요.`, 409);
  }

  try {
    // 지원 동기는 지원처별 이력서에만 둔다(공용 이력서로 복사·저장하면 비운다).
    await putJson(reserved.storageKey, reserved.resumeKind === "general" ? { ...doc, motivation: "" } : doc);
  } catch (err) {
    // 본문을 못 쓴 버전 행은 지운다(목록에 깨진 버전이 남지 않게).
    await prisma.resumeVersion.deleteMany({ where: { id: reserved.id } });
    throw err;
  }
  // 포인터는 앞으로만 옮긴다: 더 새 번호가 이미 현재 버전이면(본문 쓰기가 늦게 끝난 경우) 되돌리지 않는다.
  const moved = await prisma.$transaction(async (tx) => {
    await lockResume(tx, resumeId);
    const r = await tx.companyResume.findFirst({ select: { currentVersionId: true }, where: { id: resumeId, userId } });
    if (!r) return false;
    if (r.currentVersionId) {
      const cur = await tx.resumeVersion.findUnique({ select: { versionNo: true }, where: { id: r.currentVersionId } });
      if (cur && cur.versionNo >= reserved.versionNo) return false;
    }
    const { count } = await tx.companyResume.updateMany({
      where: { id: resumeId, userId },
      data: { currentVersionId: reserved.id, updatedAt: new Date(), ...(opts.templateId ? { templateId: opts.templateId } : {}) },
    });
    if (count > 0 && opts.clearEditDraft) await tx.resumeEditDraft.deleteMany({ where: { resumeId, userId } });
    return count > 0;
  });
  if (!moved && opts.baseVersionId !== undefined) {
    // 기준 버전을 정해 저장했는데 그 사이 더 새 버전(기준 없이 저장한 복원·AI 초안 등)이 현재가 됐다: 이 저장은 취소한다.
    await prisma.resumeVersion.deleteMany({ where: { id: reserved.id } });
    await deleteObject(reserved.storageKey).catch(() => undefined);
    throw new FeatureError("다른 곳에서 이 이력서를 먼저 저장했습니다. 새로고침한 뒤 다시 저장해 주세요.", 409);
  }
  return toVersionMeta(reserved);
}

export interface CreateResumeParams {
  /** 기본 'company'. 'general'이면 company·roleTitle·postingId를 무시하고 ''·null로 저장한다(jdText도 null). */
  kind?: ResumeKind;
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
  /** 복제·'공용 이력서 내용으로 시작'의 원본(호출자가 소유권을 확인한 id). */
  sourceResumeId?: string | null;
  /** 이력서에 프로필 사진을 넣을지(생략하면 켬). 복제는 원본 값을 이어받는다. */
  includePhoto?: boolean;
  /** 미리 정한 id(newResumeId로 만든 값). 에이전트 finalize가 만들기 전에 id를 기록해 두고 중단 뒤 회수하는 데 쓴다. */
  id?: string;
}

/** createResume에 넘길 새 이력서 id. */
export function newResumeId(): string {
  return newId();
}

/** 메타 + 첫 버전(v1). 본문 저장이 실패하면 메타도 지운다. */
export async function createResume(userId: string, p: CreateResumeParams): Promise<{ resume: ResumeMeta; version: ResumeVersionMeta }> {
  const n = await prisma.companyResume.count({ where: { userId } });
  if (n >= MAX_RESUMES_PER_USER) {
    throw new FeatureError(`이력서는 ${MAX_RESUMES_PER_USER}개까지 만들 수 있습니다. 쓰지 않는 이력서를 지워 주세요.`, 409);
  }
  const id = p.id ?? newId();
  const kind: ResumeKind = p.kind ?? "company";
  const general = kind === "general";
  const company = general ? "" : stripNul(p.company.trim());
  const roleTitle = general ? "" : stripNul(p.roleTitle.trim());
  await prisma.companyResume.create({
    data: {
      id,
      userId,
      kind,
      company,
      roleTitle,
      jdText: general ? null : stripNul(p.jdText?.trim() || null),
      templateId: p.templateId,
      title: stripNul(p.title?.trim() || null) || (general ? GENERAL_RESUME_DEFAULT_TITLE : defaultResumeTitle(company, roleTitle)),
      postingId: general ? null : (p.postingId ?? null),
      sourceResumeId: p.sourceResumeId ?? null,
      applyStatus: general ? null : DEFAULT_RESUME_APPLY_STATUS,
      includePhoto: p.includePhoto ?? true,
    },
  });
  try {
    const version = await saveVersion(userId, id, p.document, { source: p.source, note: p.note });
    const row = await ownedRow(userId, id);
    return { resume: toResumeMeta(row!), version: version! };
  } catch (err) {
    await prisma.companyResume.deleteMany({ where: { id } });
    throw err;
  }
}

export interface CopyResumeTarget {
  kind: ResumeKind;
  /** kind 'company'면 필수(1자 이상). */
  company?: string;
  roleTitle?: string;
  jdText?: string | null;
  postingId?: string | null;
  title?: string | null;
  /** 생략하면 원본 양식. */
  templateId?: ResumeTemplateId;
}

/**
 * 복제본이 원본의 지원 동기를 이어받아도 되는가: 같은 지원처(같은 공고, 또는 같은 회사·직무)일 때만.
 * 지원 동기는 회사·공고마다 다르게 쓰는 글이다 — 다른 회사용 복제본에 남으면 엉뚱한 회사에 내기 쉽다.
 */
function keepsMotivation(source: Pick<ResumeMeta, "kind" | "company" | "roleTitle" | "postingId">, target: CopyResumeTarget): boolean {
  if (source.kind !== "company" || target.kind !== "company") return false;
  if (source.postingId && target.postingId) return source.postingId === target.postingId;
  const n = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return n(source.company) !== "" && n(source.company) === n(target.company) && n(source.roleTitle) === n(target.roleTitle);
}

/**
 * 원본 이력서의 현재 버전 본문으로 새 이력서를 만든다('이 공고용으로 복제'·'공용 이력서 내용으로 시작').
 * 새 이력서의 v1은 source 'manual', 메모 "<원본 제목> vN에서 복제". 원본이 남의 것이거나 없으면 null.
 */
export async function copyResume(
  userId: string,
  sourceResumeId: string,
  target: CopyResumeTarget,
): Promise<{ resume: ResumeMeta; version: ResumeVersionMeta } | null> {
  const found = await getVersionDocument(userId, sourceResumeId);
  if (!found) return null;
  if (target.kind === "company" && !target.company?.trim()) throw new FeatureError("회사명을 입력해 주세요.", 400);
  return createResume(userId, {
    kind: target.kind,
    company: target.company ?? "",
    roleTitle: target.roleTitle ?? "",
    jdText: target.jdText ?? null,
    postingId: target.postingId ?? null,
    title: target.title ?? null,
    templateId: target.templateId ?? found.resume.templateId,
    document: { ...found.document, motivation: keepsMotivation(found.resume, target) ? found.document.motivation : "" },
    source: "manual",
    note: `${found.resume.title} v${found.version.versionNo}에서 복제`.slice(0, 200),
    sourceResumeId,
    // '사진 넣기'를 끈 이력서를 복제해도 사진이 다시 켜지지 않게 원본 설정을 이어받는다.
    includePhoto: found.resume.includePhoto,
  });
}

/** 메타 수정(양식 전환 포함). 남의 이력서면 null. */
export async function updateResumeMeta(userId: string, resumeId: string, patch: UpdateResumeMeta): Promise<ResumeMeta | null> {
  const set: Prisma.CompanyResumeUpdateManyMutationInput = { updatedAt: new Date() };
  if (patch.company !== undefined) set.company = stripNul(patch.company);
  if (patch.roleTitle !== undefined) set.roleTitle = stripNul(patch.roleTitle);
  if (patch.jdText !== undefined) set.jdText = stripNul(patch.jdText?.trim() || null);
  if (patch.templateId !== undefined) set.templateId = patch.templateId;
  if (patch.title !== undefined) set.title = stripNul(patch.title);
  if (patch.includePhoto !== undefined) set.includePhoto = patch.includePhoto;
  const [row] = await prisma.companyResume.updateManyAndReturn({ where: { id: resumeId, userId }, data: set, include: RESUME_INCLUDE });
  return row ? toResumeMeta(row as ResumeRow) : null;
}

/**
 * 고른 버전 본문을 새 버전으로 복사한다. 이력서·버전이 없으면 null.
 * 편집 화면은 작업본(임시 저장본)을 버린다고 확인받은 뒤 복원하므로 작업본도 함께 지운다.
 */
export async function restoreVersion(userId: string, resumeId: string, versionId: string): Promise<ResumeVersionMeta | null> {
  const found = await getVersionDocument(userId, resumeId, versionId);
  if (!found) return null;
  return saveVersion(userId, resumeId, found.document, { source: "manual", note: `v${found.version.versionNo}에서 복원`, clearEditDraft: true });
}

/**
 * 이력서 삭제: 메타·버전 행을 먼저 지우고 저장소 객체를 지운다.
 * 객체 삭제가 실패해도 이력서는 이미 사라졌으므로 로그만 남긴다(고아 객체는 같은 접두사로 다시 지울 수 있다).
 */
export async function deleteResume(userId: string, resumeId: string): Promise<boolean> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return false;
  const keys = new Set((await versionRows(resumeId)).map((v) => v.storageKey));
  // 버전 행은 FK(ON DELETE CASCADE)로 지워지고, 지원 기록의 이력서 연결은 FK(ON DELETE SET NULL)로 끊긴다.
  const { count } = await prisma.companyResume.deleteMany({ where: { id: resumeId, userId } });
  if (count === 0) return false;
  try {
    for (const k of await listByPrefix(userPrefix(userId, "resumes", resumeId))) keys.add(k);
    // 예전 이력서 첨부에서 보관함으로 옮긴 포트폴리오는 이 이력서 접두사의 텍스트 키를 그대로 쓴다 — 그 키는 남긴다.
    const inUse = await portfolioKeysInUse(userId, [...keys]);
    for (const k of keys) if (!inUse.has(k)) await deleteObject(k);
  } catch (err) {
    console.error("[deleteResume] 저장소 객체 삭제 실패", resumeId, err);
  }
  return true;
}
