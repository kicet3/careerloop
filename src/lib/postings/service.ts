import "server-only";
/**
 * 공고 보관함 저장소(PostgreSQL job_postings, Prisma). 모든 조회·수정은 userId 조건을 건다(남의 공고는 없는 것과 같다).
 * 같은 사용자 안에서 정규화 URL(url_key)이 같으면 중복 — DuplicatePostingError(409)에 기존 공고 id를 싣는다.
 */
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { isUniqueViolation, stripNul } from "@/lib/db/errors";
import type { JobPostingRow } from "@/lib/db/types";
import {
  postingDeadlineError,
  type JobPosting,
  type JobPostingSummary,
  type PostingCreateInput,
  type PostingStatus,
  type PostingUpdateInput,
} from "@/lib/domain/postings";
import { inferPlatform, isValidUrl, normalizeUrl, withScheme } from "./url";

/** 사용자당 보관 공고 수 상한. */
export const MAX_POSTINGS_PER_USER = 500;
export const POSTING_NOT_FOUND = "공고를 찾을 수 없습니다.";

/** 같은 URL의 공고가 이미 있다(409). 화면은 existingId로 기존 공고를 열어 준다. */
export class DuplicatePostingError extends FeatureError {
  constructor(readonly existingId: string) {
    super("이미 보관함에 있는 공고입니다.", 409);
    this.name = "DuplicatePostingError";
  }
}

/** 빈 값은 null. Postgres text는 NUL을 받지 않으므로 지운다. */
const orNull = (v: string | undefined | null) => (v && v.trim() ? stripNul(v) : null);

