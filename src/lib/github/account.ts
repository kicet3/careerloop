import "server-only";
/**
 * 사용자별 GitHub 연결(github_accounts): 연결 저장, 토큰 꺼내기(만료 5분 전이면 갱신), 비공개 저장소 설정, 연결 해제·권한 해지.
 * 토큰은 AES-256-GCM 암호문으로만 둔다(secret-box.ts, AAD = github-token:<userId>:<access|refresh>). 원문은 응답·로그에 남기지 않는다.
 *
 * 갱신은 트랜잭션 안에서 사용자별 advisory lock(pg_advisory_xact_lock)을 잡고 행을 다시 읽은 뒤 한다 — GitHub 갱신 토큰은 쓸 때마다
 * 바뀌므로 동시에 두 번 갱신하면 하나가 폐기된 토큰을 쓰게 된다. 갱신이 거절되면 status='reauth_required'로 바꾸고 토큰 칸을 비운다.
 */
import { nanoid } from "nanoid";
import { prisma } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { open, seal, SecretBoxError, type SecretKeys } from "@/lib/crypto/secret-box";
import { githubConfig, githubInstallUrl, type GithubConfig, type GithubTokenSet, type GithubUser, refreshGithubToken, revokeGithubGrantRequest } from "./oauth";
import { GithubAuthError, GithubUnavailableError, type GithubStatusView } from "./types";

/** 남은 시간이 이보다 짧으면 미리 갱신한다. */
const REFRESH_BEFORE_MS = 5 * 60_000;

export interface GithubAccountDeps {
  fetch?: typeof fetch;
  now?: () => number;
  /** 테스트용: 설정을 바꾼다(기본 process.env). */
  config?: () => GithubConfig | null;
}

export function requireGithubConfig(deps: GithubAccountDeps = {}): GithubConfig {
  const cfg = (deps.config ?? githubConfig)();
  if (!cfg) throw new GithubUnavailableError();
  return cfg;
}

const keysOf = (cfg: GithubConfig): SecretKeys => ({ current: cfg.encKey, previous: cfg.encKeyPrevious });
const aad = (userId: string, kind: "access" | "refresh") => `github-token:${userId}:${kind}`;

function encryptTokens(userId: string, tokens: GithubTokenSet, cfg: GithubConfig) {
  const keys = keysOf(cfg);
  return {
    accessTokenEnc: seal(tokens.accessToken, aad(userId, "access"), keys),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    refreshTokenEnc: tokens.refreshToken ? seal(tokens.refreshToken, aad(userId, "refresh"), keys) : null,
    refreshTokenExpiresAt: tokens.refreshTokenExpiresAt,
  };
}

export async function getGithubStatus(userId: string, deps: GithubAccountDeps = {}): Promise<GithubStatusView> {
  const cfg = (deps.config ?? githubConfig)();
  const empty: GithubStatusView = {
    configured: cfg !== null,
    connected: false,
    status: null,
    login: null,
    avatarUrl: null,
    connectedAt: null,
    includePrivate: false,
    installUrl: githubInstallUrl(cfg),
  };
  // 설정이 없어도 남은 연결 기록은 보여 준다(화면에서 연결 해제만 할 수 있게).
  const row = await prisma.githubAccount.findUnique({
    where: { userId },
    select: { login: true, avatarUrl: true, status: true, connectedAt: true, includePrivate: true },
  });
  if (!row) return empty;
  return {
    ...empty,
    connected: true,
    status: row.status === "active" ? "active" : "reauth_required",
    login: row.login,
    avatarUrl: row.avatarUrl,
    connectedAt: row.connectedAt.getTime(),
    includePrivate: row.includePrivate,
  };
}

export type SaveGithubConnectionResult = { ok: true } | { ok: false; reason: "conflict" };

/**
 * 콜백에서 받은 GitHub 사용자·토큰을 저장한다. 같은 GitHub 계정이 다른 사용자에게 이미 연결돼 있으면 conflict.
 * 이 사용자가 다른 GitHub 계정으로 바꿔 연결하면 이전 연결과 가져온 저장소 정보를 지우고 새로 만든다.
 */
