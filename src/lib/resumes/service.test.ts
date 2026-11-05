import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { emptyResumeDocument, type ResumeDocument } from "@/lib/domain/resumes";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const dir = mkdtempSync(path.join(tmpdir(), "rp-resumes-"));

let service: typeof import("./service");
let create: typeof import("./create");
let FeatureError: typeof import("@/lib/api/errors").FeatureError;
let tdb: TestDb;
const storageDir = path.join(dir, "storage");

function doc(name: string, extra: Partial<ResumeDocument> = {}): ResumeDocument {
  const d = emptyResumeDocument();
  d.basics.name = name;
  return { ...d, ...extra };
}

beforeAll(async () => {
  for (const k of ["R2_ACCOUNT_ID", "R2_ACCESS_KEY_ID", "R2_SECRET_ACCESS_KEY", "R2_BUCKET"]) delete process.env[k];
  process.env.STORAGE_DIR = storageDir;
  tdb = await createTestDb();
  const db = tdb.prisma;
  for (const id of ["ua", "ub"]) await db.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
  // 재작성본이 있는 진단(ua 소유)
  await db.diagnosis.create({ data: {
    id: "d1",
    userId: "ua",
    title: "백엔드 진단",
    targetRole: "백엔드",
    situation: "general",
    resumeText: "원본",
    model: "test-model",
    status: "done",
  } });
  await db.diagnosisStage.create({ data: {
    diagnosisId: "d1",
    stage: "rewrite",
    status: "done",
    output: { resumeMarkdown: "홍길동\n결제 API 응답 시간 40% 단축\n정산 배치 재작성", changes: [], addQuestions: [], assumptions: [] },
  } });
  await db.diagnosis.create({ data: {
    id: "d2",
    userId: "ua",
    title: "진행 중",
    targetRole: "백엔드",
    situation: "general",
    resumeText: "원본",
    model: "test-model",
    status: "running",
  } });
  service = await import("./service");
  create = await import("./create");
  ({ FeatureError } = await import("@/lib/api/errors"));
});
afterAll(async () => {
  await tdb.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("resumes service", () => {
  it("만들기 → v1이 로컬 저장소 users/<userId>/resumes/<id>/v1.json에 저장된다", async () => {
    const { resume, version } = await service.createResume("ua", {
      company: " 페이랩 ",
      roleTitle: "백엔드",
      templateId: "modern",
      document: doc("홍길동"),
      source: "manual",
    });
    expect(resume.title).toBe("페이랩 백엔드");
    expect(resume.company).toBe("페이랩");
    expect(version.versionNo).toBe(1);
    expect(resume.currentVersionId).toBe(version.id);
    expect(/^[A-Za-z0-9]+$/.test(resume.id)).toBe(true);
    expect(existsSync(path.join(storageDir, "users", "ua", "resumes", resume.id, "v1.json"))).toBe(true);

    const detail = await service.getResumeDetail("ua", resume.id);
    expect(detail!.current!.document.basics.name).toBe("홍길동");
    expect(detail!.versions.map((v) => v.versionNo)).toEqual([1]);
  });

  it("저장할 때마다 새 버전, 목록·복원·충돌 감지", async () => {
    const { resume, version: v1 } = await service.createResume("ua", {
      company: "A사",
      roleTitle: "PM",
      templateId: "classic",
      document: doc("v1"),
      source: "ai",
    });
    const v2 = await service.saveVersion("ua", resume.id, doc("v2"), { source: "manual", note: "수치 보강", baseVersionId: v1.id });
    expect(v2!.versionNo).toBe(2);
    expect(v2!.note).toBe("수치 보강");

    // 옛 버전을 기준으로 저장하면 409(다른 탭 덮어쓰기 방지)
    await expect(service.saveVersion("ua", resume.id, doc("x"), { source: "manual", baseVersionId: v1.id })).rejects.toMatchObject({
      status: 409,
    });

    const restored = await service.restoreVersion("ua", resume.id, v1.id);
    expect(restored!.versionNo).toBe(3);
    expect(restored!.note).toBe("v1에서 복원");
    const cur = await service.getVersionDocument("ua", resume.id);
    expect(cur!.version.id).toBe(restored!.id);
    expect(cur!.document.basics.name).toBe("v1");
    expect((await service.getVersionDocument("ua", resume.id, v2!.id))!.document.basics.name).toBe("v2");
    expect((await service.listVersions("ua", resume.id))!.map((v) => v.versionNo)).toEqual([3, 2, 1]);

    const list = await service.listResumes("ua");
    const item = list.find((r) => r.id === resume.id)!;
    expect(item.versionCount).toBe(3);
    expect(item.currentVersionNo).toBe(3);
    expect(list[0]!.id).toBe(resume.id); // 최근 수정 순
  });

  it("같은 기준 버전으로 동시에 저장하면 하나만 성공하고 나머지는 409", async () => {
    const { resume, version: v1 } = await service.createResume("ua", { company: "C", roleTitle: "R", templateId: "compact", document: doc("0"), source: "manual" });
    const results = await Promise.allSettled(
      ["탭A", "탭B"].map((n) => service.saveVersion("ua", resume.id, doc(n), { source: "manual", baseVersionId: v1.id })),
    );
    const ok = results.filter((r) => r.status === "fulfilled");
    const failed = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    expect(ok).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]!.reason).toMatchObject({ status: 409 });
    const cur = await service.getVersionDocument("ua", resume.id);
    expect(cur!.version.id).toBe((ok[0] as PromiseFulfilledResult<{ id: string } | null>).value!.id);
    expect((await service.listVersions("ua", resume.id))!.map((v) => v.versionNo)).toEqual([2, 1]);
  });

  it("동시에 저장해도 버전 번호가 겹치지 않는다", async () => {
    const { resume } = await service.createResume("ua", { company: "B", roleTitle: "R", templateId: "compact", document: doc("0"), source: "manual" });
    const saved = await Promise.all([1, 2, 3, 4].map((i) => service.saveVersion("ua", resume.id, doc(String(i)), { source: "manual" })));
    const nos = saved.map((v) => v!.versionNo).sort();
    expect(nos).toEqual([2, 3, 4, 5]);
    for (const v of saved) {
      const got = await service.getVersionDocument("ua", resume.id, v!.id);
      expect(got!.version.versionNo).toBe(v!.versionNo);
    }
    // 본문 쓰기가 끝나는 순서와 관계없이 현재 버전은 가장 새 번호다(늦게 끝난 옛 번호로 되돌아가지 않는다).
    expect((await service.getVersionDocument("ua", resume.id))!.version.versionNo).toBe(5);
  });

  it("남의 이력서는 읽기·쓰기·복원·삭제 모두 null/false", async () => {
    const { resume, version } = await service.createResume("ua", { company: "C", roleTitle: "R", templateId: "classic", document: doc("a"), source: "manual" });
    expect(await service.getResumeDetail("ub", resume.id)).toBeNull();
    expect(await service.getResumeMeta("ub", resume.id)).toBeNull();
    expect(await service.listVersions("ub", resume.id)).toBeNull();
    expect(await service.getVersionDocument("ub", resume.id, version.id)).toBeNull();
    expect(await service.saveVersion("ub", resume.id, doc("b"), { source: "manual" })).toBeNull();
    expect(await service.restoreVersion("ub", resume.id, version.id)).toBeNull();
    expect(await service.updateResumeMeta("ub", resume.id, { templateId: "modern" })).toBeNull();
    expect(await service.deleteResume("ub", resume.id)).toBe(false);
    expect((await service.listResumes("ub")).length).toBe(0);
    // 다른 이력서의 버전 id로는 못 읽는다
    const other = await service.createResume("ua", { company: "D", roleTitle: "R", templateId: "classic", document: doc("d"), source: "manual" });
    expect(await service.getVersionDocument("ua", other.resume.id, version.id)).toBeNull();
    expect((await service.getResumeDetail("ua", resume.id))!.current!.document.basics.name).toBe("a");
  });

  it("메타 수정(양식 전환)과 삭제(저장소 객체 포함)", async () => {
    const { resume } = await service.createResume("ua", { company: "E", roleTitle: "R", templateId: "classic", document: doc("e"), source: "manual" });
    await service.saveVersion("ua", resume.id, doc("e2"), { source: "manual" });
    const updated = await service.updateResumeMeta("ua", resume.id, { templateId: "developer", jdText: "  ", title: "새 제목" });
    expect(updated!.templateId).toBe("developer");
    expect(updated!.jdText).toBeNull();
    expect(updated!.title).toBe("새 제목");

    const folder = path.join(storageDir, "users", "ua", "resumes", resume.id);
    expect(existsSync(path.join(folder, "v2.json"))).toBe(true);
    expect(await service.deleteResume("ua", resume.id)).toBe(true);
    expect(existsSync(path.join(folder, "v1.json"))).toBe(false);
    expect(existsSync(path.join(folder, "v2.json"))).toBe(false);
    expect(await service.getResumeDetail("ua", resume.id)).toBeNull();
    expect(await service.deleteResume("ua", resume.id)).toBe(false);
  });

  it("본문 객체가 사라졌으면 404 FeatureError", async () => {
    const { resume } = await service.createResume("ua", { company: "F", roleTitle: "R", templateId: "classic", document: doc("f"), source: "manual" });
    rmSync(path.join(storageDir, "users", "ua", "resumes", resume.id, "v1.json"));
    await expect(service.getResumeDetail("ua", resume.id)).rejects.toBeInstanceOf(FeatureError);
  });
});

