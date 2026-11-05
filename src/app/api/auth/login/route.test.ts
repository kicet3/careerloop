import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
const jar = new Map<string, string>();
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n) } : undefined),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
}));
vi.mock("next/navigation", () => ({ redirect: () => {} }));

const dir = mkdtempSync(path.join(tmpdir(), "rp-login-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

let POST: typeof import("./route").POST;
let close: () => void;

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  const { db, schema } = await import("@/lib/db/client");
  close = () => db.$client.close();
  const { hashPassword } = await import("@/lib/auth/password");
  await db.insert(schema.users).values([
    { id: "pw", email: "pw@x.com", passwordHash: await hashPassword("password123", 4) },
    { id: "g", email: "g@x.com", passwordHash: null, googleSub: "sub-g" },
  ]);
  ({ POST } = await import("./route"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  jar.clear();
});
afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const login = (body: unknown) =>
  POST(
    new Request("http://localhost:3000/api/auth/login", {
      method: "POST",
      body: JSON.stringify(body),
      headers: { origin: "http://localhost:3000", host: "localhost:3000" },
    }),
  );

describe("POST /api/auth/login", () => {
  it("비밀번호 계정은 로그인된다", async () => {
    const res = await login({ email: "pw@x.com", password: "password123" });
    expect(res.status).toBe(200);
    expect(jar.has("rp_session")).toBe(true);
  });

  it("Google로만 가입한 계정(password_hash null)은 비밀번호로 로그인할 수 없다", async () => {
    const res = await login({ email: "g@x.com", password: "anything" });
    expect(res.status).toBe(401);
    expect(jar.has("rp_session")).toBe(false);
  });

  it("PRODUCTION에서도 이메일 로그인은 켜져 있다", async () => {
    vi.stubEnv("APP_ENV", "PRODUCTION");
    vi.stubEnv("APP_URL", "https://localhost:3000");
    const res = await POST(
      new Request("https://localhost:3000/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: "pw@x.com", password: "password123" }),
        headers: { origin: "https://localhost:3000", host: "localhost:3000" },
      }),
    );
    expect(res.status).toBe(200);
  });

  it("틀린 비밀번호는 401", async () => {
    expect((await login({ email: "pw@x.com", password: "wrong-password" })).status).toBe(401);
  });
});
