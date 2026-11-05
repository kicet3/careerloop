import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { DiagnosisInput } from "@/lib/domain/schemas";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/llm", () => ({ defaultProvider: () => "anthropic", modelNameFor: () => "test-model" }));

process.env.DAILY_DIAGNOSIS_LIMIT = "3";

type Svc = typeof import("./service");
let svc: Svc;
let tdb: TestDb;

const input: DiagnosisInput = {
  resumeText: "홍길동\n백엔드 개발자 3년. Kotlin, Spring Boot로 결제 시스템 운영.",
  resumeFileName: null,
  targetRole: "백엔드 개발자",
  jdText: "Kotlin 3년 이상",
  situation: "general",
  notes: null,
};

beforeAll(async () => {
  tdb = await createTestDb();
  svc = await import("./service");
  for (const id of ["u1", "u2", "u3", "u4", "u5", "u-provider", "u-portfolio", "u-retired", "u-cont", "u-race"]) {
    await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  }
});

afterAll(() => tdb.close());

async function setStatus(id: string, status: "done" | "failed" | "running", updatedAt = new Date()) {
  await tdb.prisma.diagnosis.update({ where: { id }, data: { status, updatedAt } });
}

async function setStage(diagnosisId: string, stage: string, data: { status: string; output?: object }) {
  await tdb.prisma.diagnosisStage.updateMany({ where: { diagnosisId, stage }, data });
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

  it("같은 사용자의 동시 생성은 하나만 성공한다(사용자 잠금)", async () => {
    const results = await Promise.allSettled([svc.createDiagnosis("u-race", input), svc.createDiagnosis("u-race", input)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.find((r) => r.status === "rejected")).toMatchObject({ reason: { status: 409 } });
  });

  it("고른 엔진을 진단에 저장한다(재시도도 같은 엔진)", async () => {
    const { id } = await svc.createDiagnosis("u-provider", input, "codex-cli");
    const found = await svc.getDiagnosisForUser(id, "u-provider");
    expect(found?.diagnosis.provider).toBe("codex-cli");
    await setStatus(id, "done");
  });

  it("포트폴리오는 이력서와 따로 저장하고, 비었으면 null", async () => {
    const { id } = await svc.createDiagnosis("u-portfolio", {
      ...input,
      portfolioText: "결제 정산 배치 재작성 — 처리 시간 4시간 → 40분",
      portfolioFileName: "portfolio.pdf",
    });
    const found = await svc.getDiagnosisForUser(id, "u-portfolio");
    expect(found?.diagnosis).toMatchObject({
      resumeText: input.resumeText,
      portfolioText: "결제 정산 배치 재작성 — 처리 시간 4시간 → 40분",
      portfolioFileName: "portfolio.pdf",
    });
    await setStatus(id, "done");

    const { id: plain } = await svc.createDiagnosis("u-portfolio", { ...input, portfolioText: "  ", portfolioFileName: "x.pdf" });
    const row = await svc.getDiagnosisForUser(plain, "u-portfolio");
    expect(row?.diagnosis).toMatchObject({ portfolioText: null, portfolioFileName: null });
    await setStatus(plain, "done");
  });

  it("하루 제한 초과는 429", async () => {
    for (let i = 0; i < 2; i++) {
      const { id } = await svc.createDiagnosis("u1", input);
      await setStatus(id, "done");
    }
    await expect(svc.createDiagnosis("u1", input)).rejects.toMatchObject({ status: 429 });
  });

  it("목록: 리뷰어 7명 완료 시 positiveCount, fit 점수", async () => {
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
      await setStage(id, stage, { status: "done", output: { verdict } });
    }
    await setStage(id, "fit", { status: "done", output: { matchScore: 72 } });
    const [item] = await svc.listDiagnoses("u2");
    expect(item).toMatchObject({ id, positiveCount: 3, matchScore: 72, hasJd: true, subtitle: "JD 기준 심사" });
    // JD 분석이 끝나면 회사·공고 포지션명으로 진단을 구별한다.
    await setStage(id, "jd", { status: "done", output: { source: "jd", company: "머니브릿지", roleTitle: "결제 플랫폼 백엔드" } });
    expect((await svc.listDiagnoses("u2"))[0].subtitle).toBe("머니브릿지 · 결제 플랫폼 백엔드");
  });

  it("오래 멈춘 실행은 failed로, 재시도하면 실패 단계만 pending", async () => {
    const [{ id }] = await svc.listDiagnoses("u2");
    await setStatus(id, "running", new Date(Date.now() - 11 * 60 * 1000));
    await setStage(id, "synthesis", { status: "running" });
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

  it("시간 제한 멈춤의 자동 이어하기: 재시도 횟수와 따로 세고, 시간 제한 멈춤이 아니면 409", async () => {
    const { DEADLINE_STOP_ERROR, MAX_DEADLINE_CONTINUATIONS } = await import("./summary");
    const { id } = await svc.createDiagnosis("u-cont", input);
    const stop = async (error: string | null) =>
      tdb.prisma.diagnosis.update({ where: { id }, data: { status: "failed", error } });

    await stop("심사위원 단계가 실패했습니다.");
    await expect(svc.prepareRetry(id, "u-cont", { continuation: true })).rejects.toMatchObject({ status: 409 });

    for (let i = 0; i < MAX_DEADLINE_CONTINUATIONS; i++) {
      await stop(DEADLINE_STOP_ERROR);
      await svc.prepareRetry(id, "u-cont", { continuation: true });
      expect((await svc.getDiagnosisForUser(id, "u-cont"))?.diagnosis.status).toBe("queued");
    }
    await stop(DEADLINE_STOP_ERROR);
    await expect(svc.prepareRetry(id, "u-cont", { continuation: true })).rejects.toMatchObject({ status: 429 });
    // 사용자 재시도는 그대로 3회 남아 있다.
    await svc.prepareRetry(id, "u-cont");
    expect((await svc.getDiagnosisForUser(id, "u-cont"))?.diagnosis.status).toBe("queued");
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

  it("없앤 샘플(mock) 엔진의 예전 진단: 보기는 되고 재시도는 409", async () => {
    // provider 컬럼에 'mock'이 남은 행, provider가 비고 model만 'mock'인 더 예전 행
    for (const [i, values] of [{ provider: "mock", model: "mock" }, { provider: null, model: "mock" }].entries()) {
      const { id } = await svc.createDiagnosis("u-retired", input);
      await tdb.prisma.diagnosis.update({ where: { id }, data: { ...values, status: "failed" } });
      const found = await svc.getDiagnosisForUser(id, "u-retired");
      expect(found?.diagnosis.model).toBe("mock");
      expect(found?.stages).toHaveLength(13);
      await expect(svc.prepareRetry(id, "u-retired")).rejects.toMatchObject({
        status: 409,
        message: expect.stringContaining("더 이상 지원하지 않는 샘플 엔진"),
      });
      expect((await svc.getDiagnosisForUser(id, "u-retired"))?.diagnosis.status, `case ${i}`).toBe("failed");
    }
  });
});
