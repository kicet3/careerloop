/** 사양 테스트 4: 노드·청크·evidence_id 변조와 요청 간 재사용은 통하지 않는다. */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
import { executeTool, defaultEvalPlan } from "./tools";
import { A_ID, B_ID } from "./__fixtures__/two-users";
import { fakeScope } from "./__fixtures__/scope";

const deps = { searchChunks: async () => [], evalPlan: defaultEvalPlan };

describe("EvidenceRegistry", () => {
  it("발급한 id만 유효: 다른 requestId·다른 사용자로 만든 HMAC, 한 글자 바꾼 id, 없는 handle은 무효", async () => {
    const scope = await fakeScope(A_ID);
    const v = await scope.validateBatch([{ kind: "node", id: "na_project", label: "Project" }]);
    const [ev] = scope.issue(v);
    expect(ev!.evidenceId).toMatch(/^ev_[A-Za-z0-9_-]{22}$/);
    expect(scope.registry.get(ev!.evidenceId)).toBe(ev);
    expect(ev!.handle).toBe("N1");
    // ① 다른 요청 id로 만든 HMAC
    const forged = scope.registry.forgeIdForTest("node", "na_project", ev!.version, "other_request", A_ID);
    expect(forged).not.toBe(ev!.evidenceId);
    expect(scope.registry.get(forged)).toBeNull();
    expect(scope.registry.get(scope.registry.forgeIdForTest("node", "na_project", ev!.version, scope.ctx.requestId, B_ID))).toBeNull();
    // ② 한 글자 변조
    const last = ev!.evidenceId.at(-1) === "A" ? "B" : "A";
    expect(scope.registry.get(`${ev!.evidenceId.slice(0, -1)}${last}`)).toBeNull();
    // ③ 다른 요청 스코프(같은 사용자)에서는 무효
    const other = await fakeScope(A_ID);
    expect(other.registry.get(ev!.evidenceId)).toBeNull();
    // ④ handle N99 → not_found(DB를 읽지 않는다)
    expect(scope.registry.resolveNodeHandle("N99")).toBeNull();
    const r = await executeTool(scope, "query_graph", { plan: { start: { var: "p", label: "Project", handles: ["N99"] }, return: { kind: "nodes", vars: ["p"] } } }, deps);
    expect(r).toEqual({ status: "error", code: "not_found", hint: "unknown_handle" });
  });

  it("get_source: 위조 id(B 청크 id 모양·다른 요청 id)·노드 id 문자열은 not_found/invalid_args", async () => {
    const scope = await fakeScope(A_ID);
    expect(await executeTool(scope, "get_source", { evidenceId: "ev_AAAAAAAAAAAAAAAAAAAAAA" }, deps)).toEqual({ status: "error", code: "not_found" });
    expect(await executeTool(scope, "get_source", { evidenceId: "ch_b_chunk_1" }, deps)).toMatchObject({ status: "error", code: "invalid_args" });
    expect(await executeTool(scope, "get_source", { evidenceId: "nb_project" }, deps)).toMatchObject({ status: "error", code: "invalid_args" });
  });
});
