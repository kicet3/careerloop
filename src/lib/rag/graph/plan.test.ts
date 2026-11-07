/**
 * 사양 테스트 6: UNION·서브쿼리·가변 경로·OPTIONAL·WITH·UNWIND·경로 변수·Cypher·CALL·SKIP 같은 우회 키는 strict 스키마가 거부하고,
 * 라벨·관계·속성 키 주입은 enum·집합 소속 검사로 거부한다. 시스템 속성(id·userId)은 쓸 수 없다.
 */
import { describe, expect, it } from "vitest";
import { buildOwnedSnapshot } from "../snapshot";
import { A_ID, memoryGraphs } from "../__fixtures__/two-users";
import { QueryPlanSchema, validatePlan } from "./plan";

const base = { start: { var: "p", label: "Project" }, return: { kind: "nodes", vars: ["p"] } };

describe("QueryPlanSchema (구조)", () => {
  it.each(["union", "subquery", "varLength", "optional", "with", "unwind", "path", "cypher", "call", "skip"])("최상위 키 %s는 거부", (k) => {
    expect(QueryPlanSchema.safeParse({ ...base, [k]: "MATCH (n) RETURN n" }).success).toBe(false);
  });

  it("hop 4개·가변 관계·패턴 안 추가 키·라벨/속성 주입을 거부", () => {
    const hop = { rel: "USED_SKILL", dir: "out", to: { var: "s", label: "Skill" } };
    expect(QueryPlanSchema.safeParse({ ...base, hops: [hop, hop, hop, hop] }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, hops: [{ ...hop, rel: "*" }] }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, hops: [{ ...hop, rel: "USED_SKILL*1..5" }] }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, hops: [{ ...hop, optional: true }] }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, start: { var: "p", label: "Project) MATCH (x" } }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, start: { var: "p", label: "Project", userId: "B" } }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, start: { var: "p", label: "Project", handles: ["n_abc123"] } }).success).toBe(false);
    expect(QueryPlanSchema.safeParse({ ...base, start: { var: "P x", label: "Project" } }).success).toBe(false);
  });
});

describe("validatePlan (의미)", () => {
  const snap = async () => buildOwnedSnapshot(await memoryGraphs().load(A_ID), A_ID);
  const ctx = async () => ({ snapshot: await snap(), resolveNodeHandle: () => null });
  const check = async (plan: unknown) => validatePlan(QueryPlanSchema.parse(plan), await ctx());

  it("속성 주입·시스템 속성은 unknown_prop", async () => {
    for (const prop of ["name} RETURN n //", "userId", "id", "createdAt", "updatedAt", "__proto__"]) {
      const r = await check({ ...base, filters: [{ var: "p", prop, op: "exists" }] });
      expect(r).toMatchObject({ ok: false, code: "plan_rejected", hint: "unknown_prop" });
    }
    expect(await check({ ...base, orderBy: { var: "p", prop: "userId", dir: "asc" } })).toMatchObject({ ok: false, hint: "unknown_prop" });
  });

  it("허용되지 않은 간선 방향·모르는 변수·연산 타입", async () => {
    expect(await check({ ...base, hops: [{ rel: "USED_SKILL", dir: "in", to: { var: "s", label: "Skill" } }] })).toMatchObject({ hint: "edge_not_allowed" });
    expect(await check({ ...base, filters: [{ var: "zz", prop: "name", op: "exists" }] })).toMatchObject({ hint: "unknown_var" });
    expect(await check({ ...base, filters: [{ var: "p", prop: "name", op: "contains", value: 3 }] })).toMatchObject({ hint: "bad_value" });
    expect(await check({ ...base, filters: [{ var: "p", prop: "name", op: "exists", value: "x" }] })).toMatchObject({ hint: "bad_value" });
  });

  it("handle은 이번 요청 레지스트리에 있어야 한다(형식이 맞아도 없으면 not_found)", async () => {
    const r = await check({ ...base, start: { var: "p", label: "Project", handles: ["N1"] } });
    expect(r).toMatchObject({ ok: false, code: "not_found" });
  });

  it("공유 라벨은 허용 목록이 비어 있어 거부(unknown_label)", async () => {
    const r = await check({ start: { var: "m", label: "Person" }, hops: [{ rel: "HAS_SKILL", dir: "out", to: { var: "s", label: "Shared:Skill" } }], return: { kind: "nodes", vars: ["s"] } });
    expect(r).toMatchObject({ ok: false, hint: "unknown_label" });
  });
});
