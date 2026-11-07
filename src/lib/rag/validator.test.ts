/**
 * Evidence Validator: 사양 테스트 8(검색기가 B를 돌려주면 LLM 전에 차단), 9(위조 owner·출처 메타 거부), 11(집계 조작), 12(파생 오염),
 * 13(user_id 빈 청크). 출처 재조회는 실제 소유 조건 함수(PGlite)를 쓴다.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { createTestDb, type TestDb } from "@/test/db";
import { readAuthoritativeSource, sourceExistsElsewhere } from "./chunks/authoritative";
import type { ChunkRow } from "./chunks/store";
import { evalPlan } from "./graph/eval-in-memory";
import { QueryPlanSchema, validatePlan } from "./graph/plan";
import { sha256 } from "./hash";
import type { ValidatedResult } from "./validator";
import { A_BRIEF, A_ID, B_BRIEF, B_ID, B_NODES, B_SECRET, expectNoB, seedUsers } from "./__fixtures__/two-users";
import { fakeScope } from "./__fixtures__/scope";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
beforeAll(async () => {
  tdb = await createTestDb();
  await seedUsers(tdb.prisma);
});
afterAll(() => tdb.close());

const real = { readSource: readAuthoritativeSource, sourceExistsElsewhere };
const chunk = (over: Partial<ChunkRow>): ChunkRow => ({
  id: "ch_test",
  user_id: A_ID,
  source_type: "repo-brief",
  source_id: "snap_a",
  source_version: sha256(A_BRIEF),
  span_start: 0,
  span_end: A_BRIEF.length,
  node_ids: ["na_project", B_NODES.project],
  content_hash: sha256(A_BRIEF),
  ...over,
});

describe("validateBatch", () => {
  it("정상 청크: LLM 텍스트는 권위 원문 구간, 연결 노드는 스냅샷에 있는 것만", async () => {
    const scope = await fakeScope(A_ID, real);
    const v = await scope.validateBatch([{ kind: "chunk", row: chunk({}) }]);
    const r = scope.renderForLlm(v);
    expect(r.evidence).toHaveLength(1);
    expect(r.evidence[0]!.linkedNodeIds).toEqual(["na_project"]);
    expect(r.text).toContain("결제 시스템 개편 프로젝트 저장소");
    expectNoB([r.text]);
  });

  it("① user_id=A인데 source_id가 B의 저장소 요약 → source_owner_mismatch", async () => {
    const scope = await fakeScope(A_ID, real);
    await expect(
      scope.validateBatch([{ kind: "chunk", row: chunk({ source_id: "snap_b", content_hash: sha256(B_BRIEF.slice(0, 20)), span_end: 20 }) }]),
    ).rejects.toMatchObject({ name: "SecurityViolation", code: "source_owner_mismatch" });
  });

  it("검색기가 B의 청크 행(user_id=B)을 돌려줌 → chunk_owner_mismatch, user_id가 비면 같은 실패(사양 13)", async () => {
    const scope = await fakeScope(A_ID, real);
    await expect(scope.validateBatch([{ kind: "chunk", row: chunk({ user_id: B_ID, source_id: "snap_b" }) }])).rejects.toMatchObject({ code: "chunk_owner_mismatch" });
    await expect(scope.validateBatch([{ kind: "chunk", row: chunk({ user_id: "" }) }])).rejects.toMatchObject({ code: "chunk_owner_mismatch" });
    // 정상 청크와 섞여 와도 묶음 전체가 거부된다.
    await expect(
      scope.validateBatch([{ kind: "chunk", row: chunk({}) }, { kind: "chunk", row: chunk({ id: "ch_b", user_id: B_ID }) }]),
    ).rejects.toMatchObject({ code: "chunk_owner_mismatch" });
  });

  it("② content_hash가 맞지 않는 청크(같은 소유자) → drop, 출처 없음 → drop", async () => {
    const scope = await fakeScope(A_ID, real);
    const v = await scope.validateBatch([
      { kind: "chunk", row: chunk({ content_hash: sha256(`${B_SECRET} 위조`) }) },
      { kind: "chunk", row: chunk({ source_id: "snap_none" }) },
    ]);
    expect(v.items).toHaveLength(0);
    expect(v.dropped.map((d) => d.reason)).toEqual(["hash_mismatch_same_owner", "source_missing"]);
  });

  it("③ 스냅샷에 없는 B 노드(raw props에 userId:A) → foreign_node", async () => {
    const scope = await fakeScope(A_ID, real);
    await expect(
      scope.validateBatch([{ kind: "node", id: B_NODES.achievement, label: "Achievement", props: { userId: A_ID, summary: B_SECRET } }]),
    ).rejects.toMatchObject({ code: "foreign_node" });
    await expect(scope.validateBatch([{ kind: "edge", from: "na_project", type: "ACHIEVED", to: B_NODES.achievement }])).rejects.toMatchObject({ code: "foreign_edge" });
    await expect(scope.validateBatch([{ kind: "edge", from: "na_project", type: "ACHIEVED", to: "na_skill" }])).rejects.toMatchObject({ code: "foreign_edge" });
  });

  it("④ A 노드 id에 B 텍스트를 props로 붙인 raw → 렌더에 B 텍스트 없음(값은 스냅샷에서만)", async () => {
    const scope = await fakeScope(A_ID, real);
    const v = await scope.validateBatch([
      { kind: "node", id: "na_ach", label: "Achievement", props: { summary: `매출 300% 증가 ${B_SECRET}` } },
      { kind: "node", id: "na_project", label: "Project" },
    ]);
    const r = scope.renderForLlm(v);
    expect(v.dropped).toEqual([{ reason: "stale_version" }]);
    expect(r.text).toContain("결제 시스템 개편");
    expectNoB([r.text]);
  });

  it("⑤ 캐스트로 만든 가짜 ValidatedResult는 renderForLlm·issue에서 unknown_kind", async () => {
    const scope = await fakeScope(A_ID, real);
    const fake = { items: [{ kind: "node", sourceKey: B_NODES.project, version: "x", content: B_SECRET, inputIds: [], display: { label: "", name: "", snippet: "" } }], dropped: [] } as unknown as ValidatedResult;
    expect(() => scope.renderForLlm(fake)).toThrow("unknown_kind");
    expect(() => scope.issue(fake)).toThrow("unknown_kind");
    // 다른 요청 스코프에서 검증된 결과도 이 스코프에서는 쓸 수 없다.
    const other = await fakeScope(A_ID, real);
    const v = await other.validateBatch([{ kind: "node", id: "na_project", label: "Project" }]);
    expect(() => scope.renderForLlm(v)).toThrow("unknown_kind");
  });

  it("알 수 없는 kind → unknown_kind", async () => {
    const scope = await fakeScope(A_ID, real);
    await expect(scope.validateBatch([{ kind: "cypher", q: "MATCH (n) RETURN n" } as never])).rejects.toMatchObject({ code: "unknown_kind" });
  });

  it("집계 inputIds를 B id로 조작하거나 값을 바꾸면 aggregate_mismatch(사양 11)", async () => {
    const scope = await fakeScope(A_ID, real);
    const check = validatePlan(QueryPlanSchema.parse({ start: { var: "p", label: "Project" }, return: { kind: "aggregate", fn: "count", var: "p" } }), {
      snapshot: scope.snapshot,
      resolveNodeHandle: () => null,
    });
    if (!check.ok) throw new Error("plan");
    const truth = evalPlan(check.plan, scope.snapshot);
    if (truth.kind !== "aggregate") throw new Error("kind");
    await expect(scope.validateBatch([{ kind: "aggregate", plan: check.plan, groups: [{ ...truth.groups[0]!, inputIds: [B_NODES.project] }] }])).rejects.toMatchObject({ code: "aggregate_mismatch" });
    await expect(scope.validateBatch([{ kind: "aggregate", plan: check.plan, groups: [{ ...truth.groups[0]!, value: 4 }] }])).rejects.toMatchObject({ code: "aggregate_mismatch" });
    const ok = await scope.validateBatch([{ kind: "aggregate", plan: check.plan, groups: truth.groups }]);
    expect(ok.items[0]!.content).toContain("count(프로젝트)");
  });

  it("파생 결과의 입력에 다른 요청·B의 근거 id → derived_foreign_input(사양 12)", async () => {
    const a1 = await fakeScope(A_ID, real);
    const a2 = await fakeScope(A_ID, real);
    const [ev] = a2.issue(await a2.validateBatch([{ kind: "node", id: "na_project", label: "Project" }]));
    await expect(a1.validateBatch([{ kind: "derived", op: "profile-summary", inputEvidenceIds: [ev!.evidenceId] }])).rejects.toMatchObject({ code: "derived_foreign_input" });
    const b = await fakeScope(B_ID, real);
    const [bev] = b.issue(await b.validateBatch([{ kind: "node", id: B_NODES.project, label: "Project" }]));
    await expect(a1.validateBatch([{ kind: "derived", op: "timeline", inputEvidenceIds: [bev!.evidenceId] }])).rejects.toMatchObject({ code: "derived_foreign_input" });
    // 본인 근거만 입력이면 통과(파생 본문은 입력 근거 이름으로만).
    const [own] = a1.issue(await a1.validateBatch([{ kind: "node", id: "na_project", label: "Project" }]));
    const d = await a1.validateBatch([{ kind: "derived", op: "profile-summary", inputEvidenceIds: [own!.evidenceId] }]);
    expect(d.items[0]!.content).toContain("결제 시스템 개편");
    expectNoB([d.items[0]!.content]);
  });
});
