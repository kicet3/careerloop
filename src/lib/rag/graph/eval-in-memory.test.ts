/**
 * 사양 테스트 5(공유 노드 경유 이동 불가)·11(집계·존재에 B 미포함)과 실행기 순수성(우회 경로 6의 일부).
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { NODE_LABELS, REL_RULES, REL_TYPES, type EndpointLabel } from "@/lib/domain/graph";
import { buildOwnedSnapshot } from "../snapshot";
import { A_ID, A_NODES, B_ID, B_NODES, expectNoB, memoryGraphs } from "../__fixtures__/two-users";
import { evalPlan } from "./eval-in-memory";
import { QueryPlanSchema, validatePlan, type ValidatedPlan } from "./plan";

const mem = memoryGraphs();
const snapA = async () => buildOwnedSnapshot(await mem.load(A_ID), A_ID);
async function plan(p: unknown, shared?: string[]): Promise<ValidatedPlan> {
  const s = await snapA();
  const r = validatePlan(QueryPlanSchema.parse(p), { snapshot: s, resolveNodeHandle: () => null, sharedLabels: shared });
  if (!r.ok) throw new Error(r.hint);
  return r.plan;
}

describe("공유 온톨로지(사양 5)", () => {
  const shared = ["Shared:Skill"];
  it("공유 노드에서 나가는 hop·공유 노드 시작·공유 노드 count는 plan_rejected", async () => {
    const s = await snapA();
    const v = (p: unknown) => validatePlan(QueryPlanSchema.parse(p), { snapshot: s, resolveNodeHandle: () => null, sharedLabels: shared });
    expect(
      v({
        start: { var: "m", label: "Person" },
        hops: [
          { rel: "HAS_SKILL", dir: "out", to: { var: "s", label: "Shared:Skill" } },
          { rel: "HAS_SKILL", dir: "in", to: { var: "x", label: "Person" } },
        ],
        return: { kind: "nodes", vars: ["x"] },
      }),
    ).toMatchObject({ ok: false, hint: expect.stringMatching(/shared_not_terminal|person_repeated/) });
    expect(
      v({
        start: { var: "s", label: "Shared:Skill" },
        hops: [{ rel: "USED_SKILL", dir: "in", to: { var: "p", label: "Project" } }],
        return: { kind: "nodes", vars: ["p"] },
      }),
    ).toMatchObject({ ok: false, hint: "shared_not_terminal" });
    expect(
      v({
        start: { var: "m", label: "Person" },
        hops: [{ rel: "HAS_SKILL", dir: "out", to: { var: "s", label: "Shared:Skill" } }],
        return: { kind: "aggregate", fn: "count", var: "s" },
      }),
    ).toMatchObject({ ok: false, hint: "shared_aggregate" });
    // terminal 공유 노드는 계획으로는 허용되지만, 스냅샷에 공유 노드가 없으므로 결과는 비어 있다.
    const ok = v({ start: { var: "m", label: "Person" }, hops: [{ rel: "HAS_SKILL", dir: "out", to: { var: "s", label: "Shared:Skill" } }], return: { kind: "nodes", vars: ["s"] } });
    expect(ok.ok).toBe(true);
    if (ok.ok) expect(evalPlan(ok.plan, s)).toMatchObject({ kind: "nodes", rows: [] });
  });

  it("계획이 만들 수 있는 1~2홉 경로를 모두 열거해 A 스냅샷에서 실행해도 B id가 나오지 않는다", async () => {
    const s = await snapA();
    const labels: EndpointLabel[] = [...NODE_LABELS, "Person"];
    const seen: string[] = [];
    let plans = 0;
    for (const from of labels) {
      for (const rel of REL_TYPES) {
        for (const dir of ["out", "in"] as const) {
          for (const to of labels) {
            const ok = dir === "out" ? REL_RULES[rel].from.includes(from) && REL_RULES[rel].to.includes(to) : REL_RULES[rel].from.includes(to) && REL_RULES[rel].to.includes(from);
            if (!ok || (from === "Person" && to === "Person")) continue;
            const p = QueryPlanSchema.parse({ start: { var: "a", label: from }, hops: [{ rel, dir, to: { var: "b", label: to } }], return: { kind: "paths" } });
            const r = validatePlan(p, { snapshot: s, resolveNodeHandle: () => null });
            expect(r.ok).toBe(true);
            if (!r.ok) continue;
            plans++;
            const out = evalPlan(r.plan, s);
            seen.push(JSON.stringify(out));
            const agg = validatePlan(QueryPlanSchema.parse({ ...p, return: { kind: "aggregate", fn: "count", var: "b" } }), { snapshot: s, resolveNodeHandle: () => null });
            if (agg.ok) seen.push(JSON.stringify(evalPlan(agg.plan, s)));
          }
        }
      }
    }
    expect(plans).toBeGreaterThan(20);
    expectNoB(seen);
  });
});

describe("집계·존재(사양 11)", () => {
  it("A의 Project 수는 A 개수(B가 더 많아도), 그룹·값·inputIds가 A 데이터", async () => {
    const r = evalPlan(await plan({ start: { var: "p", label: "Project" }, return: { kind: "aggregate", fn: "count", var: "p" } }), await snapA());
    expect(r).toEqual({ kind: "aggregate", groups: [{ key: null, value: 1, inputIds: [A_NODES.project] }], truncated: false });
    const g = evalPlan(
      await plan({
        start: { var: "p", label: "Project" },
        hops: [{ rel: "USED_SKILL", dir: "out", to: { var: "s", label: "Skill" } }],
        return: { kind: "aggregate", fn: "count", var: "p", groupBy: { var: "s", prop: "name" } },
      }),
      await snapA(),
    );
    expect(g).toMatchObject({ kind: "aggregate", groups: [{ key: "Kotlin", value: 1, inputIds: [A_NODES.project] }] });
  });

  it("B 표식 포함 Achievement 존재? → 빈 결과", async () => {
    const r = evalPlan(
      await plan({ start: { var: "a", label: "Achievement" }, filters: [{ var: "a", prop: "summary", op: "contains", value: "B-SECRET" }], return: { kind: "nodes", vars: ["a"] } }),
      await snapA(),
    );
    expect(r).toEqual({ kind: "nodes", rows: [], truncated: false });
  });

  it("정렬·limit 결과는 B 그래프와 무관하다(B를 바꿔도 A 결과가 바이트 단위로 같음)", async () => {
    const p = { start: { var: "n", label: "Achievement" }, orderBy: { var: "n", prop: "date", dir: "desc" }, limit: 5, return: { kind: "nodes", vars: ["n"] } };
    const before = JSON.stringify(evalPlan(await plan(p), await snapA()));
    mem.graphs.get(B_ID)!.nodes.push({ id: "nb_extra", label: "Achievement", props: { summary: "B extra", date: "2030-01" }, createdAt: 1, updatedAt: 1 } as never);
    const after = JSON.stringify(evalPlan(await plan(p), await snapA()));
    expect(after).toBe(before);
    expect(before).not.toContain(B_NODES.achievement);
  });

  it("바인딩 상한·시간 상한을 넘으면 too_broad", async () => {
    const s = await snapA();
    const p = await plan({ start: { var: "p", label: "Project" }, return: { kind: "nodes", vars: ["p"] } });
    let t = 0;
    expect(() => evalPlan(p, s, { now: () => (t += 1000) })).toThrow(/too_broad/);
  });
});

describe("실행기 모듈 그래프(사양 6)", () => {
  it("eval-in-memory는 prisma·neo4j-driver·graph/client·graph/service·저장소를 (간접으로도) import하지 않는다", () => {
    const root = path.resolve(import.meta.dirname, "../../..");
    const seen = new Set<string>();
    const forbidden: string[] = [];
    const resolve = (from: string, spec: string): string | null => {
      let p: string;
      if (spec.startsWith("@/")) p = path.join(root, spec.slice(2));
      else if (spec.startsWith(".")) p = path.resolve(path.dirname(from), spec);
      else {
        if (/prisma|neo4j|pg|storage|aws/.test(spec)) forbidden.push(spec);
        return null;
      }
      for (const c of [p, `${p}.ts`, `${p}.tsx`, path.join(p, "index.ts")]) {
        try {
          if (readFileSync(c) && !c.endsWith(path.sep)) return c;
        } catch {
          // 다음 후보
        }
      }
      return null;
    };
    const walk = (file: string) => {
      if (seen.has(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(/^\s*import\s+(?!type\b)[^;]*?from\s+["']([^"']+)["']/gm)) {
        const spec = m[1]!;
        if (/db\/client|graph\/client|graph\/service|lib\/storage|generated\/prisma/.test(spec)) forbidden.push(spec);
        const next = resolve(file, spec);
        if (next) walk(next);
      }
    };
    walk(path.join(root, "lib/rag/graph/eval-in-memory.ts"));
    expect(forbidden).toEqual([]);
    expect(seen.size).toBeGreaterThan(3);
  });
});

describe("날짜 필터 정밀도", () => {
  it("연도만 쓴 경계는 연도 정밀도로 비교한다(endDate lte '2023' = 2023년까지, gte '2023' = 2023년부터)", async () => {
    // A 프로젝트: endDate 2023-09.
    const run = async (op: "lte" | "gte", value: string) => {
      const p = await plan({ start: { var: "p", label: "Project" }, filters: [{ var: "p", prop: "endDate", op, value }], return: { kind: "nodes", vars: ["p"] } });
      const r = evalPlan(p, await snapA());
      return r.kind === "nodes" ? r.rows.map((x) => x.p) : [];
    };
    expect(await run("lte", "2023")).toEqual([A_NODES.project]);
    expect(await run("gte", "2023")).toEqual([A_NODES.project]);
    expect(await run("lte", "2022")).toEqual([]);
    expect(await run("gte", "2024")).toEqual([]);
    expect(await run("lte", "2023-08")).toEqual([]);
    expect(await run("lte", "2023-09")).toEqual([A_NODES.project]);
  });
});
