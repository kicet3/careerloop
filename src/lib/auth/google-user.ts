import "server-only";
import { nanoid } from "nanoid";
import { prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
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
  const bySub = await findBySub(claims.sub);
  if (bySub) return { ok: true, userId: bySub, created: false, linked: false };

  const email = claims.email.trim().toLowerCase();
  // 이메일은 저장할 때 소문자로 맞추므로 정확히 일치로 찾는다.
  const byEmail = await prisma.user.findUnique({ where: { email }, select: { id: true, googleSub: true } });
  if (byEmail) {
    if (byEmail.googleSub && byEmail.googleSub !== claims.sub) return { ok: false, reason: "conflict" };
    if (!googleOwnsEmail(claims)) return { ok: false, reason: "unverified_email" };
    const linked = await prisma
      .$transaction(async (tx) => {
        // 조건부 갱신(google_sub가 아직 null일 때만) — 동시 요청 중 하나만 연결한다.
        const updated = await tx.user.updateMany({
          where: { id: byEmail.id, googleSub: null },
          data: { googleSub: claims.sub, passwordHash: null },
        });
        if (updated.count === 0) return false;
        await tx.session.deleteMany({ where: { userId: byEmail.id } });
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
    await prisma.user.create({
      data: { id, email: stripNul(email), name: stripNul(claims.name ?? null), passwordHash: null, googleSub: claims.sub },
    });
    return { ok: true, userId: id, created: true, linked: false };
  } catch {
    // 동시 가입(같은 sub 또는 같은 이메일)으로 unique 제약에 걸린 경우
    const raced = await findBySub(claims.sub);
    return raced ? { ok: true, userId: raced, created: false, linked: false } : { ok: false, reason: "conflict" };
  }
}

async function findBySub(sub: string): Promise<string | null> {
  const row = await prisma.user.findUnique({ where: { googleSub: sub }, select: { id: true } });
  return row?.id ?? null;
}
