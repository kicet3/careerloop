import "server-only";
/**
 * 공용 공고(shared_postings, 공고 찾기). 공용 공고가 먼저 만들어지고 보관 공고(job_postings)가 그것을 가리킨다.
 * - URL 가져오기 결과는 정규화 URL(url_key)당 한 행으로 모은다(upsertSharedPosting).
 * - 직접 입력 공고도 공용 공고를 먼저 만든다(service.createPosting) — url·url_key 없이 공개 필드만, extracted_by 'manual'.
 *   만든 사람이 자기 공고를 고치면 공개 필드를 맞추고, 그 밖에는 바뀌지 않는다(다시 가져오기·캡처 없음).
 * - 공용 공고는 보관 공고 삭제·회원 탈퇴로 지워지지 않는다(created_by만 null).
 * - 같은 URL을 다른 사용자가(또는 내가 다시) 가져오면 LLM·페이지 읽기 없이 이 행을 보관함으로 복사한다(saveSharedToLibrary).
 * - '다시 가져오기'만 페이지를 다시 읽어 이 행을 덮어쓴다(upsertSharedPosting) — 그 뒤 내 공고는 syncPostingFromShared로 맞춘다.
 * - 숨긴 행(hidden_at)은 목록·재사용에서 빠진다(관리자 조치).
 * 보관함 공고(job_postings)는 사본이다: 상태·메모·지원 기록·사용자가 고친 구역은 개인 것이며 공유되지 않는다.
 */
import { nanoid } from "nanoid";
import { Prisma as PrismaNs } from "@/generated/prisma/client";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Db, type Prisma } from "@/lib/db/client";
import { isUniqueViolation, stripNul, stripNulDeep } from "@/lib/db/errors";
import type { JobPostingRow, SharedPostingRow } from "@/lib/db/types";
import { POSTING_STRUCTURE_VERSION, type PostingStructure } from "@/lib/domain/posting-structure";
import { POSTING_LIMITS, type JobPosting, type PostingCreateInput, type PostingStatus } from "@/lib/domain/postings";
import {
  SHARED_POSTING_PAGE_SIZE,
  type SharedDeadlineFilter,
  type SharedPostingDetail,
  type SharedPostingSummary,
} from "@/lib/domain/shared-postings";
import { kstDate } from "@/lib/time/kst";
import { toCaptureInfo } from "./capture-store";
import {
  DuplicatePostingError,
  getPosting,
  highlightsOf,
  MAX_POSTINGS_PER_USER,
  parseStoredStructure,
  refreshSharedImporterCount,
  releaseMovedShared,
  toJobPosting,
} from "./service";
import { inferPlatform, isValidUrl, normalizeUrl, withScheme } from "./url";

export const SHARED_POSTING_NOT_FOUND = "공고 찾기에서 공고를 찾을 수 없습니다.";

const orNull = (v: string | undefined | null) => (v && v.trim() ? stripNul(v) : null);

