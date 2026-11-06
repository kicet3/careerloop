import "server-only";
/**
 * MCP 개인 접근 토큰(mcp_tokens) 저장소. 원문은 만들 때 한 번만 돌려주고 DB에는 SHA-256(hex)만 둔다.
 * 사용자당 활성 토큰은 MAX_ACTIVE_MCP_TOKENS개까지(사용자별 advisory lock으로 동시 생성도 센다).
 * 폐기는 revoked_at만 채운다(행은 남아 목록에 30일 보인다). 탈퇴하면 FK CASCADE로 함께 지워진다.
 */
import { createHash, randomBytes } from "node:crypto";
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Db } from "@/lib/db/client";
import {
  type CreatedMcpToken,
  type CreateMcpTokenInput,
  MAX_ACTIVE_MCP_TOKENS,
  MCP_DEFAULT_SCOPES,
  MCP_TOKEN_DISPLAY_PREFIX_LEN,
  MCP_TOKEN_PREFIX,
  mcpTokenStatus,
  type McpTokenView,
  REVOKED_TOKEN_VISIBLE_DAYS,
} from "@/lib/domain/mcp";

const DAY_MS = 24 * 60 * 60_000;
/** last_used_at은 이 간격보다 자주 쓰지 않는다(요청마다 UPDATE하지 않게). */
export const LAST_USED_THROTTLE_MS = 5 * 60_000;

export function hashMcpToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 새 토큰 원문·해시·표시용 앞부분. */
export function generateMcpToken(): { token: string; hash: string; prefix: string } {
  const token = `${MCP_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
  return { token, hash: hashMcpToken(token), prefix: token.slice(0, MCP_TOKEN_DISPLAY_PREFIX_LEN) };
}

type Row = {
  id: string;
  name: string;
  prefix: string;
  scopes: string[];
  createdAt: Date;
  lastUsedAt: Date | null;
  expiresAt: Date | null;
  revokedAt: Date | null;
};

const viewSelect = {
  id: true,
  name: true,
  prefix: true,
  scopes: true,
  createdAt: true,
  lastUsedAt: true,
  expiresAt: true,
  revokedAt: true,
} as const;

export function toMcpTokenView(r: Row, now: number = Date.now()): McpTokenView {
  const base = {
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    scopes: r.scopes,
    createdAt: r.createdAt.getTime(),
    lastUsedAt: r.lastUsedAt?.getTime() ?? null,
    expiresAt: r.expiresAt?.getTime() ?? null,
    revokedAt: r.revokedAt?.getTime() ?? null,
  };
  return { ...base, status: mcpTokenStatus(base, now) };
}

/** 활성(폐기 안 됨·만료 전) 토큰 조건. */
const activeWhere = (userId: string, now: Date) => ({
  userId,
  revokedAt: null,
  OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
});

export const TOO_MANY_TOKENS_MESSAGE = `토큰은 ${MAX_ACTIVE_MCP_TOKENS}개까지 만들 수 있습니다. 쓰지 않는 토큰을 폐기해 주세요.`;

/** 토큰을 만든다. 활성 토큰이 이미 상한이면 409 FeatureError. */
export async function createMcpToken(userId: string, input: CreateMcpTokenInput, now: number = Date.now()): Promise<CreatedMcpToken> {
  const { token, hash, prefix } = generateMcpToken();
  const at = new Date(now);
  const row = await prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`mcp-tokens:${userId}`}, 0))`;
    const active = await tx.mcpToken.count({ where: activeWhere(userId, at) });
    if (active >= MAX_ACTIVE_MCP_TOKENS) throw new FeatureError(TOO_MANY_TOKENS_MESSAGE, 409);
    return tx.mcpToken.create({
      data: {
        id: `mcp_${nanoid(16)}`,
        userId,
        name: input.name.trim(),
        tokenHash: hash,
        prefix,
        kind: "pat",
        scopes: [...MCP_DEFAULT_SCOPES],
        expiresAt: input.expiresInDays === null ? null : new Date(now + input.expiresInDays * DAY_MS),
        createdAt: at,
      },
      select: viewSelect,
    });
  });
  return { token, view: toMcpTokenView(row, now) };
}

/** 내 토큰 목록(최근 생성 순): 활성·만료 토큰 전부와 최근 30일 안에 폐기한 토큰. */
export async function listMcpTokens(userId: string, now: number = Date.now()): Promise<McpTokenView[]> {
  const rows = await prisma.mcpToken.findMany({
    where: { userId, OR: [{ revokedAt: null }, { revokedAt: { gt: new Date(now - REVOKED_TOKEN_VISIBLE_DAYS * DAY_MS) } }] },
    orderBy: [{ createdAt: "desc" }, { id: "asc" }],
    select: viewSelect,
  });
  return rows.map((r) => toMcpTokenView(r, now));
}

/** 내 토큰 폐기. 내 토큰이 아니면 null(404). 이미 폐기했으면 그대로 돌려준다(멱등). */
export async function revokeMcpToken(userId: string, id: string, now: number = Date.now()): Promise<McpTokenView | null> {
  await prisma.mcpToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date(now) } });
  const row = await prisma.mcpToken.findFirst({ where: { id, userId }, select: viewSelect });
  return row ? toMcpTokenView(row, now) : null;
}

/** 이 사용자의 활성 토큰을 모두 폐기한다(관리자 거절·정지). 같은 트랜잭션에서 부를 수 있게 db를 받는다. */
export async function revokeAllMcpTokens(userId: string, db: Db = prisma, now: Date = new Date()): Promise<number> {
  const { count } = await db.mcpToken.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now } });
  return count;
}

export interface McpTokenRecord {
  id: string;
  prefix: string;
  scopes: string[];
  expiresAt: Date | null;
  revokedAt: Date | null;
  lastUsedAt: Date | null;
  user: { id: string; name: string | null; status: string };
}

/** 원문 → 토큰 행과 사용자(상태 포함). 없으면 null. 만료·폐기 판정은 호출자(auth.ts)가 한다. */
export async function findMcpToken(token: string): Promise<McpTokenRecord | null> {
  return prisma.mcpToken.findUnique({
    where: { tokenHash: hashMcpToken(token) },
    select: {
      id: true,
      prefix: true,
      scopes: true,
      expiresAt: true,
      revokedAt: true,
      lastUsedAt: true,
      user: { select: { id: true, name: true, status: true } },
    },
  });
}

/** 마지막 사용 시각을 남긴다(LAST_USED_THROTTLE_MS 안에 이미 남겼으면 쓰지 않는다). */
export async function touchMcpToken(id: string, lastUsedAt: Date | null, now: number = Date.now()): Promise<void> {
  if (lastUsedAt && now - lastUsedAt.getTime() < LAST_USED_THROTTLE_MS) return;
  await prisma.mcpToken.updateMany({
    where: { id, OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - LAST_USED_THROTTLE_MS) } }] },
    data: { lastUsedAt: new Date(now) },
  });
}
