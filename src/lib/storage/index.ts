import "server-only";
/**
 * 오브젝트 저장소. R2_ACCOUNT_ID·R2_ACCESS_KEY_ID·R2_SECRET_ACCESS_KEY·R2_BUCKET이 모두 있으면 Cloudflare R2(S3 호환),
 * 없으면 로컬 파일(STORAGE_DIR, 기본 ./data/storage). 키는 users/<userId>/... 형식만 받는다(userKey로 만든다).
 * APP_ENV=PRODUCTION이면 R2만 쓴다 — R2 설정이 없으면 로컬로 내려가지 않고 StorageConfigError를 던진다.
 *
 * - 키 검사: 영문·숫자·._- 와 / 만, 빈 조각·'.'·'..' 금지 → 로컬 경로 탈출과 다른 사용자 접두사 침범을 막는다.
 * - 로컬은 해석한 경로가 저장소 루트 안인지 한 번 더 확인한다.
 */
import { mkdir, readdir, readFile, rm, rmdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  NoSuchKey,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { isProduction } from "@/lib/config/env";

export class StorageKeyError extends Error {
  readonly status = 400;
  constructor(message = "잘못된 저장소 키입니다.") {
    super(message);
    this.name = "StorageKeyError";
  }
}

/** PRODUCTION인데 R2 설정이 없음(503). 시작 시 검사를 통과했다면 생기지 않는다. */
export class StorageConfigError extends Error {
  readonly status = 503;
  constructor(message = "저장소(R2)가 설정되지 않았습니다. APP_ENV=PRODUCTION에서는 로컬 저장소를 쓰지 않습니다.") {
    super(message);
    this.name = "StorageConfigError";
  }
}

// 첫 글자에 '-'·'_'도 허용한다(사용자 id는 nanoid라 그렇게 시작할 수 있다). '.'으로 시작하는 조각('.'·'..'·숨김 파일)은 막는다.
const SEGMENT_RE = /^[A-Za-z0-9_-][A-Za-z0-9._-]{0,127}$/;
const MAX_KEY_LENGTH = 512;

/** 키 형식 검사. users/<userId>/<...> 이고 각 조각이 안전한 문자만 쓴다. */
export function assertValidKey(key: string, opts: { prefix?: boolean } = {}): void {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY_LENGTH) throw new StorageKeyError();
  const parts = key.split("/");
  // 접두사(listByPrefix)는 끝이 '/'일 수 있다.
  if (opts.prefix && parts[parts.length - 1] === "") parts.pop();
  if (parts[0] !== "users" || parts.length < (opts.prefix ? 2 : 3)) throw new StorageKeyError("키는 users/<userId>/... 형식이어야 합니다.");
  for (const p of parts) {
    if (!SEGMENT_RE.test(p) || p === "." || p === ".." || p.includes("..")) throw new StorageKeyError();
  }
}

/** users/<userId>/<parts...> 키를 만든다. 각 조각은 검사를 통과해야 한다. */
export function userKey(userId: string, ...parts: string[]): string {
  const key = ["users", userId, ...parts].join("/");
  assertValidKey(key);
  return key;
}

/** 사용자 접두사(users/<userId>/). listByPrefix에 쓴다. */
export function userPrefix(userId: string, ...parts: string[]): string {
  const key = ["users", userId, ...parts].join("/") + "/";
  assertValidKey(key, { prefix: true });
  return key;
}

export interface PutOptions {
  contentType?: string;
}

interface StorageBackend {
  readonly kind: "r2" | "local";
  put(key: string, body: Buffer, opts: PutOptions): Promise<void>;
  get(key: string): Promise<Buffer | null>;
  delete(key: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
}

// ---------------------------------------------------------------------------
// R2
// ---------------------------------------------------------------------------

function r2Config() {
  const accountId = process.env.R2_ACCOUNT_ID?.trim();
  const accessKeyId = process.env.R2_ACCESS_KEY_ID?.trim();
  const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY?.trim();
  const bucket = process.env.R2_BUCKET?.trim();
  if (!accountId || !accessKeyId || !secretAccessKey || !bucket) return null;
  const endpoint = process.env.R2_ENDPOINT?.trim() || `https://${accountId}.r2.cloudflarestorage.com`;
  return { endpoint, accessKeyId, secretAccessKey, bucket };
}

class R2Backend implements StorageBackend {
  readonly kind = "r2" as const;
  private readonly client: S3Client;
  constructor(private readonly cfg: NonNullable<ReturnType<typeof r2Config>>) {
    this.client = new S3Client({
      region: "auto",
      endpoint: cfg.endpoint,
      credentials: { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey },
    });
  }
  async put(key: string, body: Buffer, opts: PutOptions) {
    await this.client.send(new PutObjectCommand({ Bucket: this.cfg.bucket, Key: key, Body: body, ContentType: opts.contentType }));
  }
  async get(key: string) {
    try {
      const res = await this.client.send(new GetObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
      if (!res.Body) return null;
      return Buffer.from(await res.Body.transformToByteArray());
    } catch (e) {
      if (e instanceof NoSuchKey || (e as { name?: string }).name === "NoSuchKey") return null;
      throw e;
    }
  }
  async delete(key: string) {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.cfg.bucket, Key: key }));
  }
  async list(prefix: string) {
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const res = await this.client.send(new ListObjectsV2Command({ Bucket: this.cfg.bucket, Prefix: prefix, ContinuationToken: token }));
      for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
      token = res.IsTruncated ? res.NextContinuationToken : undefined;
    } while (token);
    return keys.sort();
  }
}

