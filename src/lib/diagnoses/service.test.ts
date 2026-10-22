import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DiagnosisInput } from "@/lib/domain/schemas";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm", () => ({ currentModelName: () => "test-model" }));

const dir = mkdtempSync(path.join(tmpdir(), "rp-diag-"));
process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
process.env.DAILY_DIAGNOSIS_LIMIT = "3";

type Svc = typeof import("./service");
type Client = typeof import("@/lib/db/client");
let svc: Svc;
let db: Client["db"];
let schema: Client["schema"];

const input: DiagnosisInput = {
  resumeText: "홍길동\n백엔드 개발자 3년. Kotlin, Spring Boot로 결제 시스템 운영.",
  resumeFileName: null,
  targetRole: "백엔드 개발자",
  jdText: "Kotlin 3년 이상",
  situation: "general",
  notes: null,
};

beforeAll(async () => {
  const { ensureDatabase } = await import("@/lib/db/migrate");
  await ensureDatabase();
  ({ db, schema } = await import("@/lib/db/client"));
  svc = await import("./service");
  for (const id of ["u1", "u2", "u3", "u4", "u5"]) {
    await db.insert(schema.users).values({ id, email: `${id}@x.com`, passwordHash: "x" });
  }
});

afterAll(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

async function setStatus(id: string, status: "done" | "failed" | "running", updatedAt = new Date()) {
  const { eq } = await import("drizzle-orm");
  await db.update(schema.diagnoses).set({ status, updatedAt }).where(eq(schema.diagnoses.id, id));
}

describe("diagnoses service", () => {
  it("진단 + 13개 단계를 만들고 동시 실행은 409", async () => {
    const { id } = await svc.createDiagnosis("u1", input);
    const found = await svc.getDiagnosisForUser(id, "u1");
    expect(found?.diagnosis.title).toMatch(/^백엔드 개발자 · \d{4}-\d{2}-\d{2}$/);
    expect(found?.stages.map((s) => s.stage)[0]).toBe("jd");
    expect(found?.stages).toHaveLength(13);
    expect(await svc.getDiagnosisForUser(id, "u2")).toBeNull();
    await expect(svc.createDiagnosis("u1", input)).rejects.toMatchObject({ status: 409 });
    await setStatus(id, "done");
  });

  it("하루 제한 초과는 429", async () => {
    for (let i = 0; i < 2; i++) {
      const { id } = await svc.createDiagnosis("u1", input);
      await setStatus(id, "done");
    }
    await expect(svc.createDiagnosis("u1", input)).rejects.toMatchObject({ status: 429 });
  });

  it("목록: 리뷰어 7명 완료 시 positiveCount, fit 점수", async () => {
    const { eq, and } = await import("drizzle-orm");
    const { id } = await svc.createDiagnosis("u2", input);
    const verdicts: Record<string, string> = {
      ats: "PASS", // 긍정
      gatekeeper: "NO",
      manager: "HIRE", // 긍정
      rival: "PASS", // 리더의 PASS는 거절
      ceo: "MAYBE",
      recruiter: "HIRE", // 긍정
      teammate: "PASS",
    };
    for (const [stage, verdict] of Object.entries(verdicts)) {
      await db
        .update(schema.diagnosisStages)
        .set({ status: "done", output: { verdict } })
        .where(and(eq(schema.diagnosisStages.diagnosisId, id), eq(schema.diagnosisStages.stage, stage as "ats")));
    }
    await db
      .update(schema.diagnosisStages)
      .set({ status: "done", output: { matchScore: 72 } })
      .where(and(eq(schema.diagnosisStages.diagnosisId, id), eq(schema.diagnosisStages.stage, "fit")));
    const [item] = await svc.listDiagnoses("u2");
    expect(item).toMatchObject({ id, positiveCount: 3, matchScore: 72, hasJd: true, subtitle: "JD 기준 심사" });
    // JD 분석이 끝나면 회사·공고 포지션명으로 진단을 구별한다.
    await db
      .update(schema.diagnosisStages)
      .set({ status: "done", output: { source: "jd", company: "머니브릿지", roleTitle: "결제 플랫폼 백엔드" } })
      .where(and(eq(schema.diagnosisStages.diagnosisId, id), eq(schema.diagnosisStages.stage, "jd")));
    expect((await svc.listDiagnoses("u2"))[0].subtitle).toBe("머니브릿지 · 결제 플랫폼 백엔드");
  });

  it("오래 멈춘 실행은 failed로, 재시도하면 실패 단계만 pending", async () => {
    const { eq, and } = await import("drizzle-orm");
    const [{ id }] = await svc.listDiagnoses("u2");
    await setStatus(id, "running", new Date(Date.now() - 11 * 60 * 1000));
    await db
      .update(schema.diagnosisStages)
      .set({ status: "running" })
      .where(and(eq(schema.diagnosisStages.diagnosisId, id), eq(schema.diagnosisStages.stage, "synthesis")));
    expect(await svc.markStaleRunsFailed("u2")).toBe(1);
    let found = await svc.getDiagnosisForUser(id, "u2");
    expect(found?.diagnosis.status).toBe("failed");
    expect(found?.stages.find((s) => s.stage === "synthesis")?.status).toBe("failed");

    await svc.prepareRetry(id, "u2");
    found = await svc.getDiagnosisForUser(id, "u2");
    expect(found?.diagnosis.status).toBe("queued");
    expect(found?.stages.find((s) => s.stage === "synthesis")?.status).toBe("pending");
    expect(found?.stages.find((s) => s.stage === "ats")?.status).toBe("done");
    await expect(svc.prepareRetry(id, "u2")).rejects.toMatchObject({ status: 409 });
  });

  it("공유 토큰은 완료된 진단만, 해제·삭제", async () => {
    const [{ id }] = await svc.listDiagnoses("u2");
    await expect(svc.setShareToken(id, "u2")).rejects.toMatchObject({ status: 409 });
    await setStatus(id, "done");
    const token = await svc.setShareToken(id, "u2");
    expect(token).toHaveLength(21);
    expect(await svc.setShareToken(id, "u2")).toBe(token);
    expect((await svc.getDiagnosisByShareToken(token))?.diagnosis.id).toBe(id);
    await svc.clearShareToken(id, "u2");
    expect(await svc.getDiagnosisByShareToken(token)).toBeNull();
    await expect(svc.setShareToken(id, "u1")).rejects.toMatchObject({ status: 404 });

    expect(await svc.deleteDiagnosis(id, "u1")).toBe(false);
    expect(await svc.deleteDiagnosis(id, "u2")).toBe(true);
    expect(await svc.getDiagnosisForUser(id, "u2")).toBeNull();
  });

  it("진행 중인 진단은 삭제할 수 없다(409), 삭제해도 하루 제한은 줄지 않는다", async () => {
    const { id } = await svc.createDiagnosis("u3", input);
    await expect(svc.deleteDiagnosis(id, "u3")).rejects.toMatchObject({ status: 409 });
    await setStatus(id, "running");
    await expect(svc.deleteDiagnosis(id, "u3")).rejects.toMatchObject({ status: 409 });
    await setStatus(id, "done");
    expect(await svc.deleteDiagnosis(id, "u3")).toBe(true);

    // 하루 제한 3건: 만들고 지우기를 반복해도 3건째 이후는 429
    for (let i = 0; i < 2; i++) {
      const { id: next } = await svc.createDiagnosis("u3", input);
      await setStatus(next, "done");
      expect(await svc.deleteDiagnosis(next, "u3")).toBe(true);
    }
    await expect(svc.createDiagnosis("u3", input)).rejects.toMatchObject({ status: 429 });
  });

  it("재시도: failed일 때만, 진단당 3회까지, 다른 진행 중 진단이 있으면 409", async () => {
    const { id } = await svc.createDiagnosis("u4", input);
    await expect(svc.prepareRetry(id, "u4")).rejects.toMatchObject({ status: 409 }); // queued
    for (let i = 0; i < 3; i++) {
      await setStatus(id, "failed");
      await svc.prepareRetry(id, "u4");
      expect((await svc.getDiagnosisForUser(id, "u4"))?.diagnosis.status).toBe("queued");
    }
    await setStatus(id, "failed");
    await expect(svc.prepareRetry(id, "u4")).rejects.toMatchObject({ status: 429 });
  });

  it("재시도 중 다른 진단이 진행 중이면 409", async () => {
    const a = await svc.createDiagnosis("u5", input);
    await setStatus(a.id, "failed");
    const b = await svc.createDiagnosis("u5", input); // a가 failed라 생성 가능
    await expect(svc.prepareRetry(a.id, "u5")).rejects.toMatchObject({ status: 409 });
    await setStatus(b.id, "done");
    await svc.prepareRetry(a.id, "u5");
    // 이제 a가 queued이므로 새 진단은 409
    await expect(svc.createDiagnosis("u5", input)).rejects.toMatchObject({ status: 409 });
  });

  it("최근 하트비트가 있는 실행은 멈춤으로 보지 않는다", async () => {
    const [{ id }] = await svc.listDiagnoses("u5");
    await setStatus(id, "running", new Date(Date.now() - 60 * 1000));
    expect(await svc.markStaleRunsFailed("u5")).toBe(0);
    await setStatus(id, "running", new Date(Date.now() - 3 * 60 * 1000));
    expect(await svc.markStaleRunsFailed("u5")).toBe(1);
  });
});
