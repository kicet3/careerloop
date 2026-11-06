import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createTestDb, migrationSql, type TestDb } from "@/test/db";
import { DatabaseSetupError, describeDatabaseUrl, pgConnectionConfig, resolveDatabase } from "./config";
import { isForeignKeyViolation, isUniqueViolation, stripNul, stripNulDeep } from "./errors";

describe("resolveDatabase", () => {
  it("DATABASE_URL → POSTGRES_PRISMA_URL → POSTGRES_URL, 직접 주소는 DIRECT_URL → POSTGRES_URL_NON_POOLING → url", () => {
    expect(resolveDatabase({ DATABASE_URL: "postgres://a/db" })).toEqual({ url: "postgres://a/db", directUrl: "postgres://a/db" });
    expect(resolveDatabase({ POSTGRES_URL: "postgres://b/db", POSTGRES_URL_NON_POOLING: "postgres://n/db" })).toEqual({
      url: "postgres://b/db",
      directUrl: "postgres://n/db",
    });
    expect(resolveDatabase({ DATABASE_URL: "postgresql://a/db", DIRECT_URL: "postgresql://d/db", POSTGRES_URL_NON_POOLING: "postgres://n/db" })).toEqual({
      url: "postgresql://a/db",
      directUrl: "postgresql://d/db",
    });
  });

  it("주소가 없거나 postgres가 아니면 DatabaseSetupError", () => {
    expect(() => resolveDatabase({})).toThrow(DatabaseSetupError);
    expect(() => resolveDatabase({ DATABASE_URL: "file:./data/app.db" })).toThrow(/postgres:\/\//);
    expect(() => resolveDatabase({ DATABASE_URL: "postgres://a/db", DIRECT_URL: "libsql://x.turso.io" })).toThrow(/DIRECT_URL/);
  });
});

describe("pgConnectionConfig", () => {
  it("localhost는 sslmode가 없으면 평문", () => {
    expect(pgConnectionConfig("postgresql://postgres:pw@127.0.0.1:54329/careerloop").ssl).toBe(false);
    expect(pgConnectionConfig("postgresql://postgres:pw@localhost:5432/db?sslmode=require").ssl).toEqual({ rejectUnauthorized: false });
  });

  it("원격 호스트는 TLS를 강제하고, Prisma 전용 파라미터와 sslmode는 주소에서 뺀다", () => {
    const c = pgConnectionConfig(
      "postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres?sslmode=require&pgbouncer=true&schema=app",
    );
    expect(c.ssl).toEqual({ rejectUnauthorized: false });
    expect(c.schema).toBe("app");
    expect(c.connectionString).toBe("postgresql://postgres.ref:pw@aws-0-ap-northeast-2.pooler.supabase.com:6543/postgres");
    expect(pgConnectionConfig("postgres://u:p@db.example.com/db").ssl).toEqual({ rejectUnauthorized: false });
    expect(pgConnectionConfig("postgres://u:p@db.example.com/db?sslmode=disable").ssl).toBe(false);
    const verify = "postgres://u:p@db.example.com/db?sslmode=verify-full";
    expect(pgConnectionConfig(verify)).toEqual({ connectionString: verify, ssl: { rejectUnauthorized: true }, schema: undefined });
  });

  it("로그용 주소에는 비밀번호가 없다", () => {
    expect(describeDatabaseUrl("postgresql://postgres:secret@127.0.0.1:54329/careerloop")).toBe("127.0.0.1:54329/careerloop");
  });
});

describe("errors", () => {
  it("Prisma 코드와 raw 쿼리의 Postgres 코드를 모두 알아본다", () => {
    expect(isUniqueViolation({ code: "P2002" })).toBe(true);
    expect(isUniqueViolation({ code: "P2010", meta: { driverAdapterError: { cause: { originalCode: "23505" } } } })).toBe(true);
    expect(isUniqueViolation({ message: "x", cause: { code: "23505" } })).toBe(true);
    expect(isUniqueViolation({ code: "P2003" })).toBe(false);
    expect(isForeignKeyViolation({ code: "P2003" })).toBe(true);
  });

  it("NUL 문자를 지운다", () => {
    expect(stripNul("a\u0000b")).toBe("ab");
    expect(stripNul(null)).toBeNull();
    expect(stripNulDeep({ a: ["x\u0000", { b: "\u0000y" }], n: 1 })).toEqual({ a: ["x", { b: "y" }], n: 1 });
  });
});

describe("스키마(PGlite에 prisma/migrations 적용)", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb();
  });
  afterAll(() => tdb.close());

  it("모든 테이블이 있고 RLS가 켜져 있다", async () => {
    const { rows } = await tdb.pglite.query<{ relname: string; relrowsecurity: boolean }>(
      "SELECT c.relname, c.relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = 'public' AND c.relkind = 'r' ORDER BY c.relname",
    );
    expect(rows.map((r) => r.relname)).toEqual([
      "application_events",
      "applications",
      "chat_messages",
      "chat_threads",
      "company_resumes",
      "diagnoses",
      "diagnosis_runs",
      "diagnosis_stages",
      "github_accounts",
      "github_repo_snapshots",
      "graph_followups",
      "interview_answers",
      "interview_questions",
      "interview_sessions",
      "job_postings",
      "llm_usage_events",
      "mcp_tokens",
      "notifications",
      "portfolios",
      "posting_imports",
      "rate_events",
      "resume_draft_jobs",
      "resume_versions",
      "sessions",
      "shared_postings",
      "user_consents",
      "users",
    ]);
    expect(rows.every((r) => r.relrowsecurity)).toBe(true);
    expect(migrationSql().length).toBeGreaterThan(0);
  });

  it("앱의 prisma가 테스트 DB를 쓰고, 기본값(createdAt·favorite·stage)이 채워진다", async () => {
    const { prisma } = await import("./client");
    await prisma.user.create({ data: { id: "u1", email: "a@b.co", passwordHash: "h" } });
    const u = await tdb.prisma.user.findUniqueOrThrow({ where: { id: "u1" } });
    expect(u.createdAt).toBeInstanceOf(Date);
    expect(u.googleSub).toBeNull();
  });

  it("공고를 지우면 진단·이력서·지원·가져오기의 posting_id는 null, 지원을 지우면 이벤트, 사용자를 지우면 세션도 지워진다", async () => {
    const db = tdb.prisma;
    await db.user.create({ data: { id: "u2", email: "c@d.co" } });
    await db.session.create({ data: { id: "s1", userId: "u2", expiresAt: new Date(Date.now() + 60_000) } });
    await db.jobPosting.create({ data: { id: "p1", userId: "u2", company: "토스", roleTitle: "백엔드", urlKey: "toss.im/careers/1" } });
    await db.diagnosis.create({
      data: { id: "d1", userId: "u2", title: "t", targetRole: "백엔드", situation: "general", resumeText: "r", model: "m", postingId: "p1" },
    });
    await db.companyResume.create({
      data: { id: "r1", userId: "u2", company: "토스", roleTitle: "백엔드", templateId: "performance", title: "t", postingId: "p1" },
    });
    await db.application.create({ data: { id: "a1", userId: "u2", postingId: "p1", company: "토스", roleTitle: "백엔드", resumeId: "r1" } });
    await db.applicationEvent.create({ data: { applicationId: "a1", toStage: "applied" } });
    await db.postingImport.create({ data: { id: "i1", userId: "u2", url: "https://toss.im/careers/1", postingId: "p1" } });

    // 같은 사용자의 같은 url_key는 하나뿐이다(URL 없는 공고는 여러 개 가능 — NULL은 서로 다르다).
    const dup = await db.jobPosting
      .create({ data: { id: "p2", userId: "u2", company: "토스", roleTitle: "백엔드", urlKey: "toss.im/careers/1" } })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(dup)).toBe(true);
    await db.jobPosting.createMany({
      data: [
        { id: "p3", userId: "u2", company: "A", roleTitle: "B" },
        { id: "p4", userId: "u2", company: "A", roleTitle: "B" },
      ],
    });

    // FK는 실제로 검사된다.
    const orphan = await db.session.create({ data: { id: "s2", userId: "nobody", expiresAt: new Date() } }).catch((e: unknown) => e);
    expect(isForeignKeyViolation(orphan)).toBe(true);

    await db.jobPosting.delete({ where: { id: "p1" } });
    const d = await db.diagnosis.findUniqueOrThrow({ where: { id: "d1" } });
    const r = await db.companyResume.findUniqueOrThrow({ where: { id: "r1" } });
    const a = await db.application.findUniqueOrThrow({ where: { id: "a1" } });
    const i = await db.postingImport.findUniqueOrThrow({ where: { id: "i1" } });
    expect([d.postingId, r.postingId, a.postingId, i.postingId]).toEqual([null, null, null, null]);
    expect(a.stage).toBe("applied");
    expect(a.favorite).toBe(false);

    await db.companyResume.delete({ where: { id: "r1" } });
    expect((await db.application.findUniqueOrThrow({ where: { id: "a1" } })).resumeId).toBeNull();

    await db.application.delete({ where: { id: "a1" } });
    expect(await db.applicationEvent.count()).toBe(0);

    await db.user.delete({ where: { id: "u2" } });
    expect(await db.session.count()).toBe(0);
    expect(await db.diagnosis.count()).toBe(0);
  });

  it("JSON 컬럼은 객체로 읽고 쓰며, reset()은 모든 행을 지우고 id를 1부터 다시 센다", async () => {
    const db = tdb.prisma;
    await db.user.create({ data: { id: "u3", email: "e@f.co" } });
    await db.diagnosis.create({
      data: {
        id: "d3",
        userId: "u3",
        title: "t",
        targetRole: "r",
        situation: "general",
        resumeText: "x",
        model: "m",
        usage: { inputTokens: 1, outputTokens: 2, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    });
    const s = await db.diagnosisStage.create({ data: { diagnosisId: "d3", stage: "screen", output: { ok: true, list: [1, 2] } } });
    expect(s.output).toEqual({ ok: true, list: [1, 2] });
    expect((await db.diagnosis.findUniqueOrThrow({ where: { id: "d3" } })).usage).toEqual({
      inputTokens: 1,
      outputTokens: 2,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
    });

    await tdb.reset();
    expect(await db.user.count()).toBe(0);
    await db.user.create({ data: { id: "u4", email: "g@h.co" } });
    await db.rateEvent.create({ data: { bucket: "b", key: "k" } });
    expect((await db.rateEvent.findFirstOrThrow()).id).toBe(1);
  });

  it("raw 쿼리의 유일 제약 위반도 알아본다", async () => {
    await tdb.prisma.user.create({ data: { id: "raw1", email: "raw@x.co" } });
    const err = await tdb.prisma.$executeRaw`INSERT INTO users (id, email) VALUES ('raw2', 'raw@x.co')`.catch((e: unknown) => e);
    expect(isUniqueViolation(err)).toBe(true);
  });

  it("인터랙티브 트랜잭션은 실패하면 되돌린다", async () => {
    const db = tdb.prisma;
    await expect(
      db.$transaction(async (tx) => {
        await tx.user.create({ data: { id: "tx1", email: "tx@x.co" } });
        throw new Error("rollback");
      }),
    ).rejects.toThrow("rollback");
    expect(await db.user.findUnique({ where: { id: "tx1" } })).toBeNull();
  });
});
