import "server-only";
/**
 * 포트폴리오 공개 링크(portfolio_shares). 계약은 src/lib/domain/portfolio-shares.ts.
 *
 * - 공개하기·공개본 업데이트(publishShare): 소유자의 포트폴리오에서 이름·설명·본문(그래프 Markdown 또는 뽑은 글)·링크를 읽어 행에 그대로 복사하고,
 *   원본 공개를 고른 파일은 원본을 users/<u>/portfolios/<id>/share-<꼬리>.<확장자>로 복사한다. 이후 포트폴리오를 고쳐도 공개본은 그대로다.
 *   공개 중인 링크가 있으면 토큰은 두고 공개본만 바꾼다(포트폴리오당 공개 중인 행은 하나 — 부분 유니크 인덱스).
 * - 공개 끄기(revokeShare): revoked_at을 채우고 공개본 내용을 비우며 원본 사본을 지운다. 링크 다시 만들기(regenerateShareToken): 새 토큰.
 *   두 경우 모두 옛 토큰은 findActiveShareByToken에서 처음부터 없던 토큰과 똑같이 null(404).
 * - 공개 화면·원본·챗봇은 findActiveShareByToken이 돌려준 이 행의 공개본만 쓴다. 회원이 승인 상태가 아니면(정지 등) 공개하지 않는다.
 * - 관리 함수는 모두 userId 소유권을 확인한다. 남의 포트폴리오는 null(라우트에서 404).
 * - 원본 사본 정리: 지우기가 실패해 어디서도 가리키지 않는 share-* 사본은 다음 공개·업데이트·공개 중지 때 다시 지운다(sweepOrphanShareCopies).
 * - 공개 중지·포트폴리오 삭제·탈퇴 때 그 공유의 챗봇 레이트 기록(IP 해시 포함)도 지운다(deleteShareRateEvents).
 */
import { createHash, randomBytes } from "node:crypto";
import { customAlphabet } from "nanoid";
import { SHARE_CHAT_IP_LIMIT, SHARE_CHAT_TOKEN_DAILY_LIMIT } from "@/lib/auth/db-rate-limit";
import { prisma } from "@/lib/db/client";
import { FeatureError } from "@/lib/api/errors";
import { isForeignKeyViolation, isUniqueViolation, stripNul } from "@/lib/db/errors";
import type { PortfolioRow } from "@/lib/db/types";
import {
  ANONYMOUS_OWNER_LABEL,
  isShareTokenShape,
  portfolioSharePath,
  type PortfolioShareOptions,
  type PortfolioShareStatus,
  type PublicPortfolioView,
} from "@/lib/domain/portfolio-shares";
import { PORTFOLIO_KINDS, portfolioOriginalView, type PortfolioKind } from "@/lib/domain/portfolios";
import { copyObject, deleteObject, listByPrefix, userKey, userPrefix } from "@/lib/storage";
import { readPortfolioText } from "./service";

const newId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

/** 공개 주소 토큰(256비트 난수, base64url 43자). */
export function newShareToken(): string {
  return randomBytes(32).toString("base64url");
}

/** 공개본 원본 사본의 키(포트폴리오 폴더 아래 — 포트폴리오를 지우거나 탈퇴하면 함께 지워진다). */
function shareOriginalKey(userId: string, portfolioId: string, ext: string): string {
  return userKey(userId, "portfolios", portfolioId, `share-${Date.now().toString(36)}${randomBytes(4).toString("hex")}.${ext}`);
}

/** 공개본 비교용 해시. 원본은 포트폴리오가 가리키는 원본 키로 비교한다(사본 키가 아니라). */
export function shareContentHash(input: {
  kind: string;
  title: string;
  description: string | null;
  content: string;
  url: string | null;
  sourceOriginalKey: string | null;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([input.kind, input.title, input.description ?? "", input.content, input.url ?? "", input.sourceOriginalKey ?? ""]))
    .digest("hex");
}

