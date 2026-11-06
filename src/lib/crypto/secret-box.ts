/**
 * 비밀 값 암호화(AES-256-GCM). GitHub 토큰처럼 DB에 원문으로 두면 안 되는 값을 감싼다. 순수 함수(키는 인자) — 외부 라이브러리 없음.
 *
 * 형식: `v1.<keyId>.<iv>.<ciphertext>.<tag>` (iv 12바이트, tag 16바이트, 모두 base64url). keyId = sha256(key) 앞 8자(hex).
 * AAD(추가 인증 데이터)로 값의 용도(예: `github-token:<userId>:access`)를 묶는다 — 다른 사용자·다른 칸으로 옮긴 암호문은 풀리지 않는다.
 * 키 교체: 새 키를 GITHUB_TOKEN_ENC_KEY에, 예전 키를 GITHUB_TOKEN_ENC_KEY_PREVIOUS에 두면 예전 암호문도 풀린다(다음 갱신 때 새 키로 다시 저장).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

const VERSION = "v1";
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class SecretBoxError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SecretBoxError";
  }
}

export interface SecretKeys {
  /** 암호화·복호화 키(32바이트). */
  current: Buffer;
  /** 복호화만 하는 예전 키(키 교체 중). */
  previous?: Buffer | null;
}

function assertKey(key: Buffer): void {
  if (!Buffer.isBuffer(key) || key.length !== 32) throw new SecretBoxError("암호화 키는 32바이트여야 합니다.");
}

export function keyIdOf(key: Buffer): string {
  return createHash("sha256").update(key).digest("hex").slice(0, 8);
}

export function seal(plaintext: string, aad: string, keys: SecretKeys): string {
  assertKey(keys.current);
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", keys.current, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [VERSION, keyIdOf(keys.current), iv.toString("base64url"), ct.toString("base64url"), tag.toString("base64url")].join(".");
}

/** 풀지 못하면(형식·키·AAD·변조) SecretBoxError. */
export function open(sealed: string, aad: string, keys: SecretKeys): string {
  assertKey(keys.current);
  const parts = sealed.split(".");
  if (parts.length !== 5 || parts[0] !== VERSION) throw new SecretBoxError("암호문 형식이 올바르지 않습니다.");
  const [, keyId, ivRaw, ctRaw, tagRaw] = parts as [string, string, string, string, string];
  const candidates = [keys.current, ...(keys.previous ? [keys.previous] : [])].filter((k) => k.length === 32 && keyIdOf(k) === keyId);
  if (candidates.length === 0) throw new SecretBoxError("이 암호문을 만든 키가 없습니다.");
  const iv = Buffer.from(ivRaw, "base64url");
  const tag = Buffer.from(tagRaw, "base64url");
  if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) throw new SecretBoxError("암호문 형식이 올바르지 않습니다.");
  const ct = Buffer.from(ctRaw, "base64url");
  for (const key of candidates) {
    try {
      const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_BYTES });
      decipher.setAAD(Buffer.from(aad, "utf8"));
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
    } catch {
      // 다음 후보 키
    }
  }
  throw new SecretBoxError("암호문을 풀지 못했습니다(키·용도가 다르거나 변조됨).");
}
