import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

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

const dir = mkdtempSync(path.join(tmpdir(), "rp-account-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;

type Mod = typeof import("./route");
let SET: Mod["POST"];
let LOGIN: typeof import("../../auth/login/route").POST;
let session: typeof import("@/lib/auth/session");
let dbm: typeof import("@/lib/db/client");
let close: () => void;

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  dbm = await import("@/lib/db/client");
  close = () => dbm.db.$client.close();
  await dbm.db
    .insert(dbm.schema.users)
    .values({
      id: "g",
      email: "g@x.com",
      passwordHash: null,
      googleSub: "sub-g",
    });
  session = await import("@/lib/auth/session");
  ({ POST: SET } = await import("./route"));
  ({ POST: LOGIN } = await import("../../auth/login/route"));
});
beforeEach(() => jar.clear());
afterAll(() => {
  close();
  rmSync(dir, { recursive: true, force: true });
});

const req = (url: string, body: unknown) =>
  new Request(`http://localhost:3000${url}`, {
    method: "POST",
    body: JSON.stringify(body),
    headers: { origin: "http://localhost:3000", host: "localhost:3000" },
  });

describe("POST /api/account/password", () => {
  it("로그인하지 않으면 401", async () => {
    expect(
      (await SET(req("/api/account/password", { newPassword: "password123" })))
        .status,
    ).toBe(401);
  });

  it("Google 계정이 비밀번호를 처음 설정하면 이메일로 로그인할 수 있다", async () => {
    await session.createSession("g");
    const res = await SET(
      req("/api/account/password", { newPassword: "password123" }),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ created: true });

    jar.clear();
    expect(
      (
        await LOGIN(
          req("/api/auth/login", { email: "g@x.com", password: "password123" }),
        )
      ).status,
    ).toBe(200);
  });

  it("변경은 현재 비밀번호가 맞아야 하고, 성공하면 다른 세션을 끊는다", async () => {
    await session.createSession("g"); // 다른 기기
    jar.clear();
    await session.createSession("g"); // 현재 기기
    expect(
      (await SET(req("/api/account/password", { newPassword: "newpass456" })))
        .status,
    ).toBe(400);
    expect(
      (
        await SET(
          req("/api/account/password", {
            currentPassword: "wrong",
            newPassword: "newpass456",
          }),
        )
      ).status,
    ).toBe(400);
    const ok = await SET(
      req("/api/account/password", {
        currentPassword: "password123",
        newPassword: "newpass456",
      }),
    );
    expect(ok.status).toBe(200);
    const rows = await dbm.db.select().from(dbm.schema.sessions);
    expect(rows.filter((r) => r.userId === "g")).toHaveLength(1);
    expect(await session.getCurrentUser()).toBeTruthy();
  });

  it("짧은 비밀번호는 400", async () => {
    await session.createSession("g");
    const res = await SET(
      req("/api/account/password", {
        currentPassword: "newpass456",
        newPassword: "short",
      }),
    );
    expect(res.status).toBe(400);
  });
});