async function portfolioHash(row: PortfolioRow, text: string | null, includeOriginal: boolean): Promise<string> {
  return shareContentHash({
    kind: row.kind,
    title: row.title,
    description: row.description ?? null,
    content: text ?? "",
    url: row.kind === "url" ? (row.url ?? null) : null,
    sourceOriginalKey: row.kind === "file" && includeOriginal ? (row.originalKey ?? null) : null,
  });
}

async function ownedPortfolio(userId: string, portfolioId: string): Promise<PortfolioRow | null> {
  return ((await prisma.portfolio.findFirst({ where: { id: portfolioId, userId } })) as PortfolioRow | null) ?? null;
}

type ShareRow = Awaited<ReturnType<typeof prisma.portfolioShare.findFirstOrThrow>>;

function activeShare(userId: string, portfolioId: string): Promise<ShareRow | null> {
  return prisma.portfolioShare.findFirst({ where: { portfolioId, userId, revokedAt: null } });
}

function optionsOf(row: ShareRow): PortfolioShareOptions {
  return { showName: row.showName, includeOriginal: row.includeOriginal, allowChat: row.allowChat, indexable: row.indexable };
}

function toStatus(row: ShareRow, outdated: boolean): PortfolioShareStatus {
  return {
    token: row.token,
    path: portfolioSharePath(row.token),
    options: optionsOf(row),
    publishedAt: row.publishedAt.getTime(),
    viewCount: row.viewCount,
    chatCount: row.chatCount,
    outdated,
  };
}

async function dropKey(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (err) {
    console.error("[portfolio-share] 원본 사본 삭제 실패(다음 공개·공개 중지 때 다시 지운다)", key, err);
  }
}

/** 진행 중인 다른 공개(사본을 막 복사하고 아직 행에 적지 않은 것)를 지우지 않도록 이보다 새 사본은 정리하지 않는다. */
const ORPHAN_GRACE_MS = 10 * 60_000;

/**
 * 포트폴리오 폴더의 공개본 원본 사본(share-<시각36진><난수8>.<확장자>) 중 공개 중인 행이 가리키지 않고 만든 지 ORPHAN_GRACE_MS가 지난 것을 지운다.
 * 공개 중지·업데이트에서 R2 삭제가 실패해 남은 사본을 다음 기회에 치운다. 실패해도 호출자를 막지 않는다.
 */
export async function sweepOrphanShareCopies(userId: string, portfolioId: string, now: number = Date.now()): Promise<number> {
  try {
    const prefix = userPrefix(userId, "portfolios", portfolioId);
    const keys = (await listByPrefix(prefix)).filter((k) => k.slice(prefix.length).startsWith("share-"));
    if (keys.length === 0) return 0;
    const live = await prisma.portfolioShare.findMany({
      select: { originalKey: true },
      where: { portfolioId, userId, revokedAt: null, originalKey: { not: null } },
    });
    const keep = new Set(live.map((r) => r.originalKey));
    let dropped = 0;
    for (const key of keys) {
      if (keep.has(key)) continue;
      const stem = key.slice(prefix.length + "share-".length).replace(/\.[^.]*$/, "");
      const created = parseInt(stem.slice(0, -8), 36);
      if (!Number.isFinite(created) || now - created < ORPHAN_GRACE_MS) continue;
      await deleteObject(key);
      dropped++;
    }
    return dropped;
  } catch (err) {
    console.error("[portfolio-share] 남은 원본 사본 정리 실패", portfolioId, err);
    return 0;
  }
}

/** 공유의 챗봇 레이트 기록(IP·공유별 — key '<공유 id>:<IP 해시>', 공유당 하루 — key '<공유 id>')을 지운다. */
export function shareRateEventsWhere(shareIds: readonly string[]) {
  return {
    OR: [
      ...shareIds.map((id) => ({ bucket: SHARE_CHAT_IP_LIMIT.bucket, key: { startsWith: `${id}:` } })),
      { bucket: SHARE_CHAT_TOKEN_DAILY_LIMIT.bucket, key: { in: [...shareIds] } },
    ],
  };
}

