/** GET /api/graph, POST /api/graph/ops — 인증·출처·입력 검증·오류 응답(그래프 서비스는 가짜로 바꾼다). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph, GraphOp } from "@/lib/domain/graph";
import { GraphOpError, GraphUnavailableError } from "@/lib/graph/errors";

vi.mock("server-only", () => ({}));

const state = vi.hoisted(() => ({
  user: { id: "u1", email: "a@example.com", name: "홍길동" } as { id: string; email: string; name: string | null } | null,
  crossSite: false,
  enabled: true,
}));

vi.mock("@/lib/auth/session", () => ({
  requireApiUser: async () => state.user ?? Response.json({ error: "로그인이 필요합니다." }, { status: 401 }),
  assertSameOrigin: () => (state.crossSite ? Response.json({ error: "허용되지 않은 요청 출처입니다." }, { status: 403 }) : null),
}));

const service = vi.hoisted(() => ({
  getCareerGraph: vi.fn(),
  applyGraphOps: vi.fn(),
}));
vi.mock("@/lib/graph/service", async () => {
  const errors = await import("@/lib/graph/errors");
  return {
    ...service,
    graphEnabled: () => state.enabled,
    GraphOpError: errors.GraphOpError,
    GraphUnavailableError: errors.GraphUnavailableError,
  };
});

const { GET } = await import("./route");
const { POST } = await import("./ops/route");

const emptyGraph = (name: string | null = "홍길동"): CareerGraph => ({ person: { id: "me", name }, nodes: [], edges: [] });

function post(body: unknown, init: RequestInit = {}) {
  return POST(
    new Request("http://localhost/api/graph/ops", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "http://localhost" },
      body: typeof body === "string" ? body : JSON.stringify(body),
      ...init,
    }),
  );
}

const addCompany: GraphOp = { op: "addNode", ref: "new:c", label: "Company", props: { name: "페이랩" } };

beforeEach(() => {
  state.user = { id: "u1", email: "a@example.com", name: "홍길동" };
  state.crossSite = false;
  state.enabled = true;
  service.getCareerGraph.mockReset().mockResolvedValue(emptyGraph());
  service.applyGraphOps.mockReset().mockResolvedValue({ created: { "new:c": "n_1" }, applied: 1 });
});

describe("GET /api/graph", () => {
  it("로그인 사용자의 그래프를 이름과 함께 돌려준다", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ graph: emptyGraph() });
    expect(service.getCareerGraph).toHaveBeenCalledWith("u1", { personName: "홍길동" });
  });

  it("로그인하지 않았으면 401", async () => {
    state.user = null;
    expect((await GET()).status).toBe(401);
    expect(service.getCareerGraph).not.toHaveBeenCalled();
  });

  it("Neo4j가 설정되지 않았으면 503", async () => {
    state.enabled = false;
    const res = await GET();
    expect(res.status).toBe(503);
    expect((await res.json()).error).toContain("Neo4j");
  });

  it("저장소 오류는 메시지·상태 그대로, 알 수 없는 오류는 500", async () => {
    service.getCareerGraph.mockRejectedValueOnce(new GraphUnavailableError());
    expect((await GET()).status).toBe(503);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    service.getCareerGraph.mockRejectedValueOnce(new Error("boom"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error).not.toContain("boom");
    spy.mockRestore();
  });
});

describe("POST /api/graph/ops", () => {
  it("검증한 연산을 본인 userId로 적용하고 결과와 갱신된 그래프를 돌려준다", async () => {
    const res = await post({ ops: [addCompany, { op: "addEdge", type: "WORKED_AT", from: "me", to: "new:c" }] });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ created: { "new:c": "n_1" }, applied: 1, graph: emptyGraph() });
    expect(service.applyGraphOps).toHaveBeenCalledWith("u1", [addCompany, { op: "addEdge", type: "WORKED_AT", from: "me", to: "new:c" }]);
  });

  it("다른 출처 요청은 403, 비로그인은 401 — 둘 다 적용하지 않는다", async () => {
    state.crossSite = true;
    expect((await post({ ops: [addCompany] })).status).toBe(403);
    state.crossSite = false;
    state.user = null;
    expect((await post({ ops: [addCompany] })).status).toBe(401);
    expect(service.applyGraphOps).not.toHaveBeenCalled();
  });

  it("Neo4j가 없으면 503", async () => {
    state.enabled = false;
    expect((await post({ ops: [addCompany] })).status).toBe(503);
  });

  it.each([
    ["JSON이 아님", "{not json", "JSON"],
    ["ops 없음", {}, "변경"],
    ["빈 배열", { ops: [] }, "적용할 변경이 없습니다"],
    ["허용되지 않은 라벨", { ops: [{ op: "addNode", ref: "new:x", label: "Person", props: { name: "x" } }] }, "변경 #1"],
    ["대표 속성 누락", { ops: [{ op: "addNode", ref: "new:x", label: "Company", props: {} }] }, "변경 #1"],
    ["날짜 형식", { ops: [addCompany, { op: "addNode", ref: "new:r", label: "Role", props: { title: "PM", startDate: "2021/01" } }] }, "변경 #2"],
    ["임시 ref 형식", { ops: [{ ...addCompany, ref: "me" }] }, "변경 #1"],
    ["관계 타입", { ops: [{ op: "addEdge", type: "KNOWS", from: "me", to: "n_1" }] }, "변경 #1"],
  ])("형식이 틀리면 400(%s)이고 서비스를 부르지 않는다", async (_name, body, message) => {
    const res = await post(body);
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain(message);
    expect(service.applyGraphOps).not.toHaveBeenCalled();
  });

  it("연산이 60개를 넘으면 400", async () => {
    const ops = Array.from({ length: 61 }, (_, i) => ({ op: "deleteNode", id: `n_${i}` }));
    const res = await post({ ops });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("60");
  });

  it("본문이 너무 크면 413", async () => {
    const big = "x".repeat(300 * 1024);
    const res = await post({ ops: [{ op: "addNode", ref: "new:c", label: "Company", props: { name: "a", description: big } }] });
    expect(res.status).toBe(413);
  });

  it("서비스의 검증 오류(존재·소유권·관계 방향)는 400과 그 문구", async () => {
    service.applyGraphOps.mockRejectedValueOnce(new GraphOpError("노드를 찾을 수 없습니다.", 0));
    const res = await post({ ops: [{ op: "deleteNode", id: "n_other_user" }] });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("변경 #1: 노드를 찾을 수 없습니다.");
    expect(service.getCareerGraph).not.toHaveBeenCalled();
  });
});