export async function saveGithubConnection(
  userId: string,
  user: GithubUser,
  tokens: GithubTokenSet,
  cfg: GithubConfig,
  deps: Pick<GithubAccountDeps, "now" | "fetch"> = {},
): Promise<SaveGithubConnectionResult> {
  const now = new Date((deps.now ?? Date.now)());
  const enc = encryptTokens(userId, tokens, cfg);
  // 다른 GitHub 계정으로 바꿔 연결하면 이전 계정의 앱 권한을 먼저 해지해 본다(최선 노력 — 실패해도 새 연결은 저장한다).
  const previous = await prisma.githubAccount.findUnique({ where: { userId }, select: { githubUserId: true, accessTokenEnc: true } });
  if (previous && previous.githubUserId !== user.id && previous.accessTokenEnc) {
    try {
      const oldToken = open(previous.accessTokenEnc, aad(userId, "access"), keysOf(cfg));
      if (!(await revokeGithubGrantRequest(cfg, oldToken, { fetch: deps.fetch }))) console.warn("[github] 이전 GitHub 계정의 권한을 해지하지 못했습니다.");
    } catch {
      console.warn("[github] 이전 GitHub 계정의 토큰을 풀지 못해 권한 해지를 건너뜁니다.");
    }
  }
  try {
    return await prisma.$transaction(async (tx) => {
      const other = await tx.githubAccount.findUnique({ where: { githubUserId: user.id }, select: { userId: true } });
      if (other && other.userId !== userId) return { ok: false as const, reason: "conflict" as const };
      const mine = await tx.githubAccount.findUnique({ where: { userId }, select: { githubUserId: true } });
      if (mine && mine.githubUserId !== user.id) await tx.githubAccount.delete({ where: { userId } });
      const data = { login: user.login, avatarUrl: user.avatarUrl, status: "active", ...enc, updatedAt: now };
      await tx.githubAccount.upsert({
        where: { userId },
        create: { id: `gh_${nanoid(16)}`, userId, githubUserId: user.id, connectedAt: now, ...data },
        update: data,
      });
      return { ok: true as const };
    });
  } catch (err) {
    if (isUniqueViolation(err)) return { ok: false, reason: "conflict" };
    throw err;
  }
}

/** 토큰을 비우고 다시 연결을 요구한다(행과 설정·가져온 저장소 정보는 남긴다). */
export async function markGithubReauth(userId: string, now: Date = new Date()): Promise<void> {
  await prisma.githubAccount.updateMany({
    where: { userId },
    data: { status: "reauth_required", accessTokenEnc: null, accessTokenExpiresAt: null, refreshTokenEnc: null, refreshTokenExpiresAt: null, updatedAt: now },
  });
}

export interface GithubTokenInfo {
  token: string;
  login: string;
  includePrivate: boolean;
}

type TokenRow = {
  status: string;
  login: string;
  includePrivate: boolean;
  accessTokenEnc: string | null;
  accessTokenExpiresAt: Date | null;
  refreshTokenEnc: string | null;
  refreshTokenExpiresAt: Date | null;
};

const TOKEN_SELECT = {
  status: true,
  login: true,
  includePrivate: true,
  accessTokenEnc: true,
  accessTokenExpiresAt: true,
  refreshTokenEnc: true,
  refreshTokenExpiresAt: true,
} as const;

function freshAccess(row: TokenRow, now: number): boolean {
  return Boolean(row.accessTokenEnc) && (row.accessTokenExpiresAt === null || row.accessTokenExpiresAt.getTime() - now > REFRESH_BEFORE_MS);
}

/**
 * 쓸 수 있는 사용자 토큰. 연결이 없으면 GithubAuthError(github_not_connected), 만료·폐기·복호화 실패면 reauth_required로 바꾸고 GithubAuthError.
 * 만료 5분 전이면 갱신한다(사용자별 잠금 안에서 행을 다시 읽어 — 다른 요청이 이미 갱신했으면 그 토큰을 쓴다).
 */