export async function deleteShareRateEvents(shareIds: readonly string[]): Promise<void> {
  if (shareIds.length === 0) return;
  await prisma.rateEvent
    .deleteMany({ where: shareRateEventsWhere(shareIds) })
    .catch((err) => console.error("[portfolio-share] 챗봇 레이트 기록 삭제 실패", err));
}

// ---------------------------------------------------------------------------
// 소유자 관리
// ---------------------------------------------------------------------------

/** 공개 상태. 남의 것·없는 포트폴리오면 null, 공개 중이 아니면 { share: null }. */
export async function getShareStatus(userId: string, portfolioId: string): Promise<{ share: PortfolioShareStatus | null } | null> {
  const row = await ownedPortfolio(userId, portfolioId);
  if (!row) return null;
  const share = await activeShare(userId, portfolioId);
  if (!share) return { share: null };
  const current = await portfolioHash(row, await readPortfolioText(row), share.includeOriginal);
  return { share: toStatus(share, current !== share.contentHash) };
}

/** 내 포트폴리오 중 공개 중인 것의 id(목록의 '공개 중' 표시). */
export async function listSharedPortfolioIds(userId: string): Promise<Set<string>> {
  const rows = await prisma.portfolioShare.findMany({ select: { portfolioId: true }, where: { userId, revokedAt: null } });
  return new Set(rows.map((r) => r.portfolioId));
}

/**
 * 공개하기 또는 공개본 업데이트: 지금 포트폴리오 내용으로 공개본을 새로 만들고 고른 값을 저장한다. 공개 중이면 토큰은 그대로.
 * 공개할 내용이 없으면 FeatureError(409). 남의 것이면 null.
 */
export async function publishShare(userId: string, portfolioId: string, options: PortfolioShareOptions): Promise<PortfolioShareStatus | null> {
  const row = await ownedPortfolio(userId, portfolioId);
  if (!row) return null;
  const kind: PortfolioKind = PORTFOLIO_KINDS.find((k) => k === row.kind) ?? "url";
  const text = (await readPortfolioText(row)) ?? "";
  const hasOriginal = kind === "file" && !!row.originalKey && !!row.originalMime;
  const includeOriginal = hasOriginal && options.includeOriginal;
  if (kind === "graph" && !text.trim()) throw new FeatureError("본문이 없는 포트폴리오는 공개할 수 없습니다. 본문을 먼저 써 주세요.", 409);
  if (kind === "file" && !text.trim() && !includeOriginal) {
    throw new FeatureError("공개할 내용이 없습니다. 원본 파일 보기를 켜거나 글을 뽑을 수 있는 파일로 바꿔 주세요.", 409);
  }
  if (kind === "url" && !row.url) throw new FeatureError("공개할 링크가 없습니다.", 409);

  let ownerName: string | null = null;
  if (options.showName) {
    const user = await prisma.user.findUnique({ select: { name: true }, where: { id: userId } });
    ownerName = stripNul(user?.name?.trim() ?? "").slice(0, 60) || null;
  }

  // 원본 사본: 포트폴리오 원본을 나중에 바꾸거나 지워도 공개본은 공개한 그 파일을 보여 준다.
  let copiedKey: string | null = null;
  if (includeOriginal) {
    if (!row.originalKey!.startsWith(`users/${userId}/`)) throw new FeatureError("원본 파일을 찾지 못했습니다.", 409);
    const ext = row.originalKey!.slice(row.originalKey!.lastIndexOf(".") + 1);
    if (!/^[a-z0-9]{2,5}$/.test(ext)) throw new FeatureError("원본 파일을 찾지 못했습니다.", 409);
    copiedKey = shareOriginalKey(userId, portfolioId, ext);
    if (!(await copyObject(row.originalKey!, copiedKey, { contentType: row.originalMime! }))) {
      throw new FeatureError("원본 파일을 찾지 못했습니다. 원본 보기를 끄고 공개하거나 파일을 다시 올려 주세요.", 409);
    }
  }

  const now = new Date();
  const data = {
    title: row.title,
    description: row.description ?? null,
    kind,
    content: kind === "url" ? "" : text,
    url: kind === "url" ? (row.url ?? null) : null,
    ownerName,
    originalKey: copiedKey,
    originalMime: copiedKey ? row.originalMime : null,
    originalSize: copiedKey ? (row.originalSize ?? 0) : null,
    contentHash: await portfolioHash(row, text, includeOriginal),
    publishedAt: now,
    showName: options.showName,
    includeOriginal,
    allowChat: options.allowChat,
    indexable: options.indexable,
    updatedAt: now,
  };

  const existing = await activeShare(userId, portfolioId);
  let saved: ShareRow | undefined;
  try {
    if (existing) {
      // 공개본 업데이트: 읽은 뒤 다른 창에서 공개를 중지했으면(0행) 새로 공개하지 않는다 — 소유자의 마지막 동작이 '공개 중지'였다.
      [saved] = await prisma.portfolioShare.updateManyAndReturn({ where: { id: existing.id, userId, revokedAt: null }, data });
    } else {
      saved = await prisma.portfolioShare.create({ data: { id: newId(), portfolioId, userId, token: newShareToken(), ...data } });
    }
  } catch (err) {
    await dropKey(copiedKey);
    if (isForeignKeyViolation(err)) return null;
    if (isUniqueViolation(err)) throw new FeatureError("다른 창에서 동시에 공개했습니다. 새로고침한 뒤 다시 시도해 주세요.", 409);
    throw err;
  }
  if (!saved) {
    await dropKey(copiedKey);
    throw new FeatureError("공개 상태가 바뀌었습니다. 새로고침한 뒤 다시 시도해 주세요.", 409);
  }
  if (existing?.originalKey && existing.originalKey !== copiedKey) await dropKey(existing.originalKey);
  await sweepOrphanShareCopies(userId, portfolioId);
  return toStatus(saved, false);
}

