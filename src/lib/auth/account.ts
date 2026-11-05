import "server-only";
import { prisma } from "@/lib/db/client";
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
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, passwordHash: true, googleSub: true },
  });
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
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.passwordHash) {
    if (!input.currentPassword)
      return { ok: false, reason: "current_required" };
    if (!(await verifyPassword(input.currentPassword, row.passwordHash)))
      return { ok: false, reason: "current_invalid" };
  }
  await prisma.user.updateMany({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
  return { ok: true, created: !row.passwordHash };
}