describe("createResumeFromInput", () => {
  const user = { id: "ua", email: "ua@x.com", name: "홍길동" };

  it("빈 문서: AI 없이 계정 이름·이메일만 채운 v1", async () => {
    const res = await create.createResumeFromInput(user, {
      company: "페이랩",
      roleTitle: "백엔드",
      jdText: "",
      templateId: "classic",
      title: "",
      source: { kind: "blank" },
    });
    const detail = await service.getResumeDetail("ua", res.id);
    expect(detail!.current!.document.basics).toMatchObject({ name: "홍길동", email: "ua@x.com", headline: "백엔드" });
    expect(detail!.versions[0]!.source).toBe("manual");
    expect(res.notes).toEqual([]);
  });

  it("AI 초안 대기에 상한이 있다: 넘으면 504, 이력서는 만들지 않는다", async () => {
    const { FakeLlmClient } = await import("@/test/fake-llm");
    const before = (await service.listResumes("ua")).length;
    await expect(
      create.createResumeFromInput(
        user,
        { company: "느림", roleTitle: "백엔드", jdText: "", templateId: "classic", title: "", source: { kind: "diagnosis", diagnosisId: "d1" } },
        { client: new FakeLlmClient({ delayMs: 500 }), timeoutMs: 20 },
      ),
    ).rejects.toMatchObject({ status: 504 });
    expect((await service.listResumes("ua")).length).toBe(before);
  });

  it("진단 재작성본: 가짜 LLM 초안을 ai 버전으로 저장", async () => {
    const { FakeLlmClient } = await import("@/test/fake-llm");
    const fake = new FakeLlmClient({ delayMs: 0 });
    const generate = vi.spyOn(fake, "generate");
    const res = await create.createResumeFromInput(
      user,
      {
        company: "페이랩",
        roleTitle: "백엔드",
        jdText: "Kotlin 경험자",
        templateId: "developer",
        title: "",
        source: { kind: "diagnosis", diagnosisId: "d1" },
      },
      { client: fake },
    );
    expect(generate).toHaveBeenCalledOnce();
    const req = generate.mock.calls[0]![0];
    expect(req.task).toBe("resume-draft");
    expect(req.user).toContain("<resume>\n홍길동");
    expect(req.user).toContain("<job_posting>");
    expect(req.user).toContain("- 지원 회사: 페이랩");
    expect(res.missingInfo.length).toBeGreaterThan(0);
    const detail = await service.getResumeDetail("ua", res.id);
    expect(detail!.versions[0]!.source).toBe("ai");
    expect(detail!.current!.document.experience[0]!.bullets).toContain("정산 배치 재작성");
  });

  it("재작성본이 없는 진단·남의 진단은 거절하고 이력서를 만들지 않는다", async () => {
    const before = (await service.listResumes("ua")).length;
    const base = { company: "X", roleTitle: "Y", jdText: "", templateId: "classic" as const, title: "" };
    await expect(create.createResumeFromInput(user, { ...base, source: { kind: "diagnosis", diagnosisId: "d2" } })).rejects.toMatchObject({ status: 409 });
    await expect(
      create.createResumeFromInput({ id: "ub", email: "ub@x.com", name: null }, { ...base, source: { kind: "diagnosis", diagnosisId: "d1" } }),
    ).rejects.toMatchObject({ status: 404 });
    expect((await service.listResumes("ua")).length).toBe(before);
  });

  it("그래프 출처: Neo4j가 없으면 503, 있으면 빈 그래프 409", async () => {
    const base = { company: "X", roleTitle: "Y", jdText: "", templateId: "classic" as const, title: "" };
    const err = await create
      .createResumeFromInput({ id: `ugraph${Date.now()}`, email: "g@x.com", name: null }, { ...base, source: { kind: "graph" } })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FeatureError);
    expect((err as InstanceType<typeof FeatureError>).status).toBe(process.env.NEO4J_URI ? 409 : 503);
  });
});
