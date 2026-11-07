import "server-only";
/**
 * 가져온 저장소 정보(github_repo_snapshots): 24시간 안에 읽은 정보는 다시 쓰고, 지나면(또는 '다시 동기화') GitHub에서 새로 읽는다.
 * 새로 읽을 때만 GITHUB_SYNC_LIMIT을 센다. 비공개 저장소는 사용자가 켠 경우(include_private)만, 그리고 회원님이 소유했거나
 * 쓰기 권한이 있거나 커밋한 저장소만 가져온다(남의 저장소를 자기 경험으로 가져오지 않게).
 * project_node_id로 경험 그래프 Project와 잇는다(한 프로젝트에 저장소 하나).
 */
import { nanoid } from "nanoid";
import type { Prisma } from "@/generated/prisma/client";
import { FeatureError } from "@/lib/api/errors";
import { GITHUB_SYNC_LIMIT, hitDbLimit } from "@/lib/auth/db-rate-limit";
import { prisma } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { getGithubToken, type GithubAccountDeps, withGithubReauth } from "./account";
import { fetchRepoFacts, type GithubApiDeps } from "./api";
import { BRIEF_BUILDER_VERSION, buildRepoBrief } from "./brief";
import { GithubError, type GithubThreadRepo, type RepoFacts } from "./types";

export const SNAPSHOT_TTL_MS = 24 * 60 * 60_000;

/**
 * 경험 질문하기 문서 색인(src/lib/rag/chunks/sync.ts): 저장소 요약을 쓰거나 프로젝트 연결을 바꾼 뒤 그 요약의 청크를 다시 만든다.
 * 원문은 넘기지 않는다(sync가 소유 조건으로 다시 읽는다). 실패해도 이 기능은 성공한다(로그만 — 재색인이 복구).
 */
async function syncRepoChunks(userId: string, snapshotIds: readonly string[]): Promise<void> {
  if (snapshotIds.length === 0) return;
  const { syncSourceSafely } = await import("@/lib/rag/chunks/sync");
  for (const id of snapshotIds) await syncSourceSafely(userId, "repo-brief", id);
}

export interface RepoSnapshot {
  id: string;
  repoId: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  facts: RepoFacts;
  brief: string;
  fetchedAt: Date;
  projectNodeId: string | null;
}

type Row = {
  id: string;
  repoId: string;
  fullName: string;
  htmlUrl: string;
  private: boolean;
  data: Prisma.JsonValue;
  brief: string;
  builderVersion: number;
  etag: string | null;
  fetchedAt: Date;
  projectNodeId: string | null;
};

const toSnapshot = (r: Row): RepoSnapshot => ({
  id: r.id,
  repoId: r.repoId,
  fullName: r.fullName,
  htmlUrl: r.htmlUrl,
  private: r.private,
  facts: r.data as unknown as RepoFacts,
  brief: r.brief,
  fetchedAt: r.fetchedAt,
  projectNodeId: r.projectNodeId,
});

export type GithubSnapshotDeps = GithubAccountDeps & { api?: GithubApiDeps };

export class GithubPrivateRepoError extends GithubError {
  constructor() {
    super("비공개 저장소입니다. 계정 설정에서 '비공개 저장소도 가져오기'를 켠 뒤 다시 시도해 주세요.", 403, "github_private");
  }
}

export class GithubNotContributorError extends GithubError {
  constructor() {
    super("회원님이 기여한 저장소만 가져올 수 있습니다.", 403, "github_not_contributor");
  }
}

/** 소유자이거나 쓰기 권한이 있거나 커밋이 1개 이상이어야 가져올 수 있다. */
export function canImportRepo(facts: RepoFacts, login: string): boolean {
  return facts.owner.toLowerCase() === login.toLowerCase() || facts.permissions?.push === true || (facts.my.commitCount ?? 0) > 0;
}

/** brief 규칙 버전이 바뀌었으면 저장한 data로 다시 만든다. */
async function refreshBriefIfNeeded(userId: string, row: Row): Promise<Row> {
  if (row.builderVersion === BRIEF_BUILDER_VERSION) return row;
  const brief = buildRepoBrief(row.data as unknown as RepoFacts);
  await prisma.githubRepoSnapshot.updateMany({ where: { userId, id: row.id }, data: { brief, builderVersion: BRIEF_BUILDER_VERSION } });
  await syncRepoChunks(userId, [row.id]);
  return { ...row, brief, builderVersion: BRIEF_BUILDER_VERSION };
}