// ---------------------------------------------------------------------------
// 로컬 파일
// ---------------------------------------------------------------------------

class LocalBackend implements StorageBackend {
  readonly kind = "local" as const;
  constructor(private readonly root: string) {}

  private file(key: string): string {
    const p = path.resolve(this.root, ...key.split("/"));
    if (!p.startsWith(this.root + path.sep)) throw new StorageKeyError();
    return p;
  }
  async put(key: string, body: Buffer) {
    const f = this.file(key);
    await mkdir(path.dirname(f), { recursive: true });
    // 로컬 폴백은 개발용이라 원자적 교체 없이 바로 쓴다. 권한은 소유자만.
    await writeFile(f, body, { mode: 0o600 });
  }
  async get(key: string) {
    try {
      return await readFile(this.file(key));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw e;
    }
  }
  async delete(key: string) {
    const f = this.file(key);
    await rm(f, { force: true });
    // 비게 된 상위 폴더를 users/ 아래까지만 정리한다(R2처럼 빈 '폴더'가 남지 않게). 비어 있지 않으면 거기서 멈춘다.
    const stop = path.join(this.root, "users");
    for (let dir = path.dirname(f); dir.startsWith(stop + path.sep); dir = path.dirname(dir)) {
      try {
        await rmdir(dir);
      } catch {
        break;
      }
    }
  }
  async list(prefix: string) {
    // 접두사의 마지막 '/'까지를 디렉터리로 보고 그 아래를 재귀로 훑은 뒤 접두사로 거른다.
    const dirKey = prefix.slice(0, prefix.lastIndexOf("/"));
    const dir = path.resolve(this.root, ...dirKey.split("/"));
    if (dir !== this.root && !dir.startsWith(this.root + path.sep)) throw new StorageKeyError();
    let entries: string[];
    try {
      entries = await readdir(dir, { recursive: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    const keys: string[] = [];
    for (const rel of entries) {
      const key = `${dirKey}/${rel.split(path.sep).join("/")}`;
      if (!key.startsWith(prefix)) continue;
      // 디렉터리는 빼고 파일만(키 형식 검사를 통과하는 것만).
      try {
        assertValidKey(key);
      } catch {
        continue;
      }
      if ((await stat(path.join(dir, rel))).isFile()) keys.push(key);
    }
    return keys.sort();
  }
}

function localRoot(): string {
  return path.resolve(/* turbopackIgnore: true */ process.cwd(), process.env.STORAGE_DIR?.trim() || "data/storage");
}

// 설정이 바뀌면(테스트) 새 백엔드를 만든다.
const globalForStorage = globalThis as unknown as { __storage?: { sig: string; backend: StorageBackend } };

function backend(): StorageBackend {
  const cfg = r2Config();
  if (!cfg && isProduction()) throw new StorageConfigError();
  // 서버리스(Vercel)는 배포 폴더가 읽기 전용이고 유지되지 않는다: APP_ENV=DEV로 떠 있어도 로컬 폴더로 내려가지 않는다.
  if (!cfg && process.env.VERCEL) {
    throw new StorageConfigError("저장소(R2)가 설정되지 않았습니다. Vercel 같은 서버리스 배포에서는 로컬 폴더에 저장할 수 없습니다.");
  }
  const sig = cfg ? `r2:${cfg.endpoint}:${cfg.bucket}:${cfg.accessKeyId}` : `local:${localRoot()}`;
  if (globalForStorage.__storage?.sig !== sig) {
    globalForStorage.__storage = { sig, backend: cfg ? new R2Backend(cfg) : new LocalBackend(localRoot()) };
  }
  return globalForStorage.__storage.backend;
}

export function storageKind(): "r2" | "local" {
  return backend().kind;
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export async function putObject(key: string, body: Buffer | Uint8Array | string, opts: PutOptions = {}): Promise<void> {
  assertValidKey(key);
  const buf = typeof body === "string" ? Buffer.from(body, "utf8") : Buffer.from(body);
  await backend().put(key, buf, opts);
}

/** 없으면 null. */
export async function getObject(key: string): Promise<Buffer | null> {
  assertValidKey(key);
  return backend().get(key);
}

/** 없어도 오류 없이 끝난다. */
export async function deleteObject(key: string): Promise<void> {
  assertValidKey(key);
  await backend().delete(key);
}

/** 접두사(users/<userId>/...) 아래 키 목록(정렬). */
export async function listByPrefix(prefix: string): Promise<string[]> {
  assertValidKey(prefix, { prefix: true });
  return backend().list(prefix);
}

export async function putJson(key: string, value: unknown): Promise<void> {
  await putObject(key, JSON.stringify(value), { contentType: "application/json; charset=utf-8" });
}

/** JSON으로 읽는다. 없으면 null. 스키마 검증은 호출자가 한다. */
export async function getJson(key: string): Promise<unknown | null> {
  const buf = await getObject(key);
  return buf ? (JSON.parse(buf.toString("utf8")) as unknown) : null;
}
