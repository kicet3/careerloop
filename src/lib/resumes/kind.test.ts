/** 공용 이력서(kind 'general')와 복제(PGlite + 로컬 저장소). */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let service: typeof import("./service");

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = path.join(mkdtempSync(path.join(tmpdir(), "rp-resume-kind-")), "storage");
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  await tdb.prisma.jobPosting.create({ data: { id: "p1", userId: "ua", company: "토스", roleTitle: "백엔드", jdText: "JD" } });
  service = await import("./service");
});
afterAll(() => tdb.close());

const doc = () => {
  const d = emptyResumeDocument();
  d.basics.name = "홍길동";
  return d;
};

describe("공용 이력서", () => {
  it("회사·직무·공고·JD 없이 저장하고 기본 제목은 '공용 이력서'", async () => {
    const { resume } = await service.createResume("ua", {
      kind: "general",
      company: "무시됨",
      roleTitle: "무시됨",
      jdText: "무시됨",
      postingId: "p1",
      templateId: "classic",
      document: doc(),
      source: "manual",
    });
    expect(resume).toMatchObject({ kind: "general", company: "", roleTitle: "", jdText: null, postingId: null, title: "공용 이력서" });
  });

  it("기존 행·kind 생략은 company", async () => {
    const { resume } = await service.createResume("ua", { company: "토스", roleTitle: "백엔드", templateId: "classic", document: doc(), source: "manual", postingId: "p1" });
    expect(resume).toMatchObject({ kind: "company", postingId: "p1", sourceResumeId: null });
  });

  it("종류별 목록", async () => {
    expect((await service.listResumes("ua", { kind: "general" })).map((r) => r.kind)).toEqual(["general"]);
    expect((await service.listResumes("ua", { kind: "company" })).every((r) => r.kind === "company")).toBe(true);
    expect(await service.listResumes("ua")).toHaveLength(2);
  });
});

describe("copyResume", () => {
  it("공용 이력서 → 이 공고용으로 복제: 본문·양식을 가져오고 원본을 기록한다", async () => {
    const [general] = await service.listResumes("ua", { kind: "general" });
    const copied = await service.copyResume("ua", general!.id, { kind: "company", company: "토스", roleTitle: "백엔드", jdText: "JD", postingId: "p1" });
    expect(copied!.resume).toMatchObject({ kind: "company", company: "토스", postingId: "p1", sourceResumeId: general!.id, templateId: "classic" });
    expect(copied!.version.note).toBe("공용 이력서 v1에서 복제");
    const detail = await service.getResumeDetail("ua", copied!.resume.id);
    expect(detail!.current!.document.basics.name).toBe("홍길동");
  });

  it("남의 이력서·없는 이력서는 null, 회사 이력서인데 회사명이 없으면 400", async () => {
    const [general] = await service.listResumes("ua", { kind: "general" });
    expect(await service.copyResume("ub", general!.id, { kind: "general" })).toBeNull();
    expect(await service.copyResume("ua", "nope", { kind: "general" })).toBeNull();
    await expect(service.copyResume("ua", general!.id, { kind: "company", company: " " })).rejects.toMatchObject({ status: 400 });
  });

  it("원본을 지우면 sourceResumeId는 null", async () => {
    const [general] = await service.listResumes("ua", { kind: "general" });
    const copy = await service.copyResume("ua", general!.id, { kind: "general", title: "공용 사본" });
    await service.deleteResume("ua", general!.id);
    expect((await service.getResumeMeta("ua", copy!.resume.id))!.sourceResumeId).toBeNull();
  });
});
