import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { ApplicationCreateInputSchema, type ApplicationCreateInput } from "@/lib/domain/applications";
import { emptyResumeDocument, type ResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-applications-"));
const storageDir = path.join(dir, "storage");

let service: typeof import("./service");
let insights: typeof import("./insights-service");
let resumes: typeof import("@/lib/resumes/service");
let FeatureError: typeof import("@/lib/api/errors").FeatureError;
let tdb: TestDb;

function doc(name: string): ResumeDocument {
  const d = emptyResumeDocument();
  d.basics.name = name;
  return d;
}
const input = (v: Partial<Record<keyof ApplicationCreateInput, unknown>>): ApplicationCreateInput => ApplicationCreateInputSchema.parse(v);

async function postingStatus(id: string) {
  const p = await tdb.prisma.jobPosting.findUnique({ select: { status: true }, where: { id } });
  return p?.status;
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = storageDir;
  tdb = await createTestDb();
  const db = tdb.prisma;
  for (const id of ["ua", "ub"]) await db.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  await db.jobPosting.createMany({ data: [
    { id: "p1", userId: "ua", company: "페이랩", roleTitle: "백엔드 엔지니어", status: "planned" },
    { id: "p2", userId: "ua", company: "누아", roleTitle: "프론트엔드", status: "saved" },
    { id: "p3", userId: "ua", company: "제논", roleTitle: "데이터", status: "reviewing" },
    { id: "pb", userId: "ub", company: "남의 회사", roleTitle: "남의 직무" },
  ] });
  // p1로 받은 완료 진단(적합도 81).
  await db.diagnosis.create({ data: {
    id: "d1",
    userId: "ua",
    title: "페이랩 진단",
    targetRole: "백엔드",
    situation: "general",
    resumeText: "원본",
    model: "test-model",
    status: "done",
    postingId: "p1",
  } });
  await db.diagnosisStage.create({ data: { diagnosisId: "d1", stage: "fit", status: "done", output: { matchScore: 81 } } });
  await db.diagnosis.create({ data: {
    id: "db1",
    userId: "ub",
    title: "남의 진단",
    targetRole: "x",
    situation: "general",
    resumeText: "x",
    model: "test-model",
    status: "done",
  } });
  service = await import("./service");
  insights = await import("./insights-service");
  resumes = await import("@/lib/resumes/service");
  ({ FeatureError } = await import("@/lib/api/errors"));
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("applications service", () => {
  it("공고로 만들면 회사·직무를 채우고 생성 이벤트를 남기며 공고를 '지원함'으로 바꾼다", async () => {
    const a = await service.createApplication("ua", input({ postingId: "p1" }));
    expect(a).toMatchObject({ company: "페이랩", roleTitle: "백엔드 엔지니어", stage: "applied", postingId: "p1", hasSubmittedCopy: false });
    expect(a.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(a.events).toHaveLength(1);
    expect(a.events[0]).toMatchObject({ fromStage: null, toStage: "applied" });
    expect(await postingStatus("p1")).toBe("applied");
    expect((await service.listApplications("ua", { postingId: "p1" })).map((x) => x.id)).toEqual([a.id]);
  });

  it("관심 단계로 만들면 공고 상태를 바꾸지 않는다", async () => {
    await service.createApplication("ua", input({ postingId: "p2", stage: "interested" }));
    expect(await postingStatus("p2")).toBe("saved");
  });

  it("남의 공고·진단·이력서는 연결할 수 없다", async () => {
    await expect(service.createApplication("ua", input({ postingId: "pb" }))).rejects.toMatchObject({ status: 404 });
    await expect(service.createApplication("ua", input({ company: "A", roleTitle: "B", diagnosisId: "db1" }))).rejects.toBeInstanceOf(FeatureError);
    const { resume } = await resumes.createResume("ub", { company: "X", roleTitle: "Y", templateId: "classic", document: doc("남"), source: "manual" });
    await expect(service.createApplication("ua", input({ company: "A", roleTitle: "B", resumeId: resume.id }))).rejects.toMatchObject({ status: 404 });
  });

  it("다른 사용자의 지원 id는 조회·수정·단계 변경·삭제가 모두 거절된다", async () => {
    const a = await service.createApplication("ua", input({ company: "토스", roleTitle: "서버" }));
    expect(await service.getApplication("ub", a.id)).toBeNull();
    expect(await service.updateApplication("ub", a.id, { note: "x" })).toBeNull();
    expect(await service.changeStage("ub", a.id, { stage: "interview", note: "" })).toBeNull();
    expect(await service.deleteApplication("ub", a.id)).toBe(false);
    expect(await service.getSubmittedCopy("ub", a.id)).toBeNull();
    expect((await service.listApplications("ub")).some((x) => x.id === a.id)).toBe(false);
    expect((await service.getApplication("ua", a.id))?.stage).toBe("applied");
  });

  it("단계 변경은 이벤트를 남기고, 지원서를 낼 때 그때의 이력서 버전을 제출 사본으로 고정한다", async () => {
    const { resume } = await resumes.createResume("ua", { company: "제논", roleTitle: "데이터", templateId: "modern", document: doc("v1 본문"), source: "manual" });
    const a = await service.createApplication("ua", input({ postingId: "p3", stage: "interested", resumeId: resume.id }));
    expect(a).toMatchObject({ resumeId: resume.id, resumeVersionId: null, hasSubmittedCopy: false, appliedAt: null, resumeLabel: "제논 데이터" });

    const applied = await service.changeStage("ua", a.id, { stage: "applied", note: "서류 제출" });
    expect(applied?.events.map((e) => [e.fromStage, e.toStage, e.note])).toEqual([
      [null, "interested", ""],
      ["interested", "applied", "서류 제출"],
    ]);
    expect(applied).toMatchObject({ hasSubmittedCopy: true, resumeLabel: "제논 데이터 · v1" });
    expect(applied?.appliedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(await postingStatus("p3")).toBe("applied");
    expect(existsSync(path.join(storageDir, "users", "ua", "applications", a.id, "submitted.json"))).toBe(true);

    // 원본 이력서를 고쳐도 사본은 그대로, 같은 단계로 다시 바꾸면 아무것도 쓰지 않는다.
    await resumes.saveVersion("ua", resume.id, doc("v2 본문"), { source: "manual" });
    const same = await service.changeStage("ua", a.id, { stage: "applied", note: "" });
    expect(same?.events).toHaveLength(2);
    expect((await service.getSubmittedCopy("ua", a.id))?.document.basics.name).toBe("v1 본문");

    // 이력서를 지워도 사본·버전 id·이름은 남는다.
    expect(await resumes.deleteResume("ua", resume.id)).toBe(true);
    const after = await service.getApplication("ua", a.id);
    expect(after).toMatchObject({ resumeId: null, resumeVersionId: applied?.resumeVersionId, resumeLabel: "제논 데이터 · v1", hasSubmittedCopy: true });
    const copy = await service.getSubmittedCopy("ua", a.id);
    expect(copy).toMatchObject({ templateId: "modern", resumeTitle: "제논 데이터", versionNo: 1 });
    expect(copy?.document.basics.name).toBe("v1 본문");

    // 원본을 지운 뒤에도 메모·즐겨찾기 등 다른 수정은 된다(남아 있는 버전 id로 400을 내지 않는다).
    const edited = await service.updateApplication("ua", a.id, { note: "원본 삭제 후 메모", favorite: true });
    expect(edited).toMatchObject({ note: "원본 삭제 후 메모", favorite: true, resumeId: null, hasSubmittedCopy: true });
    // 이력서 없이 버전만 새로 고르는 것은 여전히 거절한다.
    await expect(service.updateApplication("ua", a.id, { resumeVersionId: "v-any" })).rejects.toMatchObject({ status: 400 });
  });

  it("버전을 지정하면 그 버전을 복사하고, 다른 버전으로 바꾸면 다시 고정한다", async () => {
    const { resume, version: v1 } = await resumes.createResume("ua", { company: "누아", roleTitle: "FE", templateId: "classic", document: doc("첫 판"), source: "manual" });
    const v2 = await resumes.saveVersion("ua", resume.id, doc("둘째 판"), { source: "manual" });
    const a = await service.createApplication("ua", input({ company: "누아", roleTitle: "FE", stage: "interested", resumeId: resume.id, resumeVersionId: v1.id }));
    expect(a).toMatchObject({ hasSubmittedCopy: true, resumeVersionId: v1.id, resumeLabel: "누아 FE · v1" });
    const b = await service.updateApplication("ua", a.id, { resumeVersionId: v2!.id });
    expect(b).toMatchObject({ resumeVersionId: v2!.id, resumeLabel: "누아 FE · v2" });
    expect((await service.getSubmittedCopy("ua", a.id))?.document.basics.name).toBe("둘째 판");
    // 남의 버전 id(다른 이력서의 버전)는 거절.
    await expect(service.updateApplication("ua", a.id, { resumeVersionId: "nope" })).rejects.toMatchObject({ status: 404 });
    // 이력서 연결을 지우면 사본도 지운다.
    const c = await service.updateApplication("ua", a.id, { resumeId: null });
    expect(c).toMatchObject({ resumeId: null, resumeVersionId: null, resumeLabel: null, hasSubmittedCopy: false });
    expect(existsSync(path.join(storageDir, "users", "ua", "applications", a.id))).toBe(false);
  });

  it("동시에 같은 단계 변경을 보내도 이벤트는 한 번만 남는다", async () => {
    const a = await service.createApplication("ua", input({ company: "동시", roleTitle: "테스트" }));
    const results = await Promise.allSettled([
      service.changeStage("ua", a.id, { stage: "interview", note: "" }),
      service.changeStage("ua", a.id, { stage: "interview", note: "" }),
      service.changeStage("ua", a.id, { stage: "interview", note: "" }),
    ]);
    const detail = await service.getApplication("ua", a.id);
    expect(detail?.stage).toBe("interview");
    expect(detail?.events.filter((e) => e.toStage === "interview")).toHaveLength(1);
    for (const r of results) if (r.status === "rejected") expect(r.reason).toMatchObject({ status: 409 });
  });

  it("지원을 지우면 그 공고에 다른 지원이 없을 때만 공고를 '지원 예정'으로 되돌린다(R-14)", async () => {
    await tdb.prisma.jobPosting.create({ data: { id: "p4", userId: "ua", company: "라인", roleTitle: "iOS" } });
    const a1 = await service.createApplication("ua", input({ postingId: "p4" }));
    const a2 = await service.createApplication("ua", input({ postingId: "p4", roleTitle: "iOS 시니어" }));
    expect(await postingStatus("p4")).toBe("applied");
    expect(await service.deleteApplication("ua", a1.id)).toBe(true);
    expect(await postingStatus("p4")).toBe("applied");
    expect(await service.deleteApplication("ua", a2.id)).toBe(true);
    expect(await postingStatus("p4")).toBe("planned");
    expect(await service.getApplication("ua", a2.id)).toBeNull();
    const events = await tdb.prisma.applicationEvent.findMany({ where: { applicationId: a2.id } });
    expect(events).toEqual([]);
  });

  it("사용자가 공고를 '마감'으로 정리했으면 지원을 지워도 되돌리지 않는다", async () => {
    await tdb.prisma.jobPosting.create({ data: { id: "p5", userId: "ua", company: "쿠팡", roleTitle: "SRE" } });
    const a = await service.createApplication("ua", input({ postingId: "p5" }));
    await tdb.prisma.jobPosting.update({ where: { id: "p5" }, data: { status: "closed" } });
    await service.deleteApplication("ua", a.id);
    expect(await postingStatus("p5")).toBe("closed");
  });

  it("공고 연결을 옮기면 예전 공고를 되돌리고 새 공고를 '지원함'으로", async () => {
    await tdb.prisma.jobPosting.createMany({
      data: [
        { id: "p6", userId: "ua", company: "당근", roleTitle: "BE" },
        { id: "p7", userId: "ua", company: "당근", roleTitle: "BE2" },
      ],
    });
    const a = await service.createApplication("ua", input({ postingId: "p6" }));
    await service.updateApplication("ua", a.id, { postingId: "p7" });
    expect(await postingStatus("p6")).toBe("planned");
    expect(await postingStatus("p7")).toBe("applied");
    await expect(service.updateApplication("ua", a.id, { postingId: "pb" })).rejects.toMatchObject({ status: 404 });
    await expect(service.updateApplication("ua", a.id, { postingId: null, company: "" })).rejects.toMatchObject({ status: 400 });
  });

  it("인사이트: 사용자 것만 모으고, 공고로 받은 완료 진단 점수를 회사 옆에 붙인다", async () => {
    await service.createApplication("ub", input({ company: "남의 회사", roleTitle: "x" }));
    const res = await insights.getInsights("ua");
    expect(res.companies.some((c) => c.company === "남의 회사")).toBe(false);
    expect(res.companies.find((c) => c.company === "페이랩")).toMatchObject({ matchScore: 81, bestStage: "applied" });
    expect(res.responseRate.submitted).toBeGreaterThan(0);
    expect(res.funnel.map((r) => r.stage)).toContain("interview");
  });
});