/** 입력 URL → url_key(형식이 틀리면 null). */
export function sharedUrlKey(rawUrl: string): string | null {
  const v = rawUrl.trim();
  if (!v || !isValidUrl(v)) return null;
  return normalizeUrl(withScheme(v)) || null;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/** url_key로 공용 공고(숨김 제외). */
export async function findSharedPostingByUrlKey(urlKey: string, db: Db = prisma): Promise<SharedPostingRow | null> {
  if (!urlKey) return null;
  return (await db.sharedPosting.findFirst({ where: { urlKey, hiddenAt: null } })) as SharedPostingRow | null;
}

/** 입력 URL(정규화 전)로 공용 공고(숨김 제외). URL 가져오기가 작업을 만들기 전에 부른다. */
export async function findSharedPostingByUrl(rawUrl: string, db: Db = prisma): Promise<SharedPostingRow | null> {
  const key = sharedUrlKey(rawUrl);
  return key ? findSharedPostingByUrlKey(key, db) : null;
}

function toSummary(row: SharedPostingRow, myPostingId: string | null): SharedPostingSummary {
  const highlights = highlightsOf(parseStoredStructure(row.structured));
  return {
    id: row.id,
    url: row.url,
    urlKey: row.urlKey,
    platform: row.platform ?? "",
    company: row.company,
    roleTitle: row.roleTitle,
    deadline: row.deadline ?? "",
    deadlineTime: row.deadlineTime ?? "",
    deadlineKind: row.deadlineKind,
    employmentType: row.employmentType,
    workType: row.workType,
    location: row.location ?? "",
    careerLevel: row.careerLevel,
    ...(highlights ? { highlights } : {}),
    importerCount: row.importerCount,
    fetchedAt: row.fetchedAt.getTime(),
    myPostingId,
    ...(row.hiddenAt ? { hidden: true } : {}),
    // 직접 입력 공용 공고는 찍을 페이지가 없다.
    ...(row.url ? { capture: toCaptureInfo(row) } : {}),
  };
}

export function toSharedPostingDetail(row: SharedPostingRow, myPostingId: string | null): SharedPostingDetail {
  return {
    ...toSummary(row, myPostingId),
    jdText: row.jdText ?? "",
    structured: parseStoredStructure(row.structured),
    sourceText: row.sourceText ?? "",
    extractedBy: row.extractedBy,
  };
}

/** viewer의 보관함에서 이 공용 공고들에 해당하는 공고 id(공용 연결 또는 같은 url_key). */
async function myPostingIds(viewerId: string, rows: Pick<SharedPostingRow, "id" | "urlKey">[]): Promise<Map<string, string>> {
  if (rows.length === 0) return new Map();
  // 직접 입력 공용 공고는 url_key가 없다 — 주소로는 맞추지 않는다(null끼리 맞으면 안 된다).
  const keys = rows.flatMap((r) => (r.urlKey ? [r.urlKey] : []));
  const mine = await prisma.jobPosting.findMany({
    select: { id: true, sharedPostingId: true, urlKey: true },
    where: {
      userId: viewerId,
      OR: [{ sharedPostingId: { in: rows.map((r) => r.id) } }, ...(keys.length ? [{ urlKey: { in: keys } }] : [])],
    },
  });
  const byShared = new Map<string, string>();
  for (const r of rows) {
    const hit = mine.find((m) => m.sharedPostingId === r.id) ?? (r.urlKey ? mine.find((m) => m.urlKey === r.urlKey) : undefined);
    if (hit) byShared.set(r.id, hit.id);
  }
  return byShared;
}

export interface SharedPostingListOptions {
  q?: string;
  company?: string;
  role?: string;
  tech?: string;
  deadline?: SharedDeadlineFilter;
  page?: number;
  pageSize?: number;
  viewerId?: string;
  /** 'only'면 숨긴 공고만(관리자 화면). 기본은 숨김 제외. 호출자가 관리자인지 확인한다. */
  hidden?: "only";
  /** 마감 필터 기준 시각(테스트용). */
  now?: number;
}

const ci = (v: string) => ({ contains: v, mode: "insensitive" as const });
const clip = (v: string | undefined) => v?.trim().slice(0, 100) ?? "";

/** 목록 조건(기본 숨김 제외, hidden='only'면 숨긴 것만). 마감 날짜는 YYYY-MM-DD(KST) 문자열이라 문자열 비교로 거른다. */
export function sharedPostingWhere(opts: SharedPostingListOptions): Prisma.SharedPostingWhereInput {
  const and: Prisma.SharedPostingWhereInput[] = [];
  const q = clip(opts.q);
  if (q) and.push({ OR: [{ company: ci(q) }, { roleTitle: ci(q) }, { location: ci(q) }, { jdText: ci(q) }] });
  const company = clip(opts.company);
  if (company) and.push({ company: ci(company) });
  const role = clip(opts.role);
  if (role) and.push({ roleTitle: ci(role) });
  const tech = clip(opts.tech);
  if (tech) and.push({ OR: [{ structured: { path: ["techStack"], array_contains: [tech] } }, { jdText: ci(tech) }] });
  const today = kstDate(opts.now ?? Date.now());
  if (opts.deadline === "open") {
    // 마감일이 지난 공고만 뺀다(상시·미공개·날짜 없는 행은 남긴다).
    and.push({ OR: [{ deadline: null }, { deadline: { gte: today } }, { NOT: { deadlineKind: "date" } }] });
  } else if (opts.deadline === "soon") {
    and.push({ deadlineKind: "date", deadline: { gte: today, lte: kstDate((opts.now ?? Date.now()) + 7 * 86_400_000) } });
  }
  return { hiddenAt: opts.hidden === "only" ? { not: null } : null, ...(and.length ? { AND: and } : {}) };
}

/**
 * 공고 찾기 목록(숨김 제외, 최근 읽은 순). q는 회사·직무·근무지·본문 부분 일치(대소문자 무시), company·role·tech·deadline은 각각 거른다.
 * viewerId를 주면 각 공고에 내 보관함 공고 id(myPostingId)를 싣는다.
 */
export async function listSharedPostings(opts: SharedPostingListOptions = {}): Promise<{ items: SharedPostingSummary[]; total: number }> {
  const where = sharedPostingWhere(opts);
  const size = Math.min(Math.max(opts.pageSize ?? SHARED_POSTING_PAGE_SIZE, 1), 100);
  const [rows, total] = await Promise.all([
    prisma.sharedPosting.findMany({
      where,
      orderBy: [{ fetchedAt: "desc" }, { id: "desc" }],
      skip: Math.max(opts.page ?? 0, 0) * size,
      take: size,
    }),
    prisma.sharedPosting.count({ where }),
  ]);
  const mine = opts.viewerId ? await myPostingIds(opts.viewerId, rows) : new Map<string, string>();
  return { items: (rows as SharedPostingRow[]).map((r) => toSummary(r, mine.get(r.id) ?? null)), total };
}

/** 공용 공고 하나(기본 숨김 제외). includeHidden은 관리자 화면에서만 — 숨긴 공고를 다시 공개할 수 있게 한다. */
export async function getSharedPosting(
  id: string,
  viewerId?: string,
  opts: { includeHidden?: boolean } = {},
): Promise<SharedPostingDetail | null> {
  const row = await prisma.sharedPosting.findFirst({ where: { id, ...(opts.includeHidden ? {} : { hiddenAt: null }) } });
  if (!row) return null;
  const mine = viewerId ? await myPostingIds(viewerId, [row]) : new Map<string, string>();
  return toSharedPostingDetail(row as SharedPostingRow, mine.get(row.id) ?? null);
}

// ---------------------------------------------------------------------------
// 쓰기
// ---------------------------------------------------------------------------

export interface SharedPostingInput {
  /** 최종(리다이렉트 뒤) 페이지 주소. url_key는 이 주소로 만든다. */
  url: string;
  /** extractPosting 결과(status·note는 무시한다 — 개인 값). */
  posting: PostingCreateInput;
  structure: PostingStructure | null;
  sourceText: string;
  extractedBy: string;
  /** 처음 가져온 사용자(새 행일 때만 기록). */
  createdBy: string;
}

function sharedColumns(input: SharedPostingInput, now: Date) {
  const url = withScheme(input.url.trim());
  const p = input.posting;
  return {
    url: stripNul(url),
    platform: orNull(inferPlatform(url)?.slice(0, POSTING_LIMITS.platform)),
    company: stripNul(p.company),
    roleTitle: stripNul(p.roleTitle),
    jdText: orNull(p.jdText),
    structured: input.structure ? (stripNulDeep(input.structure) as unknown as Prisma.InputJsonValue) : PrismaNs.DbNull,
    structuredVersion: input.structure ? POSTING_STRUCTURE_VERSION : null,
    sourceText: orNull(input.sourceText.slice(0, POSTING_LIMITS.jdText)),
    deadline: orNull(p.deadline),
    deadlineTime: orNull(p.deadlineTime),
    deadlineKind: p.deadlineKind,
    employmentType: p.employmentType,
    workType: p.workType,
    location: orNull(p.location),
    careerLevel: p.careerLevel,
    extractedBy: stripNul(input.extractedBy.slice(0, 40)) || "manual",
    fetchedAt: now,
    updatedAt: now,
  };
}

/**
 * 가져오기 결과를 공용 공고로 저장한다. 같은 url_key가 있으면 내용을 덮어쓰고(fetchedAt 갱신, 숨김은 유지), 없으면 만든다.
 * 형식이 틀린 URL이면 400.
 */
export async function upsertSharedPosting(input: SharedPostingInput, db: Db = prisma): Promise<SharedPostingRow> {
  const urlKey = sharedUrlKey(input.url);
  if (!urlKey) throw new FeatureError("공고 주소 형식이 올바르지 않습니다.", 400);
  const now = new Date();
  const cols = sharedColumns(input, now);
  const attempt = () =>
    db.sharedPosting.upsert({
      where: { urlKey },
      update: cols,
      create: { id: nanoid(), urlKey, ...cols, createdBy: input.createdBy, createdAt: now },
    });
  try {
    return (await attempt()) as SharedPostingRow;
  } catch (err) {
    // 동시에 같은 URL을 처음 저장한 경우: 한 번 더 하면 update로 간다.
    if (isUniqueViolation(err)) return (await attempt()) as SharedPostingRow;
    throw err;
  }
}

/** 보관함에 담은 사용자 수를 다시 센다(job_postings.shared_posting_id 기준). */
export { refreshSharedImporterCount };

/**
 * 공용 공고 → 보관함 공고 컬럼(개인 값 status·note 제외). 직접 입력 공용 공고(url 없음)는 주소 컬럼을 싣지 않는다 —
 * 새 사본은 주소 없이 만들어지고, 기존 공고의 주소는 지우지 않는다.
 */
function libraryColumns(row: SharedPostingRow) {
  return {
    company: row.company,
    roleTitle: row.roleTitle,
    ...(row.url ? { url: row.url, urlKey: row.urlKey } : {}),
    platform: row.platform,
    jdText: row.jdText,
    structured: row.structured === null ? PrismaNs.DbNull : (row.structured as Prisma.InputJsonValue),
    structuredVersion: row.structuredVersion,
    sourceText: row.sourceText,
    deadline: row.deadline,
    deadlineTime: row.deadlineTime,
    deadlineKind: row.deadlineKind,
    employmentType: row.employmentType,
    workType: row.workType,
    location: row.location,
    careerLevel: row.careerLevel,
    extractedBy: row.extractedBy,
    sharedPostingId: row.id,
  };
}

/**
 * 공용 공고를 내 보관함에 담는다(LLM·페이지 읽기 없음).
 * - 이미 같은 url_key(또는 같은 공용 공고)의 공고가 있으면 그것을 공용 공고에 연결만 하고 돌려준다(created=false).
 * - 없으면 사본을 만든다(상태 기본 saved). 보관함 상한 초과 → 409. 숨긴 공고·없는 id → 404.
 */
export async function saveSharedToLibrary(
  userId: string,
  sharedId: string,
  opts: { status?: PostingStatus } = {},
): Promise<{ posting: JobPosting; created: boolean }> {
  const row = (await prisma.sharedPosting.findFirst({ where: { id: sharedId, hiddenAt: null } })) as SharedPostingRow | null;
  if (!row) throw new FeatureError(SHARED_POSTING_NOT_FOUND, 404);

  const existing = await prisma.jobPosting.findFirst({
    where: { userId, OR: [{ sharedPostingId: row.id }, ...(row.urlKey ? [{ urlKey: row.urlKey }] : [])] },
    orderBy: { createdAt: "asc" },
  });
  if (existing) {
    if (existing.sharedPostingId !== row.id && row.urlKey && existing.urlKey === row.urlKey) {
      // 직접 입력·예전 가져오기로 같은 URL을 둔 공고: 공용 공고에 연결만 한다(내용은 바꾸지 않는다).
      // 원래 연결돼 있던 공용 공고는 지우지 않는다. 내가 직접 입력으로 만들었고 남은 사람이 없으면 숨긴다(releaseMovedShared).
      await prisma.jobPosting.updateMany({ where: { id: existing.id, userId }, data: { sharedPostingId: row.id } });
      await refreshSharedImporterCount(row.id);
      if (existing.sharedPostingId) await releaseMovedShared(userId, existing.sharedPostingId);
    }
    return { posting: (await getPosting(userId, existing.id))!, created: false };
  }

  const n = await prisma.jobPosting.count({ where: { userId } });
  if (n >= MAX_POSTINGS_PER_USER) {
    throw new FeatureError(`공고는 ${MAX_POSTINGS_PER_USER}개까지 보관할 수 있습니다. 마감된 공고를 정리해 주세요.`, 409);
  }
  const now = new Date();
  try {
    const created = await prisma.jobPosting.create({
      data: { id: nanoid(), userId, ...libraryColumns(row), status: opts.status ?? "saved", createdAt: now, updatedAt: now },
    });
    await refreshSharedImporterCount(row.id);
    return { posting: toJobPosting(created as JobPostingRow), created: true };
  } catch (err) {
    if (isUniqueViolation(err) && row.urlKey) {
      const raced = await prisma.jobPosting.findFirst({ select: { id: true }, where: { userId, urlKey: row.urlKey } });
      if (raced) return { posting: (await getPosting(userId, raced.id))!, created: false };
      throw new DuplicatePostingError(row.id);
    }
    throw err;
  }
}

/**
 * '다시 가져오기' 뒤 내 공고를 공용 공고 내용으로 맞춘다(상태·메모는 그대로, 구역·JD·마감 등은 덮어쓴다).
 * 공용 공고에 연결되지 않았거나 직접 입력 공용 공고(url 없음)에 연결된 공고면 null.
 */
export async function syncPostingFromShared(userId: string, postingId: string): Promise<JobPosting | null> {
  const posting = await prisma.jobPosting.findFirst({ select: { sharedPostingId: true }, where: { id: postingId, userId } });
  if (!posting?.sharedPostingId) return null;
  const row = (await prisma.sharedPosting.findUnique({ where: { id: posting.sharedPostingId } })) as SharedPostingRow | null;
  // 직접 입력 공용 공고(url 없음)는 다시 가져올 페이지가 없다 — 보관 공고가 원본이므로 맞추지 않는다.
  if (!row?.url) return null;
  const cols = libraryColumns(row);
  try {
    await prisma.jobPosting.updateMany({ where: { id: postingId, userId }, data: { ...cols, updatedAt: new Date() } });
  } catch (err) {
    // 공용 공고 주소(최종 주소)가 내 다른 공고의 url_key와 겹치면 url은 그대로 두고 내용만 맞춘다.
    if (!isUniqueViolation(err)) throw err;
    const { url, urlKey, platform, ...rest } = cols as typeof cols & { url?: string; urlKey?: string | null };
    void url;
    void urlKey;
    void platform;
    await prisma.jobPosting.updateMany({ where: { id: postingId, userId }, data: { ...rest, updatedAt: new Date() } });
  }
  return getPosting(userId, postingId);
}

/** 공용 공고가 있고 숨기지 않았는가(보관함 공고의 '공고 찾기에서 보기' 링크를 보일지). */
export async function isSharedPostingVisible(id: string): Promise<boolean> {
  return (await prisma.sharedPosting.count({ where: { id, hiddenAt: null } })) > 0;
}

/** 관리자: 공고 찾기에서 숨기기·되돌리기. 없으면 false. */
export async function setSharedPostingHidden(id: string, hidden: boolean): Promise<boolean> {
  const { count } = await prisma.sharedPosting.updateMany({ where: { id }, data: { hiddenAt: hidden ? new Date() : null } });
  return count > 0;
}
