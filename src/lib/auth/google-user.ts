import "server-only";
import { and, eq, isNull } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";
import type { GoogleClaims } from "./google";

export type GoogleUpsertResult =
  | { ok: true; userId: string; created: boolean; linked: boolean }
  | { ok: false; reason: "conflict" | "unverified_email" };

/** Google이 이 주소의 소유를 보증하는가: gmail 계정이거나, Workspace 계정(hd)의 도메인이 이메일 도메인과 같을 때만. */
export function googleOwnsEmail(claims: Pick<GoogleClaims, "email" | "hd">): boolean {
  const domain = claims.email.trim().toLowerCase().split("@").pop() ?? "";
  if (domain === "gmail.com" || domain === "googlemail.com") return true;
  return !!claims.hd && claims.hd.toLowerCase() === domain;
}

/**
 * Google 계정(검증된 id_token 클레임)으로 사용자를 찾거나 만든다.
 * 1) google_sub가 같은 사용자 → 그대로.
 * 2) 같은 이메일(소문자)의 사용자가 있고 아직 Google을 연결하지 않았다면 연결한다. claims는 email_verified=true만 들어오지만
 *    (validateIdTokenClaims), Google이 그 주소의 소유를 보증할 때(googleOwnsEmail)만 연결한다 — 아니면 unverified_email.
 *    예전 이메일 가입은 이메일 소유를 확인하지 않았으므로, 연결할 때 기존 비밀번호와 세션을 모두 없앤다(남이 먼저 같은 이메일로 가입해 둔
 *    계정에 접근을 남기지 않는다). 이미 다른 Google 계정과 연결돼 있으면 conflict.
 * 3) 없으면 비밀번호 없는 사용자를 만든다.
 */
export async function upsertGoogleUser(claims: GoogleClaims): Promise<GoogleUpsertResult> {
  await ensureDatabase();
  const bySub = await findBySub(claims.sub);
  if (bySub) return { ok: true, userId: bySub, created: false, linked: false };

  const email = claims.email.trim().toLowerCase();
  const [byEmail] = await db
    .select({ id: schema.users.id, googleSub: schema.users.googleSub })
    .from(schema.users)
    .where(eq(schema.users.email, email))
    .limit(1);
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) return { ok: false, reason: "conflict" };
    if (!googleOwnsEmail(claims)) return { ok: false, reason: "unverified_email" };
    const linked = await db
      .transaction(async (tx) => {
        const updated = await tx
          .update(schema.users)
          .set({ googleSub: claims.sub, passwordHash: null })
          .where(and(eq(schema.users.id, byEmail.id), isNull(schema.users.googleSub)))
          .returning({ id: schema.users.id });
        if (updated.length === 0) return false;
        await tx.delete(schema.sessions).where(eq(schema.sessions.userId, byEmail.id));
        return true;
      })
      .catch(() => false);
    if (linked) return { ok: true, userId: byEmail.id, created: false, linked: true };
    // 동시 요청이 먼저 연결했을 수 있다.
    const raced = await findBySub(claims.sub);
    return raced ? { ok: true, userId: raced, created: false, linked: false } : { ok: false, reason: "conflict" };
  }

  const id = nanoid();
  try {
    await db.insert(schema.users).values({ id, email, name: claims.name, passwordHash: null, googleSub: claims.sub });
    return { ok: true, userId: id, created: true, linked: false };
  } catch {
    // 동시 가입(같은 sub 또는 같은 이메일)으로 unique 제약에 걸린 경우
    const raced = await findBySub(claims.sub);
    return raced ? { ok: true, userId: raced, created: false, linked: false } : { ok: false, reason: "conflict" };
  }
}

async function findBySub(sub: string): Promise<string | null> {
  const [row] = await db.select({ id: schema.users.id }).from(schema.users).where(eq(schema.users.googleSub, sub)).limit(1);
  return row?.id ?? null;
}
