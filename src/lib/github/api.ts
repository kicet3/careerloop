/**
 * GitHub REST·GraphQL 읽기(저장소를 복제하지 않는다). 사용자 토큰으로 사용자가 고른 저장소의 공개 메타데이터·README 앞부분·
 * 루트 의존성 파일·본인 커밋 메시지·PR 제목만 읽는다. api.github.com 밖 주소(download_url 등)는 따라가지 않는다.
 *
 * 호출 상한: 한 번에 8초, 저장소 정보 전체 25초, 동시 4개. 선택 정보(README·의존성·PR 등)는 실패해도 경고만 남긴다.
 * 남은 요청 한도(x-ratelimit-remaining)가 100 미만이면 선택 정보를 건너뛴다. 한도 초과(403·429)는 GithubRateLimitError.
 */
import { GITHUB_API, githubHeaders } from "./oauth";
import { sanitizeReadme } from "./brief";
import { isKnownManifest, MAX_MANIFEST_BYTES, parseManifest } from "./manifests";
import {
  GithubApiError,
  GithubAuthError,
  GithubNotFoundError,
  GithubRateLimitError,
  type GithubRepoListItem,
  isValidOwnerRepo,
  type RepoCommit,
  type RepoDependencyFile,
  type RepoFacts,
  type RepoPullRequest,
} from "./types";

export interface GithubApiDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** 호출 하나의 제한 시간(기본 8초). */
  timeoutMs?: number;
  /** 저장소 정보 전체 제한 시간(기본 25초). */
  budgetMs?: number;
}

const CALL_TIMEOUT_MS = 8000;
const BUDGET_MS = 25_000;
const MAX_CONCURRENT = 4;
const LOW_REMAINING = 100;
const README_READ_BYTES = 200 * 1024;
const MAX_MANIFESTS = 6;
const MAX_TOP_LEVEL = 40;
const MAX_MY_COMMITS = 50;
const MAX_MY_PRS = 20;
export const MAX_LIST_REPOS = 200;

/** 제어 문자를 빼고 공백을 정리해 자른다. */
export function cleanText(v: unknown, max: number): string | null {
  if (typeof v !== "string") return null;
  const s = v.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  return s ? s.slice(0, max) : null;
}

/** Link 헤더의 rel="last" 페이지 번호. 없으면 null. */
export function lastPageFromLink(link: string | null): number | null {
  if (!link) return null;
  for (const part of link.split(",")) {
    const m = /<([^>]+)>\s*;\s*rel="last"/.exec(part.trim());
    if (!m) continue;
    try {
      const page = Number(new URL(m[1]!).searchParams.get("page"));
      return Number.isInteger(page) && page > 0 ? page : null;
    } catch {
      return null;
    }
  }
  return null;
}

/** per_page=1 목록의 전체 개수: Link의 마지막 페이지, Link가 없으면 이번 응답의 항목 수. */
export function countFromPerPageOne(link: string | null, items: unknown): number {
  return lastPageFromLink(link) ?? (Array.isArray(items) ? items.length : 0);
}

/** 한도 응답이면 기다릴 초, 아니면 null. */
export function rateLimitWait(res: Pick<Response, "status" | "headers">, nowMs: number): number | null {
  if (res.status !== 403 && res.status !== 429) return null;
  const retryAfter = Number(res.headers.get("retry-after"));
  if (Number.isFinite(retryAfter) && retryAfter > 0) return Math.ceil(retryAfter);
  if (res.headers.get("x-ratelimit-remaining") === "0") {
    const reset = Number(res.headers.get("x-ratelimit-reset"));
    return Number.isFinite(reset) && reset > 0 ? Math.max(1, Math.ceil(reset - nowMs / 1000)) : 60;
  }
  return res.status === 429 ? 60 : null;
}

/** 응답 본문을 바이트 상한까지만 읽는다. */
async function readTextLimited(res: Response, maxBytes: number): Promise<string> {
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < maxBytes) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.byteLength;
  }
  await reader.cancel().catch(() => {});
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(0, maxBytes);
  return new TextDecoder("utf-8", { fatal: false }).decode(buf);
}

