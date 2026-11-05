/** Neo4j 통합 테스트. NEO4J_URI가 있을 때만 돈다(예: set -a; . ./.env.local; npx vitest run src/lib/graph). */
import { nanoid } from "nanoid";
import { afterAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const enabled = Boolean(process.env.NEO4J_URI);
const userA = `test_${nanoid(8)}`;
const userB = `test_${nanoid(8)}`;

describe.skipIf(!enabled)("graph service (Neo4j)", () => {
  afterAll(async () => {
    const { deleteUserGraph } = await import("./service");
    const { closeDriver } = await import("./client");
    await deleteUserGraph(userA);
    await deleteUserGraph(userB);
    await closeDriver();
  });

  it("변경을 적용·조회하고, 다른 사용자 노드에는 닿지 않으며, 틀린 변경안은 아무것도 쓰지 않는다", async () => {
    const { applyGraphOps, getCareerGraph, deleteNode, GraphOpError } = await import("./service");
    const { created } = await applyGraphOps(userA, [
      { op: "addNode", ref: "new:c", label: "Company", props: { name: "페이랩" } },
      { op: "addNode", ref: "new:r", label: "Role", props: { title: "백엔드 개발자", startDate: "2021-01", current: true } },
      { op: "addNode", ref: "new:s", label: "Skill", props: { name: "Kotlin" } },
      { op: "addEdge", type: "WORKED_AT", from: "me", to: "new:c" },
      { op: "addEdge", type: "HAD_ROLE", from: "me", to: "new:r" },
      { op: "addEdge", type: "AT_COMPANY", from: "new:r", to: "new:c" },
      { op: "addEdge", type: "USED_SKILL", from: "new:r", to: "new:s" },
      { op: "addEdge", type: "USED_SKILL", from: "new:r", to: "new:s" },
    ]);
    const g = await getCareerGraph(userA);
    expect(g.nodes).toHaveLength(3);
    expect(g.edges).toHaveLength(4); // 같은 관계는 하나만
    const role = g.nodes.find((n) => n.id === created["new:r"])!;
    expect(role.props).toMatchObject({ title: "백엔드 개발자", current: true });

    // 수정(null은 삭제)
    await applyGraphOps(userA, [{ op: "updateNode", id: created["new:r"]!, label: "Role", props: { current: null, endDate: "2024-06" } }]);
    const g2 = await getCareerGraph(userA);
    expect(g2.nodes.find((n) => n.id === created["new:r"])!.props).toEqual({ title: "백엔드 개발자", startDate: "2021-01", endDate: "2024-06" });

    // 다른 사용자는 A의 노드를 수정·연결·삭제할 수 없다
    await expect(
      applyGraphOps(userB, [{ op: "updateNode", id: created["new:c"]!, label: "Company", props: { name: "해킹" } }]),
    ).rejects.toBeInstanceOf(GraphOpError);
    await expect(applyGraphOps(userB, [{ op: "addEdge", type: "WORKED_AT", from: "me", to: created["new:c"]! }])).rejects.toBeInstanceOf(
      GraphOpError,
    );
    expect(await deleteNode(userB, created["new:c"]!)).toBe(false);
    expect((await getCareerGraph(userB)).nodes).toHaveLength(0);

    // 뒤 연산이 틀리면 앞 연산도 쓰지 않는다
    await expect(
      applyGraphOps(userA, [
        { op: "addNode", ref: "new:x", label: "Skill", props: { name: "Go" } },
        { op: "addEdge", type: "WORKED_AT", from: "new:x", to: "me" },
      ]),
    ).rejects.toBeInstanceOf(GraphOpError);
    expect((await getCareerGraph(userA)).nodes).toHaveLength(3);

    // 자소서 소재 분류(문자열 배열)와 STAR 필드는 저장 후 그대로 읽힌다
    const story = await applyGraphOps(userA, [
      {
        op: "addNode",
        ref: "new:p",
        label: "Project",
        props: { name: "정산 개선", situation: "정산이 매일 3시간 걸렸다", action: "배치를 다시 설계했다", result: "20분으로 줄었다", categories: ["problem-solving", "collaboration"] },
      },
    ]);
    const pid = story.created["new:p"]!;
    expect((await getCareerGraph(userA)).nodes.find((n) => n.id === pid)!.props).toEqual({
      name: "정산 개선",
      situation: "정산이 매일 3시간 걸렸다",
      action: "배치를 다시 설계했다",
      result: "20분으로 줄었다",
      categories: ["problem-solving", "collaboration"],
    });
    await applyGraphOps(userA, [{ op: "updateNode", id: pid, label: "Project", props: { categories: ["values"] } }]);
    expect((await getCareerGraph(userA)).nodes.find((n) => n.id === pid)!.props).toMatchObject({ categories: ["values"] });
    expect(await deleteNode(userA, pid)).toBe(true);

    // 삭제하면 관계도 사라진다
    expect(await deleteNode(userA, created["new:s"]!)).toBe(true);
    const g3 = await getCareerGraph(userA);
    expect(g3.nodes).toHaveLength(2);
    expect(g3.edges.some((e) => e.type === "USED_SKILL")).toBe(false);
  });
});
