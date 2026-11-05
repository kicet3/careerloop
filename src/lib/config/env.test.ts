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
  DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres",
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
  it("PostgreSQL 주소만 받는다(file:·libsql:은 모든 모드에서 거부)", () => {
    expect(missingProductionEnv(FULL)).toEqual([]);
    expect(missingProductionEnv({ ...FULL, DATABASE_URL: "postgres://u:p@127.0.0.1:54329/careerloop" })).toEqual([]);
    for (const url of ["file:/tmp/app.db", "libsql://db.example.turso.io"]) {
      expect(missingProductionEnv({ ...FULL, DATABASE_URL: url })[0]).toMatch(/^DATABASE_URL\(postgres:\/\/ 또는 postgresql:\/\//);
    }
    expect(missingProductionEnv({ ...FULL, DIRECT_URL: "file:x.db" })[0]).toMatch(/^DIRECT_URL\(/);
  });

  it("Vercel에서는 localhost DB를 거부한다", () => {
    const local = { ...FULL, DATABASE_URL: "postgres://u:p@localhost:5432/db" };
    expect(missingProductionEnv(local)).toEqual([]);
    expect(missingProductionEnv({ ...local, VERCEL: "1" })[0]).toMatch(/^DATABASE_URL\(Vercel에서는 localhost/);
  });

  it("DATABASE_URL이 없으면 Supabase Vercel 연동의 POSTGRES_PRISMA_URL·POSTGRES_URL, 직접 주소는 DIRECT_URL → POSTGRES_URL_NON_POOLING", () => {
    expect(databaseEnv({})).toEqual({ url: null, directUrl: null });
    expect(databaseEnv({ POSTGRES_URL: "postgres://b", POSTGRES_PRISMA_URL: "postgres://a" }).url).toBe("postgres://a");
    expect(databaseEnv({ POSTGRES_URL: "postgres://b" }).url).toBe("postgres://b");
    expect(databaseEnv({ DATABASE_URL: "postgres://d", POSTGRES_URL: "postgres://b" }).url).toBe("postgres://d");
    expect(databaseEnv({ POSTGRES_URL_NON_POOLING: "postgres://n" }).directUrl).toBe("postgres://n");
    expect(databaseEnv({ DIRECT_URL: "postgres://x", POSTGRES_URL_NON_POOLING: "postgres://n" }).directUrl).toBe("postgres://x");
    const rest = { ...FULL, DATABASE_URL: undefined };
    expect(missingProductionEnv(rest)).toContain("DATABASE_URL");
    expect(missingProductionEnv({ ...rest, POSTGRES_URL: "postgres://u:p@db.example.com:6543/postgres" })).toEqual([]);
  });

  it("DEV로 뜬 Vercel에서 DB 주소가 없으면 안내한다", () => {
    const w = validateProductionEnv({ APP_ENV: "DEV", VERCEL: "1", VERCEL_ENV: "preview" }).warnings.join("\n");
    expect(w).toMatch(/DB 설정이 Vercel에서 동작하지 않습니다/);
  });

  it("Vercel에서 Supabase Session pooler(5432)를 런타임 주소로 쓰면 안내한다", () => {
    const w = validateProductionEnv({
      ...FULL,
      VERCEL: "1",
      VERCEL_ENV: "production",
      DATABASE_URL: "postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:5432/postgres",
    }).warnings.join("\n");
    expect(w).toMatch(/Transaction pooler\(6543\)/);
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
