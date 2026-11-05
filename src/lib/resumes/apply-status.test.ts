import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument, type ResumeDocument } from "@/lib/domain/resumes";
import { ChangeResumeStatusSchema, type ResumeListStatusFilter } from "@/lib/resumes/types";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-apply-status-"));

let applyStatus: typeof import("./apply-status");
let service: typeof import("./service");
let apps: typeof import("@/lib/applications/service");
let FeatureError: typeof import("@/lib/api/errors").FeatureError;
let tdb: TestDb;

function doc(name: string): ResumeDocument {
  const d = emptyResumeDocument();
  d.basics.name = name;
  return d;
}
const input = (v: Record<string, unknown>) => ChangeResumeStatusSchema.parse(v);

async function postingStatus(id: string) {
  return (await tdb.prisma.jobPosting.findUnique({ select: { status: true }, where: { id } }))?.status;
}

async function newResume(postingId: string | null, kind: "company" | "general" = "company") {
  return (
    await service.createResume("ua", {
      kind,
      company: "페이랩",
      roleTitle: "백엔드",
      templateId: "classic",
      document: doc("홍길동"),
      source: "manual",
      postingId,
    })
  ).resume;
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = dir;
  tdb = await createTestDb();
  for (const id of ["ua", "ub"]) await tdb.prisma.user.create({ data: { id, email: `${id}@x.com` } });
  await tdb.prisma.jobPosting.createMany({
    data: [
      { id: "p1", userId: "ua", company: "페이랩", roleTitle: "백엔드", status: "planned", url: "https://jobs.example.com/1" },
      { id: "p2", userId: "ua", company: "누아", roleTitle: "프론트", status: "saved" },
      { id: "p3", userId: "ua", company: "제논", roleTitle: "데이터", status: "closed" },
      { id: "p4", userId: "ua", company: "모아", roleTitle: "서버", status: "reviewing" },
      { id: "p5", userId: "ua", company: "라온", roleTitle: "백엔드", status: "planned" },
      { id: "p6", userId: "ua", company: "하람", roleTitle: "백엔드", status: "planned" },
    ],
  });
  applyStatus = await import("./apply-status");
  service = await import("./service");
  apps = await import("@/lib/applications/service");
  ({ FeatureError } = await import("@/lib/api/errors"));
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("이력서 지원 상태 바꾸기", () => {
  it("남의 이력서는 null, 공용 이력서는 400", async () => {
    const r = await newResume(null);
    expect(await applyStatus.changeResumeApplyStatus("ub", r.id, input({ status: "applying" }))).toBeNull();
    const g = await newResume(null, "general");
    await expect(applyStatus.changeResumeApplyStatus("ua", g.id, input({ status: "submitted" }))).rejects.toMatchObject({ status: 400 });
  });

  it("지원 전 → 지원 중 → (같은 상태는 그대로) — 공고·지원 기록은 건드리지 않는다", async () => {
    const r = await newResume("p2");
    const a = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "applying" })))!;
    expect(a.resume.applyStatus).toBe("applying");
    expect(a.resume.applyStatusChangedAt).not.toBeNull();
    expect(a.application).toBeNull();
    expect(a.postingStatus).toBe("saved");
    const same = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "applying" })))!;
    expect(same.resume.applyStatusChangedAt).toBe(a.resume.applyStatusChangedAt);
    expect(await tdb.prisma.application.count({ where: { resumeId: r.id } })).toBe(0);
  });

  it("연결 공고 없이 지원 완료: 상태만 바뀐다", async () => {
    const r = await newResume(null);
    const res = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(res.resume.applyStatus).toBe("submitted");
    expect(res.application).toBeNull();
    expect(res.postingStatus).toBeNull();
    expect(res.resume.submittedApplicationId).toBeNull();
  });

  it("지원 완료: 공고 '지원함' + 지원 기록 생성(현재 버전 제출 사본) → 되돌리기 'delete'면 기록 삭제·공고 '지원 예정'", async () => {
    const r = await newResume("p1");
    const res = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(res.application).toMatchObject({ created: true, stage: "applied" });
    expect(res.postingStatus).toBe("applied");
    expect(res.resume.submittedApplicationId).toBe(res.application!.id);
    const app = (await apps.getApplication("ua", res.application!.id))!;
    expect(app).toMatchObject({ postingId: "p1", resumeId: r.id, resumeVersionId: r.currentVersionId, hasSubmittedCopy: true });
    expect(existsSync(path.join(dir, "users", "ua", "applications", app.id, "submitted.json"))).toBe(true);

    // 다시 눌러도(멱등) 기록은 하나.
    await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" }));
    expect(await tdb.prisma.application.count({ where: { resumeId: r.id } })).toBe(1);

    const back = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "applying", revertPosting: true, revertApplication: "delete" })))!;
    expect(back.resume.applyStatus).toBe("applying");
    expect(back.resume.submittedApplicationId).toBeNull();
    expect(back.application).toBeNull();
    expect(await apps.getApplication("ua", app.id)).toBeNull();
    expect(back.postingStatus).toBe("planned");
  });

  it("되돌리기 'keep'은 기록·공고를 그대로 두고, 다시 지원 완료하면 같은 기록을 잇는다", async () => {
    await tdb.prisma.jobPosting.update({ where: { id: "p1" }, data: { status: "planned" } });
    const r = await newResume("p1");
    const first = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    const keep = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "draft" })))!;
    expect(keep.resume.submittedApplicationId).toBe(first.application!.id);
    expect(keep.application).toMatchObject({ id: first.application!.id, stage: "applied" });
    expect(keep.postingStatus).toBe("applied");
    const again = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(again.application).toMatchObject({ id: first.application!.id, created: false });
    expect(await tdb.prisma.application.count({ where: { resumeId: r.id } })).toBe(1);
  });

  it("되돌리기 'withdraw'는 기록을 지원 취소로 두고, 공고 되돌리기를 끄면 공고는 '지원함' 그대로", async () => {
    const r = await newResume("p4");
    const s = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    const back = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "draft", revertApplication: "withdraw" })))!;
    expect(back.application).toMatchObject({ id: s.application!.id, stage: "withdrawn" });
    expect(back.resume.submittedApplicationId).toBeNull();
    expect(back.postingStatus).toBe("applied");
    // 지원 취소 기록은 잇지 않고 새로 만든다.
    const again = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(again.application!.created).toBe(true);
    expect(again.application!.id).not.toBe(s.application!.id);
  });

  it("관심 단계의 기존 기록은 지원 단계로 옮겨 잇고 사본을 고정한다. 마감 공고 상태는 그대로", async () => {
    const r = await newResume("p3");
    const existing = await apps.createApplication("ua", {
      postingId: "p3",
      company: "",
      roleTitle: "",
      stage: "interested",
      appliedAt: null,
      nextStep: "",
      nextDate: null,
      note: "",
      favorite: false,
      resumeId: r.id,
      resumeVersionId: null,
      diagnosisId: null,
    });
    expect(existing.hasSubmittedCopy).toBe(false);
    const res = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(res.application).toMatchObject({ id: existing.id, created: false, stage: "applied" });
    expect((await apps.getApplication("ua", existing.id))!.hasSubmittedCopy).toBe(true);
    expect(await postingStatus("p3")).toBe("closed");
  });

  it("사본 없는 지원 완료 기록(다른 경로로 만든 것)에는 현재 버전을 고정한다", async () => {
    await tdb.prisma.jobPosting.update({ where: { id: "p2" }, data: { status: "saved" } });
    const r = await newResume("p2");
    await tdb.prisma.application.create({
      data: { id: "legacyapp", userId: "ua", postingId: "p2", company: "누아", roleTitle: "프론트", stage: "interview", resumeId: r.id },
    });
    const res = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(res.application).toMatchObject({ id: "legacyapp", created: false, stage: "interview" });
    expect((await apps.getApplication("ua", "legacyapp"))!).toMatchObject({ hasSubmittedCopy: true, resumeVersionId: r.currentVersionId });
    expect(res.postingStatus).toBe("applied");
  });

  it("이력서 없이 먼저 추적하던 같은 공고의 기록을 잇는다(기록이 둘로 늘지 않는다)", async () => {
    const tracked = await apps.createApplication("ua", {
      postingId: "p5",
      company: "",
      roleTitle: "",
      stage: "applied",
      appliedAt: null,
      nextStep: "",
      nextDate: null,
      note: "",
      favorite: false,
      resumeId: null,
      resumeVersionId: null,
      diagnosisId: null,
    });
    const r = await newResume("p5");
    const res = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(res.application).toMatchObject({ id: tracked.id, created: false });
    expect(res.resume.submittedApplicationId).toBe(tracked.id);
    expect(await tdb.prisma.application.count({ where: { userId: "ua", postingId: "p5" } })).toBe(1);
    expect((await apps.getApplication("ua", tracked.id))!).toMatchObject({
      resumeId: r.id,
      resumeVersionId: r.currentVersionId,
      hasSubmittedCopy: true,
    });
    expect(res.postingStatus).toBe("applied");
  });

  it("다른 이력서의 제출 사본이 있는 같은 공고 기록은 잇되 그 사본은 그대로 둔다", async () => {
    const other = await newResume("p6");
    const first = (await applyStatus.changeResumeApplyStatus("ua", other.id, input({ status: "submitted" })))!;
    const r = await newResume("p6");
    const res = (await applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" })))!;
    expect(res.application).toMatchObject({ id: first.application!.id, created: false });
    expect(await tdb.prisma.application.count({ where: { userId: "ua", postingId: "p6" } })).toBe(1);
    expect((await apps.getApplication("ua", first.application!.id))!).toMatchObject({
      resumeId: other.id,
      resumeVersionId: other.currentVersionId,
      hasSubmittedCopy: true,
    });
  });

  it("읽은 뒤 다른 요청이 먼저 상태를 바꿨으면 409", async () => {
    const r = await newResume(null);
    // 서로 다른 상태로 동시에 바꾸면 하나만 이기고, 진 쪽은(같은 옛 값을 읽었다면) 409다.
    const p1 = applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "applying" }));
    const p2 = applyStatus.changeResumeApplyStatus("ua", r.id, input({ status: "submitted" }));
    const results = await Promise.allSettled([p1, p2]);
    const rejected = results.filter((x) => x.status === "rejected") as PromiseRejectedResult[];
    for (const x of rejected) expect(x.reason).toBeInstanceOf(FeatureError);
    for (const x of rejected) expect((x.reason as InstanceType<typeof FeatureError>).status).toBe(409);
    const final = (await service.getResumeMeta("ua", r.id))!;
    expect(["applying", "submitted"]).toContain(final.applyStatus);
  });
});

