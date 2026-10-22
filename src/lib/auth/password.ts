import { createHash } from "node:crypto";
import bcrypt from "bcryptjs";

export const BCRYPT_COST = 12;

/**
 * bcrypt는 72바이트 이후를 무시한다. 한글 비밀번호(글자당 3바이트)도 128자까지 온전히 반영되도록
 * SHA-256(base64, 44바이트)으로 먼저 줄인 뒤 bcrypt에 넣는다.
 */
function prehash(password: string): string {
  return createHash("sha256").update(password.normalize("NFC"), "utf8").digest("base64");
}

export async function hashPassword(password: string, cost: number = BCRYPT_COST): Promise<string> {
  return bcrypt.hash(prehash(password), cost);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  try {
    return await bcrypt.compare(prehash(password), hash);
  } catch {
    return false;
  }
}

// 없는 계정으로 로그인할 때도 같은 시간이 걸리게 해서 계정 존재 여부가 응답 시간으로 드러나지 않게 한다.
let dummyHash: Promise<string> | null = null;
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("dummy-password-for-timing");
  await verifyPassword(password, await dummyHash);
  return false;
}