export async function getGithubToken(userId: string, deps: GithubAccountDeps = {}): Promise<GithubTokenInfo> {
  const cfg = requireGithubConfig(deps);
  const keys = keysOf(cfg);
  const nowFn = deps.now ?? Date.now;
  const row = await prisma.githubAccount.findUnique({ where: { userId }, select: TOKEN_SELECT });
  if (!row) throw new GithubAuthError("GitHub 계정을 먼저 연결해 주세요.", "github_not_connected");
  if (row.status !== "active") throw new GithubAuthError();
  const info = (r: TokenRow): GithubTokenInfo => ({ token: open(r.accessTokenEnc!, aad(userId, "access"), keys), login: r.login, includePrivate: r.includePrivate });

  try {
    if (freshAccess(row, nowFn())) return info(row);
    const result = await prisma.$transaction(
      async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`github-refresh:${userId}`}, 0))`;
        const cur = await tx.githubAccount.findUnique({ where: { userId }, select: TOKEN_SELECT });
        if (!cur || cur.status !== "active") return { info: null };
        if (freshAccess(cur, nowFn())) return { info: info(cur) as GithubTokenInfo | null };
        const now = nowFn();
        if (!cur.refreshTokenEnc || (cur.refreshTokenExpiresAt && cur.refreshTokenExpiresAt.getTime() <= now)) return { info: null };
        let tokens: GithubTokenSet;
        try {
          tokens = await refreshGithubToken(cfg, open(cur.refreshTokenEnc, aad(userId, "refresh"), keys), { fetch: deps.fetch, now });
        } catch (err) {
          if (err instanceof GithubAuthError) return { info: null };
          throw err;
        }
        await tx.githubAccount.update({ where: { userId }, data: { ...encryptTokens(userId, tokens, cfg), updatedAt: new Date(now) } });
        return { info: { token: tokens.accessToken, login: cur.login, includePrivate: cur.includePrivate } };
      },
      { timeout: 20_000, maxWait: 15_000 },
    );
    if (result.info) return result.info;
  } catch (err) {
    if (!(err instanceof SecretBoxError)) throw err;
    console.warn(`[github] 토큰을 풀지 못해 다시 연결을 요청합니다: ${err.message}`);
  }
  await markGithubReauth(userId, new Date(nowFn()));
  throw new GithubAuthError();
}

/**
 * GitHub API가 401(토큰 폐기 — 사용자가 GitHub에서 앱 권한을 해지한 경우 등)을 돌려주면 연결을 reauth_required로 바꾸고 다시 던진다.
 * 그래야 상태 화면에 '다시 연결'이 보이고 쓸 수 없는 토큰 암호문이 남지 않는다.
 */
export async function withGithubReauth<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GithubAuthError && err.code === "github_reauth") await markGithubReauth(userId).catch(() => {});
    throw err;
  }
}

export async function setGithubIncludePrivate(userId: string, includePrivate: boolean): Promise<boolean> {
  const r = await prisma.githubAccount.updateMany({ where: { userId }, data: { includePrivate, updatedAt: new Date() } });
  return r.count > 0;
}

/**
 * GitHub에서 이 앱의 권한(grant)을 해지한다(최선 노력). 연결이 없거나 설정이 없으면 false. 던지지 않는다.
 * 저장한 접근 토큰이 만료됐으면 먼저 갱신해 본다(실패하면 해지하지 못한 채 false — 사용자는 GitHub 설정에서 직접 지울 수 있다).
 */
export async function revokeGithubGrant(userId: string, deps: GithubAccountDeps = {}): Promise<boolean> {
  const cfg = (deps.config ?? githubConfig)();
  if (!cfg) return false;
  try {
    const { token } = await getGithubToken(userId, deps);
    return await revokeGithubGrantRequest(cfg, token, { fetch: deps.fetch });
  } catch {
    return false;
  }
}

/** 연결 해제: GitHub 권한 해지(최선 노력) → github_accounts 행 삭제(가져온 저장소 정보는 CASCADE). 경험 그래프에 적용한 내용은 남는다. */
export async function disconnectGithub(userId: string, deps: GithubAccountDeps = {}): Promise<{ revoked: boolean; deleted: boolean }> {
  const revoked = await revokeGithubGrant(userId, deps);
  const r = await prisma.githubAccount.deleteMany({ where: { userId } });
  return { revoked, deleted: r.count > 0 };
}