/**
 * 저장소 정보: 24시간 안에 읽은 것이 있으면 그대로(force면 새로). 새로 읽으면 { fetched: true }.
 * 연결 없음·만료 409, 한도 429, 저장소 없음 404, 비공개(허용 안 함)·기여 없음 403.
 */
export async function getOrFetchSnapshot(
  userId: string,
  target: { owner: string; repo: string },
  opts: { force?: boolean } = {},
  deps: GithubSnapshotDeps = {},
): Promise<{ snapshot: RepoSnapshot; fetched: boolean }> {
  const nowFn = deps.now ?? Date.now;
  const tokenInfo = await getGithubToken(userId, deps);
  const fullName = `${target.owner}/${target.repo}`;
  const found = (await prisma.githubRepoSnapshot.findFirst({
    where: { userId, fullName: { equals: fullName, mode: "insensitive" } },
  })) as Row | null;
  if (found && found.private && !tokenInfo.includePrivate) throw new GithubPrivateRepoError();
  if (found && !opts.force && nowFn() - found.fetchedAt.getTime() < SNAPSHOT_TTL_MS) {
    return { snapshot: toSnapshot(await refreshBriefIfNeeded(userId, found)), fetched: false };
  }

  const limit = await hitDbLimit(GITHUB_SYNC_LIMIT, userId, nowFn());
  if (!limit.ok) {
    const wait = limit.retryAfterSec >= 3600 ? `${Math.ceil(limit.retryAfterSec / 3600)}시간` : `${Math.ceil(limit.retryAfterSec / 60)}분`;
    throw new FeatureError(`저장소 정보를 너무 자주 새로 읽었습니다. ${wait} 뒤 다시 시도해 주세요.`, 429);
  }

  // 지난번에 일부를 못 읽었으면(warnings) etag를 보내지 않는다 — '다시 동기화'가 304로 덜 읽은 정보를 계속 되살리지 않게.
  const reuseEtag = found && !(found.data as unknown as RepoFacts | null)?.warnings?.length ? found.etag : null;
  const result = await withGithubReauth(userId, () =>
    fetchRepoFacts(
      tokenInfo.token,
      { owner: target.owner, repo: target.repo, login: tokenInfo.login, etag: reuseEtag },
      { fetch: deps.fetch, now: deps.now, ...deps.api },
    ),
  );
  const now = new Date(nowFn());
  if (result.notModified && found) {
    const row = await refreshBriefIfNeeded(userId, found);
    await prisma.githubRepoSnapshot.updateMany({ where: { userId, id: found.id }, data: { fetchedAt: now } });
    await prisma.githubAccount.updateMany({ where: { userId }, data: { lastSyncedAt: now } });
    return { snapshot: toSnapshot({ ...row, fetchedAt: now }), fetched: true };
  }
  if (result.notModified) {
    // 저장한 정보 없이 304가 올 수는 없다(etag를 보내지 않았다) — 안전하게 다시 읽게 한다.
    throw new FeatureError("GitHub에서 정보를 가져오지 못했습니다. 다시 시도해 주세요.", 502);
  }
  const facts = result.facts;
  if (facts.private && !tokenInfo.includePrivate) throw new GithubPrivateRepoError();
  if (!canImportRepo(facts, tokenInfo.login)) throw new GithubNotContributorError();
  const brief = buildRepoBrief(facts);
  const data = {
    fullName: facts.fullName,
    htmlUrl: facts.htmlUrl,
    private: facts.private,
    data: facts as unknown as Prisma.InputJsonValue,
    brief,
    builderVersion: BRIEF_BUILDER_VERSION,
    // 일부를 못 읽은 정보는 etag를 저장하지 않는다(다음에 304 대신 전부 다시 읽게).
    etag: facts.warnings.length ? null : (result.etag?.slice(0, 200) ?? null),
    pushedAt: facts.pushedAt ? new Date(facts.pushedAt) : null,
    fetchedAt: now,
  };
  const row = (await prisma.githubRepoSnapshot.upsert({
    where: { userId_repoId: { userId, repoId: facts.repoId } },
    create: { id: `ghs_${nanoid(16)}`, userId, repoId: facts.repoId, ...data },
    update: data,
  })) as Row;
  await prisma.githubAccount.updateMany({ where: { userId }, data: { lastSyncedAt: now } });
  await syncRepoChunks(userId, [row.id]);
  return { snapshot: toSnapshot(row), fetched: true };
}