export function toJobPosting(row: JobPostingRow): JobPosting {
  return {
    id: row.id,
    company: row.company,
    roleTitle: row.roleTitle,
    url: row.url ?? "",
    urlKey: row.urlKey ?? null,
    platform: row.platform ?? "",
    status: row.status,
    jdText: row.jdText ?? "",
    deadline: row.deadline ?? "",
    deadlineTime: row.deadlineTime ?? "",
    deadlineKind: row.deadlineKind,
    employmentType: row.employmentType,
    workType: row.workType,
    location: row.location ?? "",
    careerLevel: row.careerLevel,
    note: row.note ?? "",
    extractedBy: row.extractedBy,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toSummary(p: JobPosting, hasJd: boolean): JobPostingSummary {
  const { jdText, ...rest } = p;
  void jdText;
  return { ...rest, hasJd };
}

/** 입력 URL → 저장할 url·url_key·platform. 형식이 틀리면 400. 빈 값이면 모두 null. */
function urlFields(raw: string): { url: string | null; urlKey: string | null; platform: string | null } {
  const value = raw.trim();
  if (!value) return { url: null, urlKey: null, platform: null };
  if (!isValidUrl(value)) throw new FeatureError("공고 주소 형식이 올바르지 않습니다. https://로 시작하는 주소를 입력하세요.", 400);
  const url = withScheme(value);
  return { url, urlKey: normalizeUrl(url), platform: orNull(inferPlatform(url)) };
}

async function findByUrlKey(userId: string, urlKey: string, exceptId?: string): Promise<string | null> {
  const row = await prisma.jobPosting.findFirst({
    select: { id: true },
    where: { userId, urlKey, ...(exceptId ? { id: { not: exceptId } } : {}) },
  });
  return row?.id ?? null;
}

/** 같은 URL의 기존 공고 id(없으면 null). URL 가져오기가 LLM을 부르기 전에 쓴다. */
export async function findPostingIdByUrl(userId: string, rawUrl: string): Promise<string | null> {
  if (!isValidUrl(rawUrl)) return null;
  return findByUrlKey(userId, normalizeUrl(withScheme(rawUrl)));
}

/** 목록용 컬럼(JD 원문 제외). */
const summarySelect = {
  id: true,
  userId: true,
  company: true,
  roleTitle: true,
  url: true,
  urlKey: true,
  platform: true,
  status: true,
  deadline: true,
  deadlineTime: true,
  deadlineKind: true,
  employmentType: true,
  workType: true,
  location: true,
  careerLevel: true,
  note: true,
  extractedBy: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.JobPostingSelect;

/** 목록(최근 수정 순, JD 원문 제외). status를 주면 그 상태만. */
export async function listPostings(userId: string, opts: { status?: PostingStatus } = {}): Promise<JobPostingSummary[]> {
  const where: Prisma.JobPostingWhereInput = { userId, ...(opts.status ? { status: opts.status } : {}) };
  const [rows, withJd] = await Promise.all([
    prisma.jobPosting.findMany({
      select: summarySelect,
      where,
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: MAX_POSTINGS_PER_USER,
    }),
    // JD 원문을 읽지 않고 '본문 있음'만 안다(빈 문자열은 저장하지 않으므로 not null이면 있음).
    prisma.jobPosting.findMany({ select: { id: true }, where: { ...where, jdText: { not: null }, NOT: { jdText: "" } } }),
  ]);
  const hasJd = new Set(withJd.map((r) => r.id));
  return rows.map((row) => toSummary(toJobPosting({ ...(row as Omit<JobPostingRow, "jdText">), jdText: null }), hasJd.has(row.id)));
}

export async function getPosting(userId: string, id: string): Promise<JobPosting | null> {
  const row = await prisma.jobPosting.findFirst({ where: { id, userId } });
  return row ? toJobPosting(row as JobPostingRow) : null;
}

/** 새 공고. 중복 URL → DuplicatePostingError(409), 상한 초과 → 409. */
export async function createPosting(
  userId: string,
  input: PostingCreateInput,
  opts: { extractedBy?: string } = {},
): Promise<JobPosting> {
  const deadlineErr = postingDeadlineError(input);
  if (deadlineErr) throw new FeatureError(deadlineErr, 400);
  const urls = urlFields(input.url);
  if (urls.urlKey) {
    const existing = await findByUrlKey(userId, urls.urlKey);
    if (existing) throw new DuplicatePostingError(existing);
  }
  const n = await prisma.jobPosting.count({ where: { userId } });
  if (n >= MAX_POSTINGS_PER_USER) {
    throw new FeatureError(`공고는 ${MAX_POSTINGS_PER_USER}개까지 보관할 수 있습니다. 마감된 공고를 정리해 주세요.`, 409);
  }
  const now = new Date();
  try {
    const row = await prisma.jobPosting.create({
      data: {
        id: nanoid(),
        userId,
        company: stripNul(input.company),
        roleTitle: stripNul(input.roleTitle),
        ...urls,
        status: input.status,
        jdText: orNull(input.jdText),
        deadline: orNull(input.deadline),
        deadlineTime: orNull(input.deadlineTime),
        deadlineKind: input.deadlineKind,
        employmentType: input.employmentType,
        workType: input.workType,
        location: orNull(input.location),
        careerLevel: input.careerLevel,
        note: orNull(input.note),
        extractedBy: stripNul(opts.extractedBy?.slice(0, 40)) || "manual",
        createdAt: now,
        updatedAt: now,
      },
    });
    return toJobPosting(row as JobPostingRow);
  } catch (err) {
    // 동시에 같은 URL을 저장한 경우(unique(user_id, url_key)).
    if (urls.urlKey && isUniqueViolation(err)) {
      const existing = await findByUrlKey(userId, urls.urlKey);
      if (existing) throw new DuplicatePostingError(existing);
    }
    throw err;
  }
}

/**
 * 공고 수정. 보낸 필드만 바꾼다. 마감일만 바꾸고 종류를 보내지 않으면 종류를 맞춰 준다
 * (날짜를 넣으면 '마감일', 날짜를 지우면 '마감일 미공개'). 합친 값이 맞지 않으면 400. 남의 공고면 null.
 */
export async function updatePosting(userId: string, id: string, patch: PostingUpdateInput): Promise<JobPosting | null> {
  const current = await getPosting(userId, id);
  if (!current) return null;

  const deadline = patch.deadline ?? current.deadline;
  const deadlineTime = patch.deadlineTime ?? (patch.deadline === "" ? "" : current.deadlineTime);
  let deadlineKind = patch.deadlineKind ?? current.deadlineKind;
  if (!patch.deadlineKind && patch.deadline !== undefined) {
    if (deadline) deadlineKind = "date";
    else if (deadlineKind === "date") deadlineKind = "unspecified";
  }
  const deadlineErr = postingDeadlineError({ deadline, deadlineTime, deadlineKind });
  if (deadlineErr) throw new FeatureError(deadlineErr, 400);

  const set: Prisma.JobPostingUpdateManyMutationInput & { urlKey?: string | null } = { updatedAt: new Date(), deadline: orNull(deadline), deadlineTime: orNull(deadlineTime), deadlineKind };
  if (patch.company !== undefined) set.company = stripNul(patch.company);
  if (patch.roleTitle !== undefined) set.roleTitle = stripNul(patch.roleTitle);
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.jdText !== undefined) set.jdText = orNull(patch.jdText);
  if (patch.employmentType !== undefined) set.employmentType = patch.employmentType;
  if (patch.workType !== undefined) set.workType = patch.workType;
  if (patch.location !== undefined) set.location = orNull(patch.location);
  if (patch.careerLevel !== undefined) set.careerLevel = patch.careerLevel;
  if (patch.note !== undefined) set.note = orNull(patch.note);
  if (patch.url !== undefined) {
    const urls = urlFields(patch.url);
    if (urls.urlKey) {
      const existing = await findByUrlKey(userId, urls.urlKey, id);
      if (existing) throw new DuplicatePostingError(existing);
    }
    Object.assign(set, urls);
  }

  try {
    const [row] = await prisma.jobPosting.updateManyAndReturn({ where: { id, userId }, data: set });
    return row ? toJobPosting(row as JobPostingRow) : null;
  } catch (err) {
    if (set.urlKey && isUniqueViolation(err)) {
      const existing = await findByUrlKey(userId, set.urlKey, id);
      if (existing) throw new DuplicatePostingError(existing);
    }
    throw err;
  }
}

/**
 * 공고 삭제. 연결된 진단·이력서·지원·가져오기의 postingId는 FK의 ON DELETE SET NULL로 null이 된다(각자의 사본은 남는다).
 */
export async function deletePosting(userId: string, id: string): Promise<boolean> {
  const { count } = await prisma.jobPosting.deleteMany({ where: { id, userId } });
  return count > 0;
}

export interface PostingLinks {
  diagnoses: { id: string; title: string; status: string; createdAt: number }[];
  resumes: { id: string; title: string; company: string; roleTitle: string; updatedAt: number }[];
}

/** 이 공고로 만든 진단·이력서(공고 상세의 관련 목록). 지원 기록은 GET /api/applications?postingId=. */
export async function listPostingLinks(userId: string, postingId: string): Promise<PostingLinks> {
  const [ds, rs] = await Promise.all([
    prisma.diagnosis.findMany({
      select: { id: true, title: true, status: true, createdAt: true },
      where: { userId, postingId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
    prisma.companyResume.findMany({
      select: { id: true, title: true, company: true, roleTitle: true, updatedAt: true },
      where: { userId, postingId },
      orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
      take: 20,
    }),
  ]);
  return {
    diagnoses: ds.map((d) => ({ ...d, createdAt: d.createdAt.getTime() })),
    resumes: rs.map((r) => ({ ...r, updatedAt: r.updatedAt.getTime() })),
  };
}