function limiter(max: number) {
  let active = 0;
  const queue: (() => void)[] = [];
  return async <T>(fn: () => Promise<T>): Promise<T> => {
    if (active >= max) await new Promise<void>((r) => queue.push(r));
    active++;
    try {
      return await fn();
    } finally {
      active--;
      queue.shift()?.();
    }
  };
}

interface CallOpts {
  accept?: string;
  etag?: string | null;
  method?: string;
  body?: string;
}

class GithubClient {
  remaining: number | null = null;
  private readonly doFetch: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly run = limiter(MAX_CONCURRENT);

  constructor(
    private readonly token: string,
    deps: GithubApiDeps,
    private readonly budget: AbortSignal | null,
  ) {
    this.doFetch = deps.fetch ?? fetch;
    this.now = deps.now ?? Date.now;
    this.timeoutMs = deps.timeoutMs ?? CALL_TIMEOUT_MS;
  }

  get low(): boolean {
    return this.remaining !== null && this.remaining < LOW_REMAINING;
  }

  /** api.github.com 경로만 부른다. 401 → GithubAuthError, 한도 → GithubRateLimitError. 그 밖의 상태는 호출자가 본다. */
  call(path: string, opts: CallOpts = {}): Promise<Response> {
    if (!path.startsWith("/")) throw new GithubApiError("잘못된 경로");
    return this.run(async () => {
      const timeout = AbortSignal.timeout(this.timeoutMs);
      const signal = this.budget ? AbortSignal.any([timeout, this.budget]) : timeout;
      let res: Response;
      try {
        res = await this.doFetch(`${GITHUB_API}${path}`, {
          method: opts.method ?? "GET",
          headers: {
            ...githubHeaders(this.token, opts.accept),
            ...(opts.etag ? { "If-None-Match": opts.etag } : {}),
            ...(opts.body ? { "Content-Type": "application/json" } : {}),
          },
          body: opts.body,
          signal,
          cache: "no-store",
          redirect: "error",
        });
      } catch (err) {
        throw new GithubApiError(`${path.split("?")[0]} 요청 실패: ${err instanceof Error ? err.name : "error"}`);
      }
      // 남은 한도는 REST core 한도만 본다 — search(분당 30회)·graphql은 따로 세므로 그 값으로 선택 정보를 건너뛰면 안 된다.
      const resource = res.headers.get("x-ratelimit-resource");
      const isCore = resource ? resource === "core" : !path.startsWith("/search/") && path !== "/graphql";
      const rem = Number(res.headers.get("x-ratelimit-remaining"));
      if (isCore && res.headers.has("x-ratelimit-remaining") && Number.isFinite(rem)) this.remaining = rem;
      if (res.status === 401) throw new GithubAuthError();
      const wait = rateLimitWait(res, this.now());
      if (wait !== null) throw new GithubRateLimitError(wait);
      return res;
    });
  }

  async json<T>(path: string, opts: CallOpts = {}): Promise<{ res: Response; body: T }> {
    const res = await this.call(path, opts);
    if (res.status === 404) throw new GithubNotFoundError();
    if (!res.ok) throw new GithubApiError(`${path.split("?")[0]} HTTP ${res.status}`);
    const body = (await res.json().catch(() => {
      throw new GithubApiError(`${path.split("?")[0]} JSON 아님`);
    })) as T;
    return { res, body };
  }
}

// ---------------------------------------------------------------------------
// 저장소 목록

const REPO_FIELDS = "databaseId nameWithOwner name description url isPrivate isFork isArchived stargazerCount pushedAt primaryLanguage { name } owner { login }";
const LIST_QUERY = `query {
  viewer {
    repositories(first: 100, ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER], orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { ${REPO_FIELDS} } }
    repositoriesContributedTo(first: 100, includeUserRepositories: false, contributionTypes: [COMMIT, PULL_REQUEST], orderBy: { field: PUSHED_AT, direction: DESC }) { nodes { ${REPO_FIELDS} } }
  }
}`;

