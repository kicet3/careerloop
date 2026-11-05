/**
 * 세션 가드(PGlite): 승인·동의·관리자 확인, ADMIN_EMAILS 승격, 로그인 시각 기록, 비승인 사용자의 403 코드.
 * next/headers 쿠키는 메모리 Map, redirect·notFound는 던지는 가짜로 바꾼다.
 */
import { createHash } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { CONSENT_DOCS, REQUIRED_CONSENT_TYPES } from "@/lib/legal/consents";

vi.mock("server-only", () => ({}));

const jar = vi.hoisted(() => new Map<string, string>());
vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => (jar.has(name) ? { value: jar.get(name)! } : undefined),
    set: (name: string, value: string) => void jar.set(name, value),
    delete: (name: string) => void jar.delete(name),
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
// React cache()는 요청 범위가 없으면 매번 새로 부른다 — 테스트마다 새 값을 읽게 그대로 통과시킨다.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), cache: <T,>(fn: T) => fn }));

let tdb: TestDb;
let session: typeof import("./session");

const tokens: Record<string, string> = {};
async function seedUser(id: string, data: { status?: string; role?: string; consent?: boolean; email?: string; googleSub?: string } = {},
) {
  await tdb.prisma.user.create({
    data: {
      id,
      email: data.email ?? `${id}@x.com`,
      passwordHash: data.googleSub ? null : "x",
      googleSub: data.googleSub ?? null,
      status: data.status ?? "pending",
      role: data.role ?? "user",
    },
  });
  const token = `tok-${id}`;
  tokens[id] = token;
  await tdb.prisma.session.create({
    data: { id: createHash("sha256").update(token).digest("hex"), userId: id, expiresAt: new Date(Date.now() + 20 * 86_400_000) },
  });
  if (data.consent !== false) {
    await tdb.prisma.userConsent.createMany({
      data: REQUIRED_CONSENT_TYPES.map((type) => ({ userId: id, type, version: CONSENT_DOCS[type].version, agreed: true, source: "signup" })),
    });
  }
}
const as = (id: string) => jar.set("rp_session", tokens[id]!);

beforeAll(async () => {
  tdb = await createTestDb();
  session = await import("./session");
});
afterAll(() => tdb.close());
beforeEach(async () => {
  jar.clear();
  await tdb.reset();
  delete process.env.ADMIN_EMAILS;
});

async function apiStatus(fn: () => Promise<unknown>) {
  const r = await fn();
  return r instanceof Response ? { status: r.status, body: await r.json() } : { status: 200, user: r };
}

describe("API 가드", () => {
  it("로그인 안 함 → 401", async () => {
    expect((await apiStatus(session.requireApiUser)).status).toBe(401);
    expect((await apiStatus(session.requireSignedInApiUser)).status).toBe(401);
  });

  it("승인 대기 → 403 approval_pending, 로그인만 확인하는 가드는 통과", async () => {
    await seedUser("p1");
    as("p1");
    const r = await apiStatus(session.requireApiUser);
    expect(r).toMatchObject({ status: 403, body: { code: "approval_pending" } });
    expect((await apiStatus(session.requireSignedInApiUser)).status).toBe(200);
  });

  it("필수 동의가 없으면(승인됐어도) 403 consent_required", async () => {
    await seedUser("a1", { status: "approved", consent: false });
    as("a1");
    expect(await apiStatus(session.requireApprovedApiUser)).toMatchObject({ status: 403, body: { code: "consent_required" } });
  });

  it("정지 → 403 account_suspended", async () => {
    await seedUser("s1", { status: "suspended" });
    as("s1");
    expect(await apiStatus(session.requireApiUser)).toMatchObject({ status: 403, body: { code: "account_suspended" } });
  });

  it("승인 + 동의 → 통과, 관리자 API는 403", async () => {
    await seedUser("ok", { status: "approved" });
    as("ok");
    expect(await apiStatus(session.requireApiUser)).toMatchObject({ status: 200, user: { id: "ok", role: "user", status: "approved" } });
    expect(await apiStatus(session.requireAdminApiUser)).toMatchObject({ status: 403, body: { code: "admin_only" } });
  });
});

describe("페이지 가드", () => {
  it("대기 → /pending, 동의 없음 → /consent?next=, 로그인 안 함 → /login", async () => {
    await expect(session.requireUser("/app/resumes")).rejects.toThrow("REDIRECT:/login?next=%2Fapp%2Fresumes");
    await seedUser("p1");
    as("p1");
    await expect(session.requireUser("/app")).rejects.toThrow("REDIRECT:/pending");
    expect((await session.requireSignedInUser("/pending")).id).toBe("p1");
    await seedUser("nc", { status: "approved", consent: false });
    as("nc");
    await expect(session.requireApprovedUser("/app/postings")).rejects.toThrow("REDIRECT:/consent?next=%2Fapp%2Fpostings");
  });

  it("관리자 화면은 관리자가 아니면 404", async () => {
    await seedUser("ok", { status: "approved" });
    as("ok");
    await expect(session.requireAdmin("/app/admin")).rejects.toThrow("NOT_FOUND");
  });
});

describe("ADMIN_EMAILS 승격", () => {
  it("목록의 이메일은 세션 확인 때 admin·approved가 된다(승인 기록 포함)", async () => {
    process.env.ADMIN_EMAILS = "Boss@Example.com, other@x.com";
    await seedUser("boss", { email: "boss@example.com", googleSub: "g-boss" });
    as("boss");
    const user = await session.requireAdmin("/app/admin");
    expect(user).toMatchObject({ role: "admin", status: "approved" });
    const row = await tdb.prisma.user.findUniqueOrThrow({ where: { id: "boss" } });
    expect(row).toMatchObject({ role: "admin", status: "approved", approvedBy: "system:admin_emails" });
    expect(row.approvedAt).toBeInstanceOf(Date);
  });

  it("Google을 연결하지 않은 예전 비밀번호 계정은 목록의 이메일이어도 올리지 않는다(이메일 미확인)", async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await seedUser("squat", { email: "boss@example.com", status: "approved" });
    as("squat");
    expect(await apiStatus(session.requireAdminApiUser)).toMatchObject({ status: 403, body: { code: "admin_only" } });
    expect(await tdb.prisma.user.findUniqueOrThrow({ where: { id: "squat" } })).toMatchObject({ role: "user", status: "approved" });
  });

  it("동의가 없으면 관리자도 동의 화면부터", async () => {
    process.env.ADMIN_EMAILS = "boss@example.com";
    await seedUser("boss", { email: "boss@example.com", consent: false, googleSub: "g-boss" });
    as("boss");
    expect(await apiStatus(session.requireAdminApiUser)).toMatchObject({ status: 403, body: { code: "consent_required" } });
  });
});

describe("createSession", () => {
  it("마지막 로그인 시각을 기록한다", async () => {
    await tdb.prisma.user.create({ data: { id: "n1", email: "n1@x.com" } });
    await session.createSession("n1");
    const row = await tdb.prisma.user.findUniqueOrThrow({ where: { id: "n1" } });
    expect(row.lastLoginAt).toBeInstanceOf(Date);
    expect(row.status).toBe("pending"); // 새 가입 기본값
  });
});
