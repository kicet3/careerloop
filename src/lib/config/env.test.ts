import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const {
  AppEnvError,
  appEnv,
  appUrl,
  cliProvidersAllowed,
  databaseEnv,
  googleLoginConfigured,
  httpsAppUrlHost,
  isProduction,
  missingProductionEnv,
  trustedOriginHosts,
  validateProductionEnv,
} = await import("./env");

const FULL = {
  APP_ENV: "PRODUCTION",
  APP_URL: "https://resume.example.com",
  DATABASE_URL: "libsql://db.example.turso.io",
  DATABASE_AUTH_TOKEN: "token",
  NEO4J_URI: "neo4j+s://x.databases.neo4j.io",
  NEO4J_USER: "neo4j",
  NEO4J_PASSWORD: "pw",
  R2_ACCOUNT_ID: "acct",
  R2_ACCESS_KEY_ID: "id",
  R2_SECRET_ACCESS_KEY: "secret",
  R2_BUCKET: "bucket",
  ANTHROPIC_API_KEY: "sk-test",
  GOOGLE_CLIENT_ID: "cid.apps.googleusercontent.com",
  GOOGLE_CLIENT_SECRET: "gsecret",
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
      "GOOGLE_CLIENT_ID",
      "GOOGLE_CLIENT_SECRET",
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

describe("Google 로그인 설정", () => {
  it("PRODUCTION은 Google 클라이언트 ID·비밀이 필수", () => {
    expect(missingProductionEnv({ ...FULL, GOOGLE_CLIENT_SECRET: " " })).toEqual(["GOOGLE_CLIENT_SECRET"]);
    expect(missingProductionEnv({ ...FULL, GOOGLE_CLIENT_ID: "" })).toEqual(["GOOGLE_CLIENT_ID"]);
  });

  it("googleLoginConfigured는 두 값이 모두 있어야 true", () => {
    expect(googleLoginConfigured(FULL)).toBe(true);
    expect(googleLoginConfigured({ GOOGLE_CLIENT_ID: "x" })).toBe(false);
    expect(googleLoginConfigured({})).toBe(false);
  });

  it("DEV에서 Google 설정이 없으면 안내한다", () => {
    const w = validateProductionEnv({ ...FULL, APP_ENV: "DEV", GOOGLE_CLIENT_ID: "" }).warnings.join("\n");
    expect(w).toMatch(/Google 로그인·회원가입이 꺼집니다/);
    expect(validateProductionEnv({ ...FULL, APP_ENV: "DEV" }).warnings.join("\n")).not.toMatch(/GOOGLE_CLIENT_ID/);
  });
});

describe("DB 설정", () => {
  it("Turso 주소에는 토큰이 필요하다", () => {
    expect(missingProductionEnv({ ...FULL, DATABASE_AUTH_TOKEN: "" })).toEqual(["DATABASE_AUTH_TOKEN(Turso DB 토큰)"]);
    expect(missingProductionEnv({ ...FULL, DATABASE_URL: "libsql://127.0.0.1:8080", DATABASE_AUTH_TOKEN: "" })).toEqual([]);
  });

  it("Vercel에서는 file: DB를 거부하고, 자체 호스팅은 허용한다", () => {
    const fileDb = { ...FULL, DATABASE_URL: "file:/tmp/app.db", DATABASE_AUTH_TOKEN: "" };
    expect(missingProductionEnv(fileDb)).toEqual([]);
    expect(missingProductionEnv({ ...fileDb, VERCEL: "1" })[0]).toMatch(/^DATABASE_URL\(Vercel에서는 file:/);
  });

  it("DATABASE_*가 없으면 Vercel Turso 연동의 TURSO_*를 쓴다", () => {
    expect(databaseEnv({ TURSO_DATABASE_URL: "libsql://t.turso.io", TURSO_AUTH_TOKEN: "tt" })).toEqual({
      url: "libsql://t.turso.io",
      authToken: "tt",
    });
    expect(databaseEnv({ DATABASE_URL: "libsql://d.turso.io", TURSO_DATABASE_URL: "libsql://t.turso.io" }).url).toBe("libsql://d.turso.io");
    const rest = { ...FULL, DATABASE_URL: undefined, DATABASE_AUTH_TOKEN: undefined };
    expect(missingProductionEnv({ ...rest, TURSO_DATABASE_URL: "libsql://t.turso.io", TURSO_AUTH_TOKEN: "tt" })).toEqual([]);
  });

  it("DEV로 뜬 Vercel에서 DB가 file:이면 안내한다", () => {
    const w = validateProductionEnv({ APP_ENV: "DEV", VERCEL: "1", VERCEL_ENV: "preview" }).warnings.join("\n");
    expect(w).toMatch(/DB 설정이 Vercel에서 동작하지 않습니다/);
  });
});

describe("Vercel", () => {
  const PROD = { VERCEL: "1", VERCEL_ENV: "production", VERCEL_PROJECT_PRODUCTION_URL: "careerloop.vercel.app" };
  const PREVIEW = {
    VERCEL: "1",
    VERCEL_ENV: "preview",
    VERCEL_URL: "careerloop-abc123-team.vercel.app",
    VERCEL_BRANCH_URL: "careerloop-git-feat-team.vercel.app",
  };

  it("APP_ENV를 비운 Production 배포는 PRODUCTION, Preview·로컬은 DEV", () => {
    expect(appEnv(PROD)).toBe("PRODUCTION");
    expect(appEnv(PREVIEW)).toBe("DEV");
    expect(appEnv({ VERCEL_ENV: "production" })).toBe("DEV"); // Vercel 밖
    expect(appEnv({ ...PROD, APP_ENV: "DEV" })).toBe("DEV"); // 명시하면 그 값
    expect(() => validateProductionEnv(PROD)).toThrow(AppEnvError);
  });

  it("APP_URL이 없으면 Production은 VERCEL_PROJECT_PRODUCTION_URL, Preview는 브랜치 주소", () => {
    expect(appUrl(PROD)).toBe("https://careerloop.vercel.app");
    expect(appUrl(PREVIEW)).toBe("https://careerloop-git-feat-team.vercel.app");
    expect(appUrl({ ...PREVIEW, VERCEL_BRANCH_URL: "" })).toBe("https://careerloop-abc123-team.vercel.app");
    expect(appUrl({ ...PROD, APP_URL: "https://careerloop.kr" })).toBe("https://careerloop.kr");
    expect(appUrl({ VERCEL_PROJECT_PRODUCTION_URL: "x.vercel.app", VERCEL_ENV: "production" })).toBeNull(); // Vercel 밖
    expect(httpsAppUrlHost(PROD)).toBe("careerloop.vercel.app");
    const noUrl = { ...FULL, APP_URL: undefined };
    expect(missingProductionEnv({ ...noUrl, ...PROD })).toEqual([]);
  });

  it("same-origin: Production은 앱 주소만, Preview는 그 배포 주소도 믿는다", () => {
    expect(trustedOriginHosts({ ...PROD, APP_URL: "https://careerloop.kr" })).toEqual(["careerloop.kr"]);
    expect(trustedOriginHosts({ ...PREVIEW, APP_URL: "https://careerloop.kr" }).sort()).toEqual(
      ["careerloop.kr", "careerloop-abc123-team.vercel.app", "careerloop-git-feat-team.vercel.app"].sort(),
    );
  });

  it("CLI 엔진은 Vercel에서 항상 꺼지고 AI 엔진으로 인정하지 않는다", () => {
    const cli = { CLI_PROVIDERS: "1", CLI_PROVIDERS_IN_PRODUCTION: "1" };
    expect(cliProvidersAllowed(cli)).toBe(true);
    expect(cliProvidersAllowed({ ...cli, VERCEL: "1" })).toBe(false);
    expect(cliProvidersAllowed({ ...cli, APP_ENV: "PRODUCTION", CLI_PROVIDERS_IN_PRODUCTION: "" })).toBe(false);
    const noKey = { ...FULL, ...cli, ANTHROPIC_API_KEY: "" };
    expect(missingProductionEnv(noKey)).toEqual([]);
    expect(missingProductionEnv({ ...noKey, VERCEL: "1" })).toEqual(["AI 엔진(ANTHROPIC_API_KEY — Vercel에서는 CLI 엔진을 쓸 수 없음)"]);
    expect(validateProductionEnv({ ...FULL, ...cli, VERCEL: "1" }).warnings.join("\n")).toMatch(/CLI_PROVIDERS=1을 무시합니다/);
  });
});