type GqlRepo = {
  databaseId?: number;
  nameWithOwner?: string;
  name?: string;
  description?: string | null;
  url?: string;
  isPrivate?: boolean;
  isFork?: boolean;
  isArchived?: boolean;
  stargazerCount?: number;
  pushedAt?: string | null;
  primaryLanguage?: { name?: string } | null;
  owner?: { login?: string };
};

function fromGql(r: GqlRepo, source: GithubRepoListItem["source"]): GithubRepoListItem | null {
  if (typeof r?.databaseId !== "number" || typeof r.nameWithOwner !== "string") return null;
  const [owner, name] = r.nameWithOwner.split("/");
  if (!owner || !name || !isValidOwnerRepo(owner, name)) return null;
  return {
    id: String(r.databaseId),
    fullName: r.nameWithOwner,
    owner,
    name,
    description: cleanText(r.description, 300),
    htmlUrl: `https://github.com/${owner}/${name}`,
    private: r.isPrivate === true,
    fork: r.isFork === true,
    archived: r.isArchived === true,
    stars: typeof r.stargazerCount === "number" ? r.stargazerCount : 0,
    pushedAt: typeof r.pushedAt === "string" ? r.pushedAt : null,
    language: cleanText(r.primaryLanguage?.name, 60),
    source,
  };
}

type RestRepo = {
  id?: number;
  full_name?: string;
  description?: string | null;
  private?: boolean;
  fork?: boolean;
  archived?: boolean;
  stargazers_count?: number;
  pushed_at?: string | null;
  language?: string | null;
};

function fromRest(r: RestRepo): GithubRepoListItem | null {
  return fromGql(
    {
      databaseId: r.id,
      nameWithOwner: r.full_name,
      description: r.description,
      isPrivate: r.private,
      isFork: r.fork,
      isArchived: r.archived,
      stargazerCount: r.stargazers_count,
      pushedAt: r.pushed_at,
      primaryLanguage: r.language ? { name: r.language } : null,
    },
    "owned",
  );
}

/**
 * 내 저장소(소유·협업·조직) + 기여한 저장소(커밋·PR) 목록. GraphQL 한 번으로 읽고, GraphQL을 못 쓰면 REST /user/repos(내 저장소만)로 대신한다.
 * includePrivate가 아니면 비공개 저장소는 뺀다. 최대 MAX_LIST_REPOS개.
 */
export async function listRepos(token: string, opts: { includePrivate: boolean }, deps: GithubApiDeps = {}): Promise<GithubRepoListItem[]> {
  const gh = new GithubClient(token, deps, null);
  let items: GithubRepoListItem[] | null = null;
  try {
    const res = await gh.call("/graphql", { method: "POST", body: JSON.stringify({ query: LIST_QUERY }) });
    const json = (await res.json().catch(() => null)) as {
      data?: { viewer?: { repositories?: { nodes?: GqlRepo[] }; repositoriesContributedTo?: { nodes?: GqlRepo[] } } };
    } | null;
    const viewer = json?.data?.viewer;
    if (res.ok && viewer) {
      items = [
        ...(viewer.repositories?.nodes ?? []).map((r) => fromGql(r, "owned")),
        ...(viewer.repositoriesContributedTo?.nodes ?? []).map((r) => fromGql(r, "contributed")),
      ].filter((x): x is GithubRepoListItem => x !== null);
    }
  } catch (err) {
    if (err instanceof GithubAuthError || err instanceof GithubRateLimitError) throw err;
  }
  if (items === null) {
    const { body } = await gh.json<RestRepo[]>("/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member");
    items = (Array.isArray(body) ? body : []).map(fromRest).filter((x): x is GithubRepoListItem => x !== null);
  }
  const seen = new Set<string>();
  return items
    .filter((r) => (opts.includePrivate || !r.private) && !seen.has(r.id) && seen.add(r.id))
    .slice(0, MAX_LIST_REPOS);
}