describe("이력서 목록 상태 필터·연결 공고", () => {
  it("status 필터와 ?status= 해석", async () => {
    const all = await service.listResumes("ua");
    const by = async (s: ResumeListStatusFilter) =>
      (await service.listResumes("ua", { status: s })).map((r) => r.id).sort();
    expect((await by("general")).length).toBe(all.filter((r) => r.kind === "general").length);
    for (const st of ["draft", "applying", "submitted"] as const) {
      expect(await by(st)).toEqual(all.filter((r) => r.kind !== "general" && r.applyStatus === st).map((r) => r.id).sort());
    }
    // 예전 행(상태 null)도 '지원 전'에 든다.
    const legacy = await newResume(null);
    await tdb.prisma.companyResume.update({ where: { id: legacy.id }, data: { applyStatus: null } });
    expect(await by("draft")).toContain(legacy.id);
    expect(service.parseResumeStatusFilter("submitted")).toBe("submitted");
    expect(service.parseResumeStatusFilter("nope")).toBe("all");
    expect(service.parseResumeStatusFilter(null)).toBe("all");
  });

  it("편집 화면 상세에 연결 공고 요약이 실린다", async () => {
    const r = await newResume("p1");
    const d = (await service.getResumeDetail("ua", r.id))!;
    expect(d.posting).toMatchObject({ id: "p1", company: "페이랩", url: "https://jobs.example.com/1", sharedPostingId: null });
    const links = await service.listResumePostingLinks("ub", ["p1"]);
    expect(links.size).toBe(0);
    expect((await service.getResumeDetail("ua", (await newResume(null)).id))!.posting).toBeNull();
  });
});
