/** match-service — DB(공고·진단, PGlite)는 실제, 그래프는 가짜. 소유권·JD 분석 우선순위·스킬 갭 집계. */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import type { Prisma } from "@/lib/db/client";
import type { CareerGraph } from "@/lib/domain/graph";
import type { JdAnalysis } from "@/lib/domain/schemas";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  enabled: true,
  graphs: {} as Record<string, CareerGraph>,
}));
vi.mock("./client", () => ({ graphEnabled: () => state.enabled }));
vi.mock("./service", () => ({
  getCareerGraph: async (userId: string) =>
    state.graphs[userId] ?? {
      person: { id: "me", name: null },
      nodes: [],
      edges: [],
    },
}));

let svc: typeof import("./match-service");
let tdb: TestDb;
let DbNull: typeof Prisma.DbNull;

const jd = (
  keywords: string[],
  source: JdAnalysis["source"] = "jd",
): JdAnalysis => ({
  source,
  roleTitle: "백엔드",
  company: null,
  seniority: "",
  summary: "",
  mustHave: [],
  niceToHave: [],
  keywords,
  responsibilities: [],
  hiddenSignals: [],
});

async function addPosting(
  userId: string,
  id: string,
  jdText: string | null,
  extra: Partial<Prisma.JobPostingUncheckedCreateInput> = {},
) {
  await tdb.prisma.jobPosting.create({
    data: {
      id,
      userId,
      company: `회사-${id}`,
      roleTitle: "백엔드 개발자",
      jdText,
      ...extra,
    },
  });
}

async function addDiagnosis(
  userId: string,
  id: string,
  postingId: string,
  output: unknown,
  finishedAt: number,
  stageStatus: "done" | "failed" = "done",
) {
  await tdb.prisma.diagnosis.create({
    data: {
      id,
      userId,
      title: id,
      targetRole: "백엔드",
      situation: "general",
      resumeText: "이력서",
      model: "x",
      postingId,
      status: "done",
    },
  });
  await tdb.prisma.diagnosisStage.create({
    data: {
      diagnosisId: id,
      stage: "jd",
      status: stageStatus,
      output: (output ?? DbNull) as Prisma.InputJsonValue,
      finishedAt: new Date(finishedAt),
    },
  });
}

beforeAll(async () => {
  tdb = await createTestDb();
  ({ DbNull } = (await import("@/lib/db/client")).Prisma);
  for (const id of ["a", "b"])
    await tdb.prisma.user.create({
      data: { id, email: `${id}@x.com`, passwordHash: "x" },
    });
  svc = await import("./match-service");

  state.graphs.a = {
    person: { id: "me", name: "A" },
    nodes: [
      {
        id: "r1",
        label: "Role",
        props: { title: "백엔드" },
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "s1",
        label: "Skill",
        props: { name: "코틀린" },
        createdAt: 0,
        updatedAt: 0,
      },
      {
        id: "s2",
        label: "Skill",
        props: { name: "AWS" },
        createdAt: 0,
        updatedAt: 0,
      },
    ],
    edges: [
      { id: "USED_SKILL:r1:s1", type: "USED_SKILL", from: "r1", to: "s1" },
      { id: "HAS_SKILL:me:s2", type: "HAS_SKILL", from: "me", to: "s2" },
    ],
  };

  await addPosting("a", "p1", "자격 요건\n- Kotlin, Kubernetes");
  await addPosting("a", "p2", "Kotlin, Docker, Kafka");
  await addPosting("a", "p3", "Kubernetes, Docker", { status: "closed" });
  await addPosting("a", "p4", null);
  await addPosting("b", "pb", "Kubernetes");
  // p2: 오래된 진단(Redis), 최근 진단(Kafka·Kotlin), 더 최근이지만 깨진 출력, 실패한 jd 단계 — 최근의 정상 분석을 써야 한다
  await addDiagnosis("a", "d-old", "p2", jd(["Redis"]), 1000);
  await addDiagnosis(
    "a",
    "d-new",
    "p2",
    jd(["Kafka", "코틀린", "Kubernetes"]),
    2000,
  );
  await addDiagnosis("a", "d-broken", "p2", { nope: true }, 3000);
  await addDiagnosis("a", "d-failed", "p2", null, 4000, "failed");
  // 다른 사용자의 진단이 a의 공고를 가리켜도 쓰지 않는다
  await addDiagnosis("b", "d-b", "p1", jd(["Rust"]), 5000);
});
afterAll(() => tdb.close());

describe("matchPosting", () => {
  it("본문 사전 추출로 대조한다", async () => {
    const r = await svc.matchPosting("a", "p1");
    expect(r.source).toBe("keywords");
    expect(r.diagnosisId).toBeNull();
    expect(r.items.map((i) => [i.name, i.importance, i.status])).toEqual([
      ["Kotlin", "must", "proven"],
      ["Kubernetes", "must", "missing"],
    ]);
    expect(r.graphEmpty).toBe(false);
  });

  it("연결된 진단 중 최근의 정상 JD 분석을 우선 쓴다", async () => {
    const r = await svc.matchPosting("a", "p2");
    expect(r.source).toBe("diagnosis");
    expect(r.diagnosisId).toBe("d-new");
    expect(r.items.map((i) => [i.name, i.status])).toEqual([
      ["Kafka", "missing"],
      ["Kotlin", "proven"],
      ["Kubernetes", "missing"],
    ]);
  });

  it("남의 공고·없는 공고는 404", async () => {
    await expect(svc.matchPosting("a", "pb")).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.matchPosting("b", "p1")).rejects.toMatchObject({
      status: 404,
    });
    await expect(svc.matchPosting("a", "nope")).rejects.toMatchObject({
      status: 404,
    });
  });

  it("요구 기술이 없으면 none, 그래프가 비면 graphEmpty", async () => {
    expect((await svc.matchPosting("a", "p4")).source).toBe("none");
    const b = await svc.matchPosting("b", "pb");
    expect(b.graphEmpty).toBe(true);
    expect(b.items[0]!.status).toBe("missing");
  });

  it("그래프가 꺼져 있으면 GraphUnavailableError(503)", async () => {
    state.enabled = false;
    try {
      await expect(svc.matchPosting("a", "p1")).rejects.toMatchObject({
        name: "GraphUnavailableError",
        status: 503,
      });
      await expect(svc.skillGapAcrossPostings("a")).rejects.toMatchObject({
        status: 503,
      });
    } finally {
      state.enabled = true;
    }
  });
});

describe("skillGapAcrossPostings", () => {
  it("마감 공고를 빼고, 없는 기술을 공고 수 순으로 센다", async () => {
    const r = await svc.skillGapAcrossPostings("a");
    expect(r.postingsConsidered).toBe(2); // p1, p2 (p3 마감, p4 요구 기술 없음)
    expect(r.items.map((g) => [g.name, g.postings, g.mustCount])).toEqual([
      ["Kubernetes", 2, 1],
      ["Kafka", 1, 0],
    ]);
    expect(
      r.items.flatMap((g) => g.examples.map((e) => e.postingId)),
    ).not.toContain("p3");
  });

  it("다른 사용자 공고는 섞이지 않는다", async () => {
    const r = await svc.skillGapAcrossPostings("b");
    expect(r.postingsConsidered).toBe(1);
    expect(r.items.map((g) => g.name)).toEqual(["Kubernetes"]);
    expect(r.items[0]!.examples).toEqual([
      { postingId: "pb", company: "회사-pb", roleTitle: "백엔드 개발자" },
    ]);
  });
});