// ---------------------------------------------------------------------------
// 저장소 정보

type RestRepoFull = RestRepo & {
  html_url?: string;
  topics?: unknown;
  homepage?: string | null;
  license?: { spdx_id?: string | null } | null;
  forks_count?: number;
  created_at?: string | null;
  default_branch?: string;
  permissions?: { admin?: boolean; push?: boolean; pull?: boolean };
  owner?: { login?: string };
  name?: string;
};

type RestCommit = { commit?: { message?: string; author?: { date?: string } | null; committer?: { date?: string } | null } };

export type FetchRepoResult =
  | { notModified: true; etag: string | null }
  | { notModified: false; facts: RepoFacts; etag: string | null };

const firstLine = (msg: unknown) => cleanText(typeof msg === "string" ? msg.split(/\r?\n/)[0] : null, 120);
const commitDate = (c: RestCommit) => c.commit?.author?.date ?? c.commit?.committer?.date ?? null;

/**
 * 저장소 정보를 읽는다(10~13회 호출). etag를 주면 저장소 메타데이터가 바뀌지 않았을 때 304 → { notModified: true }.
 * 저장소가 없거나 볼 수 없으면 GithubNotFoundError.
 */
export async function fetchRepoFacts(
  token: string,
  input: { owner: string; repo: string; login: string; etag?: string | null },
  deps: GithubApiDeps = {},
): Promise<FetchRepoResult> {
  const { owner, repo, login } = input;
  if (!isValidOwnerRepo(owner, repo)) throw new GithubNotFoundError();
  const budget = AbortSignal.timeout(deps.budgetMs ?? BUDGET_MS);
  const gh = new GithubClient(token, deps, budget);
  const base = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
  const author = encodeURIComponent(login);

  const metaRes = await gh.call(base, { etag: input.etag ?? null });
  const etag = metaRes.headers.get("etag");
  if (metaRes.status === 304) return { notModified: true, etag: input.etag ?? etag };
  if (metaRes.status === 404 || metaRes.status === 403) throw new GithubNotFoundError();
  if (!metaRes.ok) throw new GithubApiError(`repo HTTP ${metaRes.status}`);
  const meta = (await metaRes.json().catch(() => null)) as RestRepoFull | null;
  if (!meta || typeof meta.id !== "number" || typeof meta.full_name !== "string") throw new GithubApiError("repo 응답 형식");
  const [realOwner, realName] = meta.full_name.split("/") as [string, string];
  const realBase = `/repos/${encodeURIComponent(realOwner)}/${encodeURIComponent(realName)}`;

  const warnings: string[] = [];
  const optional = async <T>(label: string, fn: () => Promise<T>, fallback: T): Promise<T> => {
    if (gh.low) {
      if (!warnings.includes(LOW_WARNING)) warnings.push(LOW_WARNING);
      return fallback;
    }
    try {
      return await fn();
    } catch (err) {
      if (err instanceof GithubAuthError) throw err;
      warnings.push(`${label}을(를) 읽지 못했습니다.`);
      return fallback;
    }
  };

  // 1단계: 서로 독립인 호출을 함께(동시 4개까지).
  const [languages, readme, myCommits, myCount, total, contributors, prs, contents] = await Promise.all([
    optional(
      "언어 비율",
      async () => {
        const { body } = await gh.json<Record<string, number>>(`${realBase}/languages`);
        const entries = Object.entries(body ?? {}).filter(([, v]) => typeof v === "number" && v > 0);
        const sum = entries.reduce((a, [, v]) => a + v, 0);
        return entries
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(([name, v]) => ({ name: cleanText(name, 60) ?? "?", percent: sum ? Math.round((v / sum) * 1000) / 10 : 0 }));
      },
      [] as RepoFacts["languages"],
    ),
    optional(
      "README",
      async () => {
        const res = await gh.call(`${realBase}/readme`, { accept: "application/vnd.github.raw+json" });
        if (res.status === 404) return null;
        if (!res.ok) throw new GithubApiError(`readme HTTP ${res.status}`);
        return readTextLimited(res, README_READ_BYTES);
      },
      null as string | null,
    ),
    optional(
      "내 커밋",
      async () => {
        const res = await gh.call(`${realBase}/commits?author=${author}&per_page=${MAX_MY_COMMITS}`);
        if (res.status === 409) return [] as RestCommit[]; // 빈 저장소
        if (!res.ok) throw new GithubApiError(`commits HTTP ${res.status}`);
        const body = (await res.json().catch(() => [])) as RestCommit[];
        return Array.isArray(body) ? body : [];
      },
      null as RestCommit[] | null,
    ),
    optional(
      "내 커밋 수",
      async () => {
        const res = await gh.call(`${realBase}/commits?author=${author}&per_page=1`);
        if (res.status === 409) return { count: 0, last: null as number | null };
        if (!res.ok) throw new GithubApiError(`commits HTTP ${res.status}`);
        const body = await res.json().catch(() => []);
        return { count: countFromPerPageOne(res.headers.get("link"), body), last: lastPageFromLink(res.headers.get("link")) };
      },
      null as { count: number; last: number | null } | null,
    ),
    optional(
      "전체 커밋 수",
      async () => {
        const res = await gh.call(`${realBase}/commits?per_page=1`);
        if (res.status === 409) return 0;
        if (!res.ok) throw new GithubApiError(`commits HTTP ${res.status}`);
        return countFromPerPageOne(res.headers.get("link"), await res.json().catch(() => []));
      },
      null as number | null,
    ),
    optional(
      "기여자 수",
      async () => {
        const res = await gh.call(`${realBase}/contributors?per_page=1&anon=0`);
        if (res.status === 204) return 0;
        if (!res.ok) throw new GithubApiError(`contributors HTTP ${res.status}`);
        return countFromPerPageOne(res.headers.get("link"), await res.json().catch(() => []));
      },
      null as number | null,
    ),
    optional(
      "내 PR",
      async () => {
        const q = [`repo:${realOwner}/${realName}`, "type:pr", `author:${login}`].map(encodeURIComponent).join("+");
        const { body } = await gh.json<{ total_count?: number; items?: { title?: string; state?: string; pull_request?: { merged_at?: string | null } }[] }>(
          `/search/issues?q=${q}&per_page=${MAX_MY_PRS}&sort=created`,
        );
        const items: RepoPullRequest[] = (body.items ?? []).flatMap((it) => {
          const title = cleanText(it.title, 120);
          if (!title) return [];
          const state: RepoPullRequest["state"] = it.pull_request?.merged_at ? "merged" : it.state === "open" ? "open" : "closed";
          return [{ title, state }];
        });
        return { items, total: typeof body.total_count === "number" ? body.total_count : items.length };
      },
      null as { items: RepoPullRequest[]; total: number } | null,
    ),
    optional(
      "최상위 파일 목록",
      async () => {
        const res = await gh.call(`${realBase}/contents/`);
        if (res.status === 404) return [] as { name?: string; type?: string; size?: number }[];
        if (!res.ok) throw new GithubApiError(`contents HTTP ${res.status}`);
        const body = await res.json().catch(() => []);
        return (Array.isArray(body) ? body : []) as { name?: string; type?: string; size?: number }[];
      },
      [] as { name?: string; type?: string; size?: number }[],
    ),
  ]);

  // 2단계: 내 첫 커밋(마지막 페이지)과 루트 의존성 파일.
  const manifests = contents
    .filter((c) => c.type === "file" && typeof c.name === "string" && isKnownManifest(c.name) && (c.size ?? 0) > 0 && (c.size ?? 0) <= MAX_MANIFEST_BYTES)
    .slice(0, MAX_MANIFESTS);
  const [firstCommitAt, dependencies] = await Promise.all([
    myCount && myCount.last && myCount.last > 1
      ? optional(
          "내 첫 커밋",
          async () => {
            const res = await gh.call(`${realBase}/commits?author=${author}&per_page=1&page=${myCount.last}`);
            if (!res.ok) throw new GithubApiError(`commits HTTP ${res.status}`);
            const body = (await res.json().catch(() => [])) as RestCommit[];
            return Array.isArray(body) && body[0] ? commitDate(body[0]) : null;
          },
          null as string | null,
        )
      : Promise.resolve(null),
    Promise.all(
      manifests.map((m) =>
        optional(
          `${m.name}`,
          async (): Promise<RepoDependencyFile | null> => {
            const res = await gh.call(`${realBase}/contents/${encodeURIComponent(m.name!)}`, { accept: "application/vnd.github.raw+json" });
            if (!res.ok) throw new GithubApiError(`manifest HTTP ${res.status}`);
            const names = parseManifest(m.name!, await readTextLimited(res, MAX_MANIFEST_BYTES));
            return names.length ? { file: m.name!, names } : null;
          },
          null,
        ),
      ),
    ),
  ]);

  const commits: RepoCommit[] = (myCommits ?? []).slice(0, MAX_MY_COMMITS).flatMap((c) => {
    const message = firstLine(c.commit?.message);
    return message ? [{ message, date: commitDate(c) }] : [];
  });
  // 커밋 수 호출이 실패했으면 목록 길이로 대신하되, 목록이 꽉 찼으면(50개) 전체 수·첫 커밋을 알 수 없으니 null.
  const commitCount = myCount ? myCount.count : myCommits && myCommits.length < MAX_MY_COMMITS ? myCommits.length : null;
  const lastCommitAt = commits[0]?.date ?? null;
  const facts: RepoFacts = {
    repoId: String(meta.id),
    fullName: meta.full_name,
    owner: realOwner,
    name: realName,
    htmlUrl: `https://github.com/${realOwner}/${realName}`,
    description: cleanText(meta.description, 300),
    topics: (Array.isArray(meta.topics) ? meta.topics : []).flatMap((t) => cleanText(t, 50) ?? []).slice(0, 20),
    homepage: typeof meta.homepage === "string" && /^https?:\/\//i.test(meta.homepage) ? meta.homepage.slice(0, 300) : null,
    license: cleanText(meta.license?.spdx_id, 40),
    private: meta.private === true,
    fork: meta.fork === true,
    archived: meta.archived === true,
    defaultBranch: cleanText(meta.default_branch, 100),
    stars: typeof meta.stargazers_count === "number" ? meta.stargazers_count : 0,
    forks: typeof meta.forks_count === "number" ? meta.forks_count : 0,
    createdAt: typeof meta.created_at === "string" ? meta.created_at : null,
    pushedAt: typeof meta.pushed_at === "string" ? meta.pushed_at : null,
    primaryLanguage: cleanText(meta.language, 60),
    languages,
    readme: readme ? sanitizeReadme(readme) || null : null,
    commitsTotal: total,
    contributors,
    my: {
      login,
      commitCount,
      firstCommitAt: firstCommitAt ?? (commitCount !== null && commitCount <= MAX_MY_COMMITS ? (commits.at(-1)?.date ?? null) : null),
      lastCommitAt,
      commits,
      prs: prs?.items ?? [],
      prTotal: prs?.total ?? null,
    },
    topLevel: contents.flatMap((c) => (typeof c.name === "string" ? [`${c.name}${c.type === "dir" ? "/" : ""}`] : [])).slice(0, MAX_TOP_LEVEL),
    dependencies: dependencies.filter((d): d is RepoDependencyFile => d !== null),
    permissions: meta.permissions
      ? { admin: meta.permissions.admin === true, push: meta.permissions.push === true, pull: meta.permissions.pull !== false }
      : null,
    warnings: warnings.slice(0, 10),
  };
  return { notModified: false, facts, etag };
}

const LOW_WARNING = "GitHub 요청 한도가 얼마 남지 않아 일부 정보(README·의존성 등)를 건너뛰었습니다.";
