import { describe, expect, it } from "vitest";
import { applyPatch } from "./patch";
import type { LlmPatchOp, ReviewIssue } from "./schemas";
import { draft, exp, proj } from "./__fixtures__/units";

const op = (o: Partial<LlmPatchOp>): LlmPatchOp => ({
  op: "replace",
  path: "",
  value: "",
  refs: [],
  section: "",
  order: [],
  project: null,
  skills: null,
  citations: [],
  issueIds: [],
  reason: "",
  ...o,
});
const issues: ReviewIssue[] = [
  { id: "i1", reviewer: "manager", severity: "major", quote: null, quoteVerified: false, paths: [], issue: "x", requirementId: "R1", needsUserInfo: false },
];
const base = () =>
  draft({ experience: [exp({ bullets: ["a", "b", "c"] }), exp({ company: "두번째", bullets: ["x"] })], projects: [proj({ name: "P0" }), proj({ name: "P1" })] }, [
    { path: "experience[0]", refs: ["E1"], requirementIds: [] },
    { path: "experience[0].bullets[2]", refs: ["E2"], requirementIds: [] },
    { path: "projects[1]", refs: ["E3"], requirementIds: [] },
  ]);
const ctx = { packRefs: new Set(["E1", "E2", "E3", "E4"]), requirementIds: new Set(["R1"]), round: 1, issues };

describe("applyPatch", () => {
  it("replace는 줄 경로 인용을 붙이고 ChangeRecord에 심사위원을 역산한다", () => {
    const r = applyPatch(base(), [op({ op: "replace", path: "experience[0].bullets[1]", value: "B", refs: ["E4"], issueIds: ["i1"] })], ctx);
    expect(r.draft.document.experience[0]!.bullets).toEqual(["a", "B", "c"]);
    expect(r.draft.citations).toContainEqual({ path: "experience[0].bullets[1]", refs: ["E4"], requirementIds: ["R1"] });
    expect(r.changes).toEqual([{ round: 1, op: "replace", path: "experience[0].bullets[1]", before: "b", after: "B", issueIds: ["i1"], reviewers: ["manager"] }]);
  });

  it("같은 배열 안 remove/insert는 패치 전 경로 기준·인덱스 내림차순으로 적용되고 인용이 따라간다", () => {
    const r = applyPatch(
      base(),
      [
        op({ op: "remove", path: "experience[0].bullets[0]" }),
        op({ op: "insert", path: "experience[0].bullets[2]", value: "new", refs: ["E4"] }),
        op({ op: "replace", path: "experience[0].bullets[2]", value: "C", refs: ["E2"] }),
      ],
      ctx,
    );
    // 패치 전 [a, b, c] → c를 C로, 2 앞에 new, 0 삭제 → [b, new, C]
    expect(r.draft.document.experience[0]!.bullets).toEqual(["b", "new", "C"]);
    expect(r.draft.citations.find((c) => c.refs.includes("E4"))?.path).toBe("experience[0].bullets[1]");
    expect(r.draft.citations.find((c) => c.refs[0] === "E2")?.path).toBe("experience[0].bullets[2]");
    expect(r.rejected).toEqual([]);
  });

  it("reorder는 마지막에 적용하고 항목 인용 경로를 옮긴다", () => {
    const r = applyPatch(base(), [op({ op: "reorder", section: "projects", order: [1, 0] }), op({ op: "replace", path: "experience[1].bullets[0]", value: "X", refs: ["E1"] })], ctx);
    expect(r.draft.document.projects.map((p) => p.name)).toEqual(["P1", "P0"]);
    expect(r.draft.citations.find((c) => c.refs.includes("E3"))?.path).toBe("projects[0]");
    expect(r.changes.at(-1)!.op).toBe("reorder");
  });

  it("잘못된 op만 버린다: 없는 경로·pack 밖 ref·글자 수 초과·잘못된 순열·빈 값", () => {
    const r = applyPatch(
      base(),
      [
        op({ op: "replace", path: "experience[5].bullets[0]", value: "v", refs: ["E1"] }),
        op({ op: "replace", path: "experience[0].bullets[0]", value: "v", refs: ["E99"] }),
        op({ op: "replace", path: "experience[0].bullets[0]", value: "가".repeat(501), refs: ["E1"] }),
        op({ op: "reorder", section: "projects", order: [0, 0] }),
        op({ op: "replace", path: "basics.email", value: "a@b.c", refs: ["E1"] }),
        op({ op: "insert", path: "experience[0].bullets[1]", value: "", refs: ["E1"] }),
        op({ op: "replace", path: "experience[0].bullets[0]", value: "ok", refs: ["E1"] }),
      ],
      ctx,
    );
    expect(r.rejected.map((x) => x.reason)).toEqual(["path_missing", "refs_invalid", "too_long", "order_invalid", "path_invalid", "empty_value"]);
    expect(r.draft.document.experience[0]!.bullets[0]).toBe("ok");
    expect(r.changes).toHaveLength(1);
  });

  it("addProject·setSkills: 근거 ref가 있으면 붙이고 인용을 단다", () => {
    const r = applyPatch(
      base(),
      [
        op({ op: "addProject", refs: ["E4"], project: proj({ name: "새 프로젝트" }), citations: [{ path: "projects[2]", refs: ["E4"], requirementIds: ["R1"] }] }),
        op({ op: "setSkills", skills: [{ category: "백엔드", detail: "d", items: ["Kotlin"] }], citations: [{ path: "skills[0]", refs: ["E2"], requirementIds: [] }] }),
      ],
      ctx,
    );
    expect(r.draft.document.projects.map((p) => p.name)).toEqual(["P0", "P1", "새 프로젝트"]);
    expect(r.draft.citations).toContainEqual({ path: "projects[2]", refs: ["E4"], requirementIds: ["R1"] });
    expect(r.draft.citations).toContainEqual({ path: "skills[0]", refs: ["E2"], requirementIds: [] });
  });

  it("전략이 뺀 근거만 인용한 replace·insert·addProject는 버린다(refs_excluded)", () => {
    const ex = { ...ctx, excludedRefs: new Set(["E4"]) };
    const r = applyPatch(
      base(),
      [
        op({ op: "insert", path: "experience[0].bullets[0]", value: "사내 체육대회 우승", refs: ["E4"] }),
        op({ op: "addProject", refs: ["E4"], project: proj({ name: "사소한 일" }) }),
        op({ op: "replace", path: "experience[0].bullets[1]", value: "B", refs: ["E4", "E2"] }),
      ],
      ex,
    );
    expect(r.rejected.map((x) => x.reason)).toEqual(["refs_excluded", "refs_excluded"]);
    expect(r.draft.document.projects).toHaveLength(2);
    // 다른 근거도 있으면 제외 ref만 빼고 받는다.
    expect(r.draft.citations).toContainEqual({ path: "experience[0].bullets[1]", refs: ["E2"], requirementIds: [] });
  });
});