/** 공개본은 두고 챗봇·검색 노출만 바꾼다. 남의 것이거나 공개 중이 아니면 null. */
export async function updateShareOptions(
  userId: string,
  portfolioId: string,
  patch: { allowChat?: boolean; indexable?: boolean },
): Promise<PortfolioShareStatus | null> {
  const [row] = await prisma.portfolioShare.updateManyAndReturn({
    where: { portfolioId, userId, revokedAt: null },
    data: {
      ...(patch.allowChat !== undefined ? { allowChat: patch.allowChat } : {}),
      ...(patch.indexable !== undefined ? { indexable: patch.indexable } : {}),
      updatedAt: new Date(),
    },
  });
  return row ? (await getShareStatus(userId, portfolioId))?.share ?? null : null;
}

/** 링크 다시 만들기: 새 토큰으로 바꾼다(옛 주소는 바로 404). 남의 것이거나 공개 중이 아니면 null. */
export async function regenerateShareToken(userId: string, portfolioId: string): Promise<PortfolioShareStatus | null> {
  const [row] = await prisma.portfolioShare.updateManyAndReturn({
    where: { portfolioId, userId, revokedAt: null },
    data: { token: newShareToken(), updatedAt: new Date() },
  });
  return row ? (await getShareStatus(userId, portfolioId))?.share ?? null : null;
}

