/**
 * GitHub 연동 공용 타입·오류(서버·클라이언트 공용 — 값만 두고 server-only를 넣지 않는다). docs/GITHUB.md.
 */

/** 저장소 목록 한 줄(GET /api/github/repos). */
export interface GithubRepoListItem {
  id: string;
  fullName: string;
  owner: string;
  name: string;
  description: string | null;
  htmlUrl: string;
  private: boolean;
  fork: boolean;
  archived: boolean;
  stars: number;
  pushedAt: string | null;
  language: string | null;
  /** owned: 내 계정·조직·협업 저장소, contributed: 커밋·PR로 기여한 남의 저장소 */
  source: "owned" | "contributed";
  /** 이미 경험 그래프 프로젝트에 이은 저장소면 그 Project 노드 id. */
  linkedProjectId?: string | null;
}

export interface RepoCommit {
  /** 커밋 메시지 첫 줄(120자 이하). */
  message: string;
  date: string | null;
}

export interface RepoPullRequest {
  title: string;
  state: "open" | "closed" | "merged";
}

export interface RepoDependencyFile {
  file: string;
  names: string[];
}

/** 저장소에서 읽은 사실(github_repo_snapshots.data). brief(AI 요약)는 이것으로 만든다(brief.ts). */
export interface RepoFacts {
  repoId: string;
  fullName: string;
  owner: string;
  name: string;
  htmlUrl: string;
  description: string | null;
  topics: string[];
  homepage: string | null;
  license: string | null;
  private: boolean;
  fork: boolean;
  archived: boolean;
  defaultBranch: string | null;
  stars: number;
  forks: number;
  createdAt: string | null;
  pushedAt: string | null;
  primaryLanguage: string | null;
  /** 상위 8개 언어 비율(%) */
  languages: { name: string; percent: number }[];
  /** 정리한 README 앞부분(6000자 이하). 없으면 null. */
  readme: string | null;
  /** 전체 커밋 수(기본 브랜치, Link 헤더로 어림). 모르면 null. */
  commitsTotal: number | null;
  contributors: number | null;
  /** GitHub 계정 사용자(@login)의 기여 */
  my: {
    login: string;
    commitCount: number | null;
    firstCommitAt: string | null;
    lastCommitAt: string | null;
    commits: RepoCommit[];
    prs: RepoPullRequest[];
    prTotal: number | null;
  };
  topLevel: string[];
  dependencies: RepoDependencyFile[];
  permissions: { admin: boolean; push: boolean; pull: boolean } | null;
  /** 일부 정보를 못 읽었을 때의 안내(사용자에게 보인다). */
  warnings: string[];
}

/** GET /api/github/status */
export interface GithubStatusView {
  configured: boolean;
  connected: boolean;
  status: "active" | "reauth_required" | null;
  login: string | null;
  avatarUrl: string | null;
  connectedAt: number | null;
  includePrivate: boolean;
  /** GitHub에서 저장소를 고르는(앱 설치) 주소. GITHUB_APP_SLUG가 없으면 null. */
  installUrl: string | null;
}

export interface RepoMatchCandidate {
  nodeId: string;
  name: string;
  score: number;
  reason: string;
}

export interface RepoMatch {
  /** 확실히 같은 프로젝트(이미 이었거나 주소가 같다). */
  autoNodeId: string | null;
  candidates: RepoMatchCandidate[];
}

/** GET /api/github/repos/[owner]/[repo] */
export interface GithubRepoDetailView {
  repo: {
    id: string;
    fullName: string;
    htmlUrl: string;
    description: string | null;
    private: boolean;
    fork: boolean;
    archived: boolean;
    stars: number;
    language: string | null;
    pushedAt: string | null;
    fetchedAt: number;
  };
  myCommits: number | null;
  warnings: string[];
  briefChars: number;
  briefPreview: string;
  /** 그래프를 읽지 못하면 null. */
  match: RepoMatch | null;
  linkedProjectId: string | null;
}

/** 프로젝트 대화 화면에 보이는 연결된 저장소(GraphThreadView.repo). */
export interface GithubThreadRepo {
  fullName: string;
  htmlUrl: string;
  private: boolean;
  fetchedAt: number;
  stale: boolean;
  /** 비공개 저장소인데 '비공개 저장소도 가져오기'가 꺼져 있어 AI에 보내지 않는 상태. */
  aiExcluded: boolean;
}

