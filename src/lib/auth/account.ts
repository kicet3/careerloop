import "server-only";
import { eq } from "drizzle-orm";
import { db, schema } from "@/lib/db/client";
import { ensureDatabase } from "@/lib/db/migrate";
import { hashPassword, verifyPassword } from "./password";

export type AccountInfo = {
  email: string;
  name: string | null;
  hasPassword: boolean;
  googleLinked: boolean;
};

export async function getAccountInfo(
  userId: string,
): Promise<AccountInfo | null> {
  await ensureDatabase();
  const [row] = await db
    .select({
      email: schema.users.email,
      name: schema.users.name,
      passwordHash: schema.users.passwordHash,
      googleSub: schema.users.googleSub,
    })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    hasPassword: !!row.passwordHash,
    googleLinked: !!row.googleSub,
  };
}

export type SetPasswordResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "current_required" | "current_invalid" | "not_found" };

/**
 * 이메일 로그인용 비밀번호 설정·변경. 이미 비밀번호가 있으면 현재 비밀번호가 맞아야 바꾼다.
 * 처음 설정(Google 가입 계정)은 로그인 세션만으로 허용한다.
 */
export async function setAccountPassword(
  userId: string,
  input: { currentPassword?: string; newPassword: string },
): Promise<SetPasswordResult> {
  await ensureDatabase();
  const [row] = await db
    .select({ passwordHash: schema.users.passwordHash })
    .from(schema.users)
    .where(eq(schema.users.id, userId))
    .limit(1);
  if (!row) return { ok: false, reason: "not_found" };
  if (row.passwordHash) {
    if (!input.currentPassword)
      return { ok: false, reason: "current_required" };
    if (!(await verifyPassword(input.currentPassword, row.passwordHash)))
      return { ok: false, reason: "current_invalid" };
  }
  await db
    .update(schema.users)
    .set({ passwordHash: await hashPassword(input.newPassword) })
    .where(eq(schema.users.id, userId));
  return { ok: true, created: !row.passwordHash };
}
