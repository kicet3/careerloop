/**
 * CLI 엔진 연결 API(PGlite 세션): 공용 CLI 로그인 조작·상태 조회(/api/providers/[id])는 관리자만(403),
 * 엔진 목록(/api/providers)은 승인된 모든 사용자 — 단 진행 중인 로그인 링크·코드는 관리자에게만.
 * CLI 실행은 서비스 모듈을 바꿔 끼워 막는다.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ProviderConnection } from "@/lib/domain/providers";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (n: string) => (jar.has(n) ? { value: jar.get(n)! } : undefined),
    set: (n: string, v: string) => void jar.set(n, v),
    delete: (n: string) => void jar.delete(n),
  }),
}));
vi.mock("next/navigation", () => ({
  redirect: (to: string) => {
    throw new Error(`REDIRECT:${to}`);
  },
  notFound: () => {
    throw new Error("NOT_FOUND");
  },
}));
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

const svc = vi.hoisted(() => {
  const conn = (id: "claude-cli" | "codex-cli"): ProviderConnection => ({
    id,
    enabled: true,
    systemLogin: false,
    status: { installed: true, loggedIn: false, account: null, error: "/opt/secret/bin/codex CLI를 찾을 수 없습니다." },
    login: {
      phase: "waiting",
      url: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      needsCode: false,
      codeSubmitted: false,
      message: null,
      expiresAt: 0,
    },
  });
  return {
    conn,
    getConnection: vi.fn(async (id: "claude-cli" | "codex-cli") => conn(id)),
    listConnections: vi.fn(async () => [conn("claude-cli"), conn("codex-cli")]),
    startLogin: vi.fn(async () => undefined),
    submitLoginCode: vi.fn(),
    cancelLogin: vi.fn(),
    logout: vi.fn(async () => undefined),
  };
});
vi.mock("@/lib/providers/service", async (orig) => ({
  ...(await orig<typeof import("@/lib/providers/service")>()),
  getConnection: svc.getConnection,
  listConnections: svc.listConnections,
  startLogin: svc.startLogin,
  submitLoginCode: svc.submitLoginCode,
  cancelLogin: svc.cancelLogin,
  logout: svc.logout,
}));
vi.mock("@/lib/providers/options", () => ({
  listProviderOptions: async () => [
    { id: "codex-cli", label: "ChatGPT", description: "", ready: false, reason: "로그인 필요", account: null },
  ],
}));

let tdb: TestDb;
let list: typeof import("./route");
let one: typeof import("./[id]/route");
let docs: typeof import("@/lib/legal/consents");

const ORIGIN = "http://localhost:3000";
const DAY = 86_400_000;

async function seed(id: string, role = "user") {
  await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, name: id, status: "approved", role } });
  await tdb.prisma.userConsent.createMany({
    data: docs.REQUIRED_CONSENT_TYPES.map((type) => ({ userId: id, type, version: docs.CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
  });
  await tdb.prisma.session.create({
    data: { id: createHash("sha256").update(`tok-${id}`).digest("hex"), userId: id, expiresAt: new Date(Date.now() + 20 * DAY) },
  });
}
const as = (id: string) => jar.set("rp_session", `tok-${id}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });
const getOne = (id = "codex-cli") => one.GET(new Request(`${ORIGIN}/api/providers/${id}`), params(id));
const post = (action: string, extra: Record<string, string> = {}, id = "codex-cli") =>
  one.POST(
    new Request(`${ORIGIN}/api/providers/${id}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: ORIGIN },
      body: JSON.stringify({ action, ...extra }),
    }),
    params(id),
  );

beforeAll(async () => {
  tdb = await createTestDb();
  docs = await import("@/lib/legal/consents");
  list = await import("./route");
  one = await import("./[id]/route");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  vi.clearAllMocks();
  await tdb.reset();
  delete process.env.ADMIN_EMAILS;
  await seed("admin", "admin");
  await seed("u1");
});

describe("/api/providers/[id]: 관리자만", () => {
  it("로그인 안 하면 401, 일반 사용자는 조회·모든 조작이 403(admin_only)이고 CLI를 건드리지 않는다", async () => {
    expect((await getOne()).status).toBe(401);
    expect((await post("login")).status).toBe(401);
    as("u1");
    const res = await getOne();
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "admin_only" });
    for (const [action, extra] of [["login", {}], ["code", { code: "abcdefgh1234" }], ["cancel", {}], ["logout", {}]] as const) {
      const r = await post(action, extra, "claude-cli");
      expect(r.status).toBe(403);
    }
    expect(svc.getConnection).not.toHaveBeenCalled();
    expect(svc.startLogin).not.toHaveBeenCalled();
    expect(svc.submitLoginCode).not.toHaveBeenCalled();
    expect(svc.cancelLogin).not.toHaveBeenCalled();
    expect(svc.logout).not.toHaveBeenCalled();
  });

  it("관리자는 조회·로그인·코드·취소·해제를 할 수 있다", async () => {
    as("admin");
    const res = await getOne();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "codex-cli", login: { userCode: "ABCD-1234" } });
    expect((await post("login")).status).toBe(200);
    expect(svc.startLogin).toHaveBeenCalledWith("codex-cli");
    expect((await post("code", { code: "abcdefgh1234" }, "claude-cli")).status).toBe(200);
    expect(svc.submitLoginCode).toHaveBeenCalledWith("claude-cli", "abcdefgh1234");
    expect((await post("cancel")).status).toBe(200);
    expect(svc.cancelLogin).toHaveBeenCalledWith("codex-cli");
    expect((await post("logout")).status).toBe(200);
    expect(svc.logout).toHaveBeenCalledWith("codex-cli");
  });

  it("다른 출처의 조작은 관리자라도 막는다", async () => {
    as("admin");
    const res = await one.POST(
      new Request(`${ORIGIN}/api/providers/codex-cli`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Origin: "https://evil.example" },
        body: JSON.stringify({ action: "logout" }),
      }),
      params("codex-cli"),
    );
    expect(res.status).toBe(403);
    expect(svc.logout).not.toHaveBeenCalled();
  });
});

describe("/api/providers: 엔진 목록은 누구나, 로그인 링크·코드는 관리자만", () => {
  it("일반 사용자는 엔진 선택지와 상태를 받지만 진행 중인 로그인은 받지 않는다", async () => {
    as("u1");
    const res = await list.GET();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.options).toHaveLength(1);
    expect(body.connections).toHaveLength(2);
    for (const c of body.connections) {
      expect(c.login).toBeNull();
      expect(c.status.error).toBeNull();
    }
    expect(JSON.stringify(body)).not.toContain("ABCD-1234");
  });

  it("관리자는 진행 중인 로그인까지 받는다", async () => {
    as("admin");
    const body = await (await list.GET()).json();
    expect(body.connections[0].login).toMatchObject({ userCode: "ABCD-1234" });
    expect(body.connections[0].status.error).toContain("CLI를 찾을 수 없습니다");
  });
});

describe("/app/connections 화면", () => {
  it("일반 사용자는 상태만(조작 버튼 없음), 관리자는 조작 가능한 카드를 받는다", async () => {
    vi.stubEnv("CLI_PROVIDERS", "1");
    vi.stubEnv("APP_ENV", "DEV");
    vi.stubEnv("VERCEL", "");
    try {
      const page = (await import("@/app/app/connections/page")).default;
      const { renderToStaticMarkup } = await import("react-dom/server");
      as("u1");
      const userHtml = renderToStaticMarkup(await page());
      expect(userHtml).toContain("관리자만 연결할 수 있습니다");
      expect(userHtml).not.toContain("<button");
      expect(userHtml).not.toContain("ABCD-1234");
      as("admin");
      const adminHtml = renderToStaticMarkup(await page());
      expect(adminHtml).not.toContain("관리자만 연결할 수 있습니다");
      expect(adminHtml).toContain("ABCD-1234");
      expect(adminHtml).toContain("<button");
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