export const GITHUB_UNAVAILABLE_MESSAGE = "관리자가 GitHub 연동을 아직 설정하지 않았습니다.";
export const GITHUB_REAUTH_MESSAGE = "GitHub 연결이 만료되었습니다 — 다시 연결해 주세요.";

/** 응답 오류 코드(code)를 가진 GitHub 기능 오류. */
export class GithubError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly code: string,
  ) {
    super(message);
    this.name = "GithubError";
  }
}

/** 설정이 없어 기능이 꺼짐(503). */
export class GithubUnavailableError extends GithubError {
  constructor() {
    super(GITHUB_UNAVAILABLE_MESSAGE, 503, "github_unavailable");
    this.name = "GithubUnavailableError";
  }
}

/** 연결이 없거나 토큰이 만료·폐기됨(409 — 다시 연결). */
export class GithubAuthError extends GithubError {
  constructor(message: string = GITHUB_REAUTH_MESSAGE, code: "github_reauth" | "github_not_connected" = "github_reauth") {
    super(message, 409, code);
    this.name = "GithubAuthError";
  }
}

/** GitHub API 한도(429). retryAfterSec: x-ratelimit-reset·retry-after에서. */
export class GithubRateLimitError extends GithubError {
  constructor(readonly retryAfterSec: number) {
    super(`GitHub 요청 한도에 걸렸습니다. ${retryAfterSec >= 60 ? `${Math.ceil(retryAfterSec / 60)}분` : `${retryAfterSec}초`} 뒤 다시 시도해 주세요.`, 429, "github_rate_limited");
    this.name = "GithubRateLimitError";
  }
}

export class GithubNotFoundError extends GithubError {
  constructor() {
    super("저장소를 찾을 수 없거나 접근 권한이 없습니다.", 404, "github_not_found");
    this.name = "GithubNotFoundError";
  }
}

/** 그 밖의 GitHub 응답 오류(502). */
export class GithubApiError extends GithubError {
  constructor(readonly detail: string) {
    super("GitHub에서 정보를 가져오지 못했습니다. 잠시 후 다시 시도해 주세요.", 502, "github_failed");
    this.name = "GithubApiError";
  }
}

/** 화면에 보일 ?github_error= 코드 → 문구. 모르는 값은 보여 주지 않는다. */
export const GITHUB_ERROR_MESSAGES: Record<string, string> = {
  access_denied: "GitHub 연결이 취소되었습니다.",
  github_state: "연결 요청이 만료되었거나 올바르지 않습니다. 다시 시도해 주세요.",
  github_failed: "GitHub 연결에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  github_conflict: "이 GitHub 계정은 다른 CareerLoop 계정에 이미 연결되어 있습니다.",
  github_unavailable: GITHUB_UNAVAILABLE_MESSAGE,
  github_session: "로그인한 계정이 연결을 시작한 계정과 다릅니다. 다시 시도해 주세요.",
  rate_limited: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.",
};

export function githubErrorMessage(code: unknown): string | null {
  if (typeof code !== "string") return null;
  return Object.hasOwn(GITHUB_ERROR_MESSAGES, code) ? GITHUB_ERROR_MESSAGES[code]! : null;
}

/** owner: GitHub 사용자·조직 이름 규칙. repo: 영문·숫자·.·_·- 1~100자. */
export const GITHUB_OWNER_RE = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;
export const GITHUB_REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;

/** "owner/repo"를 검사해 나눈다. 틀리면 null. "."·".."는 받지 않는다. */
export function parseFullName(raw: unknown): { owner: string; repo: string } | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/^https?:\/\/(www\.)?github\.com\//i, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  const parts = v.split("/");
  if (parts.length !== 2) return null;
  const [owner, repo] = parts as [string, string];
  return isValidOwnerRepo(owner, repo) ? { owner, repo } : null;
}

export function isValidOwnerRepo(owner: string, repo: string): boolean {
  return GITHUB_OWNER_RE.test(owner) && GITHUB_REPO_RE.test(repo) && repo !== "." && repo !== "..";
}
