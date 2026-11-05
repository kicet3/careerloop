import "server-only";
/**
 * 동의 기록(user_consents) 저장소. append-only — 철회도 agreed=false 행을 새로 쓴다. 현재 상태는 (user, type)별 최신 행.
 * IP는 원문을 저장하지 않고 HMAC 해시(consentIpHash)만, User-Agent는 앞 200자만 둔다.
 */
import { clientIp } from "@/lib/auth/rate-limit";
import { prisma, type Db } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import { consentIpHash } from "./consent-cookie";
import {
  CONSENT_DOCS,
  CONSENT_TYPES,
  missingRequiredConsents,
  type ConsentSource,
  type ConsentType,
  type LatestConsents,
} from "./consents";

export interface ConsentContext {
  source: ConsentSource;
  ipHash?: string | null;
  userAgent?: string | null;
  /** 동의 시각(가입 쿠키의 at). 없으면 지금. */
  at?: Date;
}

/** IP 해시 비밀: CONSENT_HASH_SECRET, 없으면 GOOGLE_CLIENT_SECRET. 둘 다 없으면 해시를 남기지 않는다. */
export function consentHashSecret(env: Record<string, string | undefined> = process.env): string | null {
  return env.CONSENT_HASH_SECRET?.trim() || env.GOOGLE_CLIENT_SECRET?.trim() || null;
}

/** 요청에서 동의 기록용 IP 해시·User-Agent를 뽑는다. */
export function consentContextFromRequest(req: Request, source: ConsentSource, at?: Date): ConsentContext {
  const secret = consentHashSecret();
  return {
    source,
    ipHash: secret ? consentIpHash(clientIp(req), secret) : null,
    userAgent: req.headers.get("user-agent")?.slice(0, 200) ?? null,
    ...(at ? { at } : {}),
  };
}

/** 주어진 항목마다 현재 버전으로 한 행씩 기록한다(값이 undefined인 항목은 건너뛴다). */
export async function recordConsents(
  userId: string,
  choices: Partial<Record<ConsentType, boolean>>,
  ctx: ConsentContext,
  db: Db = prisma,
): Promise<void> {
  const at = ctx.at ?? new Date();
  const data = CONSENT_TYPES.filter((t) => typeof choices[t] === "boolean").map((type) => ({
    userId,
    type,
    version: CONSENT_DOCS[type].version,
    agreed: choices[type] === true,
    source: ctx.source,
    ipHash: ctx.ipHash ?? null,
    userAgent: ctx.userAgent ? stripNul(ctx.userAgent.slice(0, 200)) : null,
    createdAt: at,
  }));
  if (data.length) await db.userConsent.createMany({ data });
}

/** (type)별 최신 기록. */
export async function getLatestConsents(userId: string, db: Db = prisma): Promise<LatestConsents> {
  const rows = await db.userConsent.findMany({
    where: { userId },
    orderBy: [{ type: "asc" }, { createdAt: "desc" }, { id: "desc" }],
    distinct: ["type"],
    select: { type: true, version: true, agreed: true, createdAt: true },
  });
  const out: LatestConsents = {};
  for (const r of rows) {
    if ((CONSENT_TYPES as readonly string[]).includes(r.type)) {
      out[r.type as ConsentType] = { version: r.version, agreed: r.agreed, at: r.createdAt.getTime() };
    }
  }
  return out;
}

/** 현재 버전으로 다시 받아야 하는 필수 항목. */
export async function getMissingConsents(userId: string, db: Db = prisma): Promise<ConsentType[]> {
  return missingRequiredConsents(await getLatestConsents(userId, db));
}

/** 광고성 정보 수신 동의·철회(설정 > 계정). 같은 값이어도 기록을 남긴다(처리 결과 통지 근거). */
export async function setMarketingConsent(userId: string, agreed: boolean, ctx: Omit<ConsentContext, "source"> & { source?: ConsentSource }): Promise<void> {
  await recordConsents(userId, { marketing: agreed }, { source: "account", ...ctx });
}

export interface ConsentHistoryItem {
  type: ConsentType;
  version: string;
  agreed: boolean;
  source: ConsentSource;
  at: number;
}

/** 동의 이력(최신 순). 계정 화면의 '동의 내역'용. */
export async function listConsentHistory(userId: string, limit = 50): Promise<ConsentHistoryItem[]> {
  const rows = await prisma.userConsent.findMany({
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: limit,
    select: { type: true, version: true, agreed: true, source: true, createdAt: true },
  });
  return rows.map((r) => ({
    type: r.type as ConsentType,
    version: r.version,
    agreed: r.agreed,
    source: r.source as ConsentSource,
    at: r.createdAt.getTime(),
  }));
}
