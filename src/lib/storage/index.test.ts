import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-storage-"));
let storage: typeof import("./index");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  storage = await import("./index");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("storage (로컬 폴백)", () => {
  it("R2 설정이 없으면 로컬 파일을 쓴다", () => {
    expect(storage.storageKind()).toBe("local");
  });

  it("쓰기·읽기·목록·삭제", async () => {
    const key = storage.userKey("u1", "resumes", "r1", "v1.json");
    await storage.putJson(key, { a: 1 });
    await storage.putObject(storage.userKey("u1", "resumes", "r1", "v2.json"), "{}");
    await storage.putObject(storage.userKey("u2", "resumes", "r9", "v1.json"), "{}");
    expect(await storage.getJson(key)).toEqual({ a: 1 });
    expect(await storage.listByPrefix(storage.userPrefix("u1", "resumes"))).toEqual([
      "users/u1/resumes/r1/v1.json",
      "users/u1/resumes/r1/v2.json",
    ]);
    expect(await storage.listByPrefix("users/u1/resumes/r1/v2")).toEqual(["users/u1/resumes/r1/v2.json"]);
    await storage.deleteObject(key);
    await storage.deleteObject(key); // 없어도 오류 없음
    expect(await storage.getObject(key)).toBeNull();
    expect(await storage.listByPrefix(storage.userPrefix("nobody"))).toEqual([]);
  });

  it("'-'·'_'로 시작하는 사용자 id(nanoid)도 키로 쓸 수 있다", async () => {
    for (const id of ["-abc123", "_xyz789"]) {
      const key = storage.userKey(id, "resumes", "r1", "v1.json");
      await storage.putObject(key, "{}");
      expect((await storage.getObject(key))?.toString()).toBe("{}");
      expect(await storage.listByPrefix(storage.userPrefix(id))).toEqual([key]);
      await storage.deleteObject(key);
      // 비게 된 폴더도 지운다(users/ 자체는 남는다).
      expect(existsSync(path.join(dir, "users", id))).toBe(false);
    }
    expect(existsSync(path.join(dir, "users"))).toBe(true);
  });

  it("경로 탈출·형식 밖 키를 막는다", async () => {
    for (const bad of ["../x", "users/../../etc/passwd", "users/u1", "other/u1/a", "users/u1/a/../../u2/b", "users//a", "/users/u1/a", "users/u1/a b"]) {
      await expect(storage.getObject(bad)).rejects.toBeInstanceOf(storage.StorageKeyError);
    }
    expect(() => storage.userKey("u1", "..", "x")).toThrow(storage.StorageKeyError);
    expect(() => storage.userKey("../u2", "x")).toThrow(storage.StorageKeyError);
    expect(() => storage.userKey("u1", ".hidden")).toThrow(storage.StorageKeyError);
    await expect(storage.listByPrefix("users/")).rejects.toBeInstanceOf(storage.StorageKeyError);
  });
});

describe("storage (Vercel, APP_ENV 없음)", () => {
  it("서버리스에서는 DEV여도 읽기 전용 로컬 폴더로 내려가지 않고 StorageConfigError(503)", async () => {
    process.env.VERCEL = "1";
    try {
      expect(() => storage.storageKind()).toThrow(storage.StorageConfigError);
      await expect(storage.putObject(storage.userKey("u1", "a.json"), "{}")).rejects.toMatchObject({ status: 503 });
    } finally {
      delete process.env.VERCEL;
    }
    expect(storage.storageKind()).toBe("local");
  });
});

describe("storage (APP_ENV=PRODUCTION)", () => {
  it("R2 설정이 없으면 로컬로 내려가지 않고 StorageConfigError", async () => {
    process.env.APP_ENV = "PRODUCTION";
    try {
      expect(() => storage.storageKind()).toThrow(storage.StorageConfigError);
      await expect(storage.putObject(storage.userKey("u1", "a.json"), "{}")).rejects.toBeInstanceOf(storage.StorageConfigError);
      await expect(storage.getObject(storage.userKey("u1", "a.json"))).rejects.toBeInstanceOf(storage.StorageConfigError);
    } finally {
      delete process.env.APP_ENV;
    }
    expect(storage.storageKind()).toBe("local");
  });

  it("R2 설정이 모두 있으면 R2를 쓴다(네트워크 호출 없음)", () => {
    const keys = { R2_ACCOUNT_ID: "acct", R2_ACCESS_KEY_ID: "id", R2_SECRET_ACCESS_KEY: "secret", R2_BUCKET: "bucket" };
    Object.assign(process.env, keys, { APP_ENV: "PRODUCTION" });
    try {
      expect(storage.storageKind()).toBe("r2");
    } finally {
      for (const k of [...Object.keys(keys), "APP_ENV"]) delete process.env[k];
    }
  });
});
