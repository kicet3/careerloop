/** 공고 대조 Neo4j 통합 테스트. NEO4J_URI가 있을 때만 돈다 — 다른 사용자의 그래프가 대조에 섞이지 않는지 본다. */
import { nanoid } from "nanoid";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";

vi.mock("server-only", () => ({}));

const enabled = Boolean(process.env.NEO4J_URI);
const userA = `test_${nanoid(8)}`;
const userB = `test_${nanoid(8)}`;

describe.skipIf(!enabled)("match service (Neo4j)", () => {
  let tdb: TestDb;
  beforeAll(async () => {
    tdb = await createTestDb();
    for (const id of [userA, userB]) {
      await tdb.prisma.user.create({ data: { id, email: `${id}@x.com`, passwordHash: "x" } });
      await tdb.prisma.jobPosting.create({
        data: { id: `p-${id}`, userId: id, company: "페이랩", roleTitle: "백엔드", jdText: "Kotlin, Kafka, Kubernetes" },
      });
    }
    const { applyGraphOps } = await import("./service");
    // B만 Kafka·Kubernetes를 가졌다. A의 대조에 B의 기술이 보이면 안 된다.
    await applyGraphOps(userA, [
      { op: "addNode", ref: "new:r", label: "Role", props: { title: "백엔드 개발자" } },
      { op: "addNode", ref: "new:s", label: "Skill", props: { name: "코틀린" } },
      { op: "addNode", ref: "new:a", label: "Achievement", props: { summary: "정산 배치 시간 단축" } },
      { op: "addEdge", type: "HAD_ROLE", from: "me", to: "new:r" },
      { op: "addEdge", type: "USED_SKILL", from: "new:r", to: "new:s" },
      { op: "addEdge", type: "ACHIEVED", from: "new:r", to: "new:a" },
    ]);
    await applyGraphOps(userB, [
      { op: "addNode", ref: "new:k", label: "Skill", props: { name: "Kafka" } },
      { op: "addNode", ref: "new:k8s", label: "Skill", props: { name: "k8s" } },
      { op: "addEdge", type: "HAS_SKILL", from: "me", to: "new:k" },
      { op: "addEdge", type: "HAS_SKILL", from: "me", to: "new:k8s" },
    ]);
  });

  afterAll(async () => {
    const { deleteUserGraph } = await import("./service");
    const { closeDriver } = await import("./client");
    await deleteUserGraph(userA);
    await deleteUserGraph(userB);
    await closeDriver();
    await tdb?.close();
  });

  it("내 그래프로만 대조하고, 증명한 경력의 성과를 붙인다", async () => {
    const { matchPosting, skillGapAcrossPostings } = await import("./match-service");
    const a = await matchPosting(userA, `p-${userA}`);
    expect(a.items.map((i) => [i.name, i.status])).toEqual([
      ["Kotlin", "proven"],
      ["Kafka", "missing"],
      ["Kubernetes", "missing"],
    ]);
    expect(a.items[0]!.provenBy.map((p) => p.name)).toEqual(["백엔드 개발자"]);
    expect(a.items[0]!.achievements.map((x) => x.summary)).toEqual(["정산 배치 시간 단축"]);

    const b = await matchPosting(userB, `p-${userB}`);
    expect(b.items.map((i) => [i.name, i.status])).toEqual([
      ["Kotlin", "missing"],
      ["Kafka", "claimed"],
      ["Kubernetes", "claimed"],
    ]);
    await expect(matchPosting(userB, `p-${userA}`)).rejects.toMatchObject({ status: 404 });

    expect((await skillGapAcrossPostings(userA)).items.map((g) => g.name)).toEqual(["Kafka", "Kubernetes"]);
    expect((await skillGapAcrossPostings(userB)).items.map((g) => g.name)).toEqual(["Kotlin"]);
  });
});