/** 공개 끄기: 바로 404가 되고 공개본 내용·원본 사본을 지운다(숫자 통계만 남는다). 남의 것이면 null, 공개 중이 아니었어도 true. */
export async function revokeShare(userId: string, portfolioId: string): Promise<boolean | null> {
  if (!(await ownedPortfolio(userId, portfolioId))) return null;
  const share = await activeShare(userId, portfolioId);
  if (!share) return true;
  const { count } = await prisma.portfolioShare.updateMany({
    where: { id: share.id, userId, revokedAt: null },
    data: {
      revokedAt: new Date(),
      title: "",
      description: null,
      content: "",
      url: null,
      ownerName: null,
      originalKey: null,
      originalMime: null,
      originalSize: null,
      updatedAt: new Date(),
    },
  });
  if (count > 0) {
    await dropKey(share.originalKey);
    await deleteShareRateEvents([share.id]);
  }
  await sweepOrphanShareCopies(userId, portfolioId);
  return true;
}

// ---------------------------------------------------------------------------
// 공개 화면(로그인 없음)
// ---------------------------------------------------------------------------

/** 공개 중인 공유(서버 안에서만 — 화면에는 toPublicView만 넘긴다). */
export interface ActiveShare {
  id: string;
  userId: string;
  kind: PortfolioKind;
  title: string;
  description: string | null;
  content: string;
  url: string | null;
  ownerName: string | null;
  originalKey: string | null;
  originalMime: string | null;
  originalSize: number | null;
  publishedAt: Date;
  allowChat: boolean;
  indexable: boolean;
}

/**
 * 토큰으로 공개 중인 공유를 찾는다. 꼴이 틀린 토큰·없는 토큰·공개를 끈 것·다시 만들어 바뀐 옛 토큰·승인 상태가 아닌 회원의 것은 모두 null —
 * 호출자는 어느 경우든 같은 404를 돌려준다.
 */
export async function findActiveShareByToken(token: string): Promise<ActiveShare | null> {
  if (typeof token !== "string" || !isShareTokenShape(token)) return null;
  const row = await prisma.portfolioShare.findUnique({ where: { token }, include: { user: { select: { status: true } } } });
  if (!row || row.revokedAt || row.user.status !== "approved") return null;
  const kind: PortfolioKind = PORTFOLIO_KINDS.find((k) => k === row.kind) ?? "url";
  return {
    id: row.id,
    userId: row.userId,
    kind,
    title: row.title,
    description: row.description,
    content: row.content,
    url: row.url,
    ownerName: row.ownerName,
    originalKey: row.originalKey,
    originalMime: row.originalMime,
    originalSize: row.originalSize,
    publishedAt: row.publishedAt,
    allowChat: row.allowChat,
    indexable: row.indexable,
  };
}

/** 화면에 넘길 공개본(내부 id·저장소 키 없음). */
export function toPublicView(share: ActiveShare): PublicPortfolioView {
  return {
    title: share.title,
    description: share.description,
    kind: share.kind,
    content: share.content,
    url: share.url,
    ownerLabel: share.ownerName?.trim() || ANONYMOUS_OWNER_LABEL,
    original:
      share.kind === "file" && share.originalKey && share.originalMime
        ? { mime: share.originalMime, size: share.originalSize ?? 0, view: portfolioOriginalView(share.originalMime) }
        : null,
    publishedAt: share.publishedAt.getTime(),
    allowChat: share.allowChat,
    indexable: share.indexable,
  };
}

/** 열람 1회(숫자만). 실패해도 화면에는 영향 없다. */
export async function recordShareView(shareId: string): Promise<void> {
  await prisma.portfolioShare
    .updateMany({ where: { id: shareId, revokedAt: null }, data: { viewCount: { increment: 1 } } })
    .catch((err) => console.error("[portfolio-share] 열람 수 기록 실패", err));
}

/** 챗봇 질문 1회(숫자만 — 질문·답 본문은 저장하지 않는다). blocked: 범위 밖·남용으로 답하지 않은 질문. */
export async function recordShareChat(shareId: string, blocked: boolean): Promise<void> {
  await prisma.portfolioShare
    .updateMany({
      where: { id: shareId },
      data: blocked ? { chatCount: { increment: 1 }, chatBlockedCount: { increment: 1 } } : { chatCount: { increment: 1 } },
    })
    .catch((err) => console.error("[portfolio-share] 질문 수 기록 실패", err));
}
