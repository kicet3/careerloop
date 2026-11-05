/**
 * 그래프 API를 실제 Neo4j에 붙여 확인한다(NEO4J_URI가 있을 때만: set -a; . ./.env.local; set +a; npx vitest run src/app/api/graph).
 * 인증만 가짜로 바꾸고, 사용자는 고유 id로 만든 뒤 끝에 지운다.
 */
import { nanoid } from "nanoid";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";

vi.mock("server-only", () => ({}));

const current = vi.hoisted(() => ({ id: "" }));
vi.mock("@/lib/db/migrate", () => ({ ensureDatabase: async () => {} }));
vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => ({ id: current.id, email: `${current.id}@example.com`, name: null }),
  assertSameOrigin: () => null,
}));

const enabled = Boolean(process.env.NEO4J_URI);
const userA = `test_api_${nanoid(8)}`;
const userB = `test_api_${nanoid(8)}`;

async function call(userId: string, ops: unknown[]) {
  current.id = userId;
  const { POST } = await import("./ops/route");
  const res = await POST(
    new Request("http://localhost/api/graph/ops", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ops }) }),
  );
  return { status: res.status, body: await res.json() };
}

async function read(userId: string): Promise<CareerGraph> {
  current.id = userId;
  const { GET } = await import("./route");
  return ((await (await GET()).json()) as { graph: CareerGraph }).graph;
}

describe.skipIf(!enabled)("graph API (Neo4j)", () => {
  afterAll(async () => {
    const { deleteUserGraph } = await import("@/lib/graph/service");
    const { closeDriver } = await import("@/lib/graph/client");
    await deleteUserGraph(userA);
    await deleteUserGraph(userB);
    await closeDriver();
  });

  it("추가·수정·연결 해제·삭제가 반영되고, 다른 사용자의 노드는 고칠 수 없다", async () => {
    const added = await call(userA, [
      { op: "addNode", ref: "new:node", label: "Company", props: { name: "페이랩", industry: "핀테크" } },
      { op: "addEdge", type: "WORKED_AT", from: "me", to: "new:node" },
    ]);
    expect(added.status).toBe(200);
    const companyId: string = added.body.created["new:node"];
    expect(added.body.graph.nodes).toHaveLength(1);
    expect(added.body.graph.edges).toEqual([{ id: `WORKED_AT:me:${companyId}`, type: "WORKED_AT", from: "me", to: companyId }]);

    // 다른 사용자는 id를 알아도 수정·연결·삭제할 수 없다(400, 아무것도 안 씀).
    for (const op of [
      { op: "updateNode", id: companyId, label: "Company", props: { name: "탈취" } },
      { op: "deleteNode", id: companyId },
      { op: "addEdge", type: "WORKED_AT", from: "me", to: companyId },
    ]) {
      const r = await call(userB, [op]);
      expect(r.status).toBe(400);
    }
    expect((await read(userB)).nodes).toHaveLength(0);

    // 허용되지 않은 관계 방향은 400이고, 같은 변경안의 앞 연산도 쓰지 않는다.
    const bad = await call(userA, [
      { op: "addNode", ref: "new:s", label: "Skill", props: { name: "Kotlin" } },
      { op: "addEdge", type: "WORKED_AT", from: "me", to: "new:s" },
    ]);
    expect(bad.status).toBe(400);
    expect((await read(userA)).nodes).toHaveLength(1);

    const updated = await call(userA, [{ op: "updateNode", id: companyId, label: "Company", props: { industry: null, location: "서울" } }]);
    expect(updated.status).toBe(200);
    expect(updated.body.graph.nodes[0].props).toEqual({ name: "페이랩", location: "서울" });

    const unlinked = await call(userA, [{ op: "deleteEdge", type: "WORKED_AT", from: "me", to: companyId }]);
    expect(unlinked.body.graph.edges).toHaveLength(0);

    const deleted = await call(userA, [{ op: "deleteNode", id: companyId }]);
    expect(deleted.status).toBe(200);
    expect(deleted.body.graph.nodes).toHaveLength(0);
  });
});