/**
 * 저장소를 Project 노드에 잇는다. 이 저장소가 다른 프로젝트에 이어져 있었으면 옮기고, 이 프로젝트에 다른 저장소가 이미 있으면 409.
 */
export async function linkSnapshotToProject(userId: string, snapshotId: string, projectNodeId: string): Promise<void> {
  const other = await prisma.githubRepoSnapshot.findFirst({
    where: { userId, projectNodeId, id: { not: snapshotId } },
    select: { fullName: true },
  });
  if (other) throw new FeatureError(`이 프로젝트에는 이미 다른 저장소(${other.fullName})가 연결되어 있습니다.`, 409);
  try {
    await prisma.githubRepoSnapshot.updateMany({ where: { userId, id: snapshotId }, data: { projectNodeId } });
  } catch (err) {
    if (isUniqueViolation(err)) throw new FeatureError("이 프로젝트에는 이미 다른 저장소가 연결되어 있습니다.", 409);
    throw err;
  }
  await syncRepoChunks(userId, [snapshotId]);
}

/** 지운 Project 노드에 이어 둔 저장소 연결을 푼다(Neo4j id라 FK가 없다). 없는 id는 무시한다. */
export async function unlinkDeletedProjects(userId: string, deletedNodeIds: readonly string[]): Promise<void> {
  if (deletedNodeIds.length === 0) return;
  const affected = await prisma.githubRepoSnapshot.findMany({ where: { userId, projectNodeId: { in: [...deletedNodeIds] } }, select: { id: true } });
  await prisma.githubRepoSnapshot.updateMany({
    where: { userId, projectNodeId: { in: [...deletedNodeIds] } },
    data: { projectNodeId: null },
  });
  await syncRepoChunks(
    userId,
    affected.map((r) => r.id),
  );
}

export async function snapshotForProject(userId: string, projectNodeId: string): Promise<RepoSnapshot | null> {
  const row = (await prisma.githubRepoSnapshot.findFirst({ where: { userId, projectNodeId } })) as Row | null;
  return row ? toSnapshot(await refreshBriefIfNeeded(userId, row)) : null;
}

export async function snapshotByRepoId(userId: string, repoId: string): Promise<RepoSnapshot | null> {
  const row = (await prisma.githubRepoSnapshot.findUnique({ where: { userId_repoId: { userId, repoId } } })) as Row | null;
  return row ? toSnapshot(await refreshBriefIfNeeded(userId, row)) : null;
}

/** 저장소 id → 이어 둔 Project id(목록의 '이미 연결된 프로젝트' 표시). */
export async function linkedProjectsByRepo(userId: string): Promise<Map<string, string>> {
  const rows = await prisma.githubRepoSnapshot.findMany({
    where: { userId, projectNodeId: { not: null } },
    select: { repoId: true, projectNodeId: true },
  });
  return new Map(rows.map((r) => [r.repoId, r.projectNodeId!]));
}

/** 프로젝트 대화 화면용 저장소 표시. 비공개 저장소는 비공개 허용을 끈 뒤에도 이름은 보이지만 AI에는 넣지 않는다(graph-chat.ts). */
export function threadRepoView(s: RepoSnapshot, now: number, includePrivate: boolean): GithubThreadRepo {
  return {
    fullName: s.fullName,
    htmlUrl: s.htmlUrl,
    private: s.private,
    fetchedAt: s.fetchedAt.getTime(),
    stale: now - s.fetchedAt.getTime() >= SNAPSHOT_TTL_MS,
    aiExcluded: s.private && !includePrivate,
  };
}

/** 이 사용자가 지금 비공개 저장소를 AI에 넣는 것을 허용했는가(연결이 없으면 false). */
export async function includePrivateAllowed(userId: string): Promise<boolean> {
  const row = await prisma.githubAccount.findUnique({ where: { userId }, select: { includePrivate: true, status: true } });
  return row?.includePrivate === true;
}
