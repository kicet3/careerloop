import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { AppEnvError, appEnv, isProduction, missingProductionEnv, validateProductionEnv } = await import("./env");

const FULL = {
  APP_ENV: "PRODUCTION",
  APP_URL: "https://resume.example.com",
  DATABASE_URL: "libsql://db.example.turso.io",
  NEO4J_URI: "neo4j+s://x.databases.neo4j.io",
  NEO4J_USER: "neo4j",
  NEO4J_PASSWORD: "pw",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  ANTHROPIC_API_KEY: "sk-test",
};

describe("appEnv", () => {
  it("비어 있으면 DEV", () => {
    expect(appEnv({})).toBe("DEV");
    expect(appEnv({ APP_ENV: "  " })).toBe("DEV");
    expect(isProduction({})).toBe(false);
  });

  it("DEV·PRODUCTION을 읽는다", () => {
    expect(appEnv({ APP_ENV: "DEV" })).toBe("DEV");
    expect(appEnv({ APP_ENV: " PRODUCTION " })).toBe("PRODUCTION");
    expect(isProduction({ APP_ENV: "PRODUCTION" })).toBe(true);
  });

  it("그 밖의 값은 오류", () => {
    for (const v of ["production", "prod", "MOCK", "TEST"]) {
      expect(() => appEnv({ APP_ENV: v })).toThrow(AppEnvError);
      expect(() => validateProductionEnv({ APP_ENV: v })).toThrow(/DEV 또는 PRODUCTION/);
    }
  });
});

describe("validateProductionEnv", () => {
  it("DEV는 설정이 없어도 통과하고 안내만 돌려준다", () => {
    const r = validateProductionEnv({});
    expect(r.env).toBe("DEV");
    expect(r.warnings.join("\n")).toMatch(/로컬 폴더/);
    expect(r.warnings.join("\n")).toMatch(/NEO4J_URI/);
    expect(validateProductionEnv({ ...FULL, APP_ENV: "DEV" }).warnings).toEqual([]);
  });

  it("DEV 안내: Vercel에서 DEV로 떴거나, NEO4J_URI만 있고 비밀번호가 비었을 때", () => {
    expect(validateProductionEnv({ ...FULL, APP_ENV: "", VERCEL: "1" }).warnings.join("\n")).toMatch(/Vercel에서 APP_ENV=DEV/);
    expect(validateProductionEnv({ ...FULL, APP_ENV: "DEV", NEO4J_PASSWORD: "" }).warnings.join("\n")).toMatch(/NEO4J_PASSWORD/);
  });

  it("PRODUCTION에서 빠진 항목을 모두 나열한다", () => {
    expect(() => validateProductionEnv({ APP_ENV: "PRODUCTION" })).toThrow(AppEnvError);
    expect(missingProductionEnv({ APP_ENV: "PRODUCTION" })).toEqual([
      "APP_URL",
      "DATABASE_URL",
      "NEO4J_URI",
      "NEO4J_USER",
      "NEO4J_PASSWORD",
      "R2_ACCOUNT_ID",
      "R2_ACCESS_KEY_ID",
      "R2_SECRET_ACCESS_KEY",
      "R2_BUCKET",
      "AI 엔진(ANTHROPIC_API_KEY 또는 CLI_PROVIDERS=1 + CLI_PROVIDERS_IN_PRODUCTION=1)",
    ]);
    try {
      validateProductionEnv({ ...FULL, R2_BUCKET: "", NEO4J_PASSWORD: undefined });
      expect.unreachable();
    } catch (e) {
      expect((e as Error).message).toBe("APP_ENV=PRODUCTION 필수 설정이 빠졌습니다: NEO4J_PASSWORD, R2_BUCKET");
    }
  });

  it("APP_URL은 https여야 한다", () => {
    expect(missingProductionEnv({ ...FULL, APP_URL: "http://resume.example.com" })).toEqual(["APP_URL(https:// 주소여야 함)"]);
    expect(missingProductionEnv({ ...FULL, APP_URL: "not a url" })).toEqual(["APP_URL(https:// 주소여야 함)"]);
  });

  it("AI 엔진은 API 키 또는 프로덕션 허용된 CLI", () => {
    const noKey = { ...FULL, ANTHROPIC_API_KEY: "" };
    expect(missingProductionEnv(noKey)).toHaveLength(1);
    expect(missingProductionEnv({ ...noKey, CLI_PROVIDERS: "1" })).toHaveLength(1);
    expect(missingProductionEnv({ ...noKey, CLI_PROVIDERS: "1", CLI_PROVIDERS_IN_PRODUCTION: "1" })).toEqual([]);
  });

  it("모두 있으면 통과", () => {
    expect(validateProductionEnv(FULL)).toEqual({ env: "PRODUCTION", warnings: [] });
  });
});
