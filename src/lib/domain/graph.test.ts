import { describe, expect, it } from "vitest";
import { toStrictJsonSchema } from "@/lib/llm/anthropic";
import { GraphChatOutputSchema, ReviewerChatOutputSchema } from "./chat";
import { describeGraphOp, type GraphOp, GraphOpSchema, isAllowedEdge, type LlmGraphOp, parseStoryTags, toGraphOps } from "./graph";
import { ResumeDraftOutputSchema } from "./resumes";

const blank: LlmGraphOp = { op: "addNode", ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };

describe("GraphOpSchema", () => {
  it("라벨별 속성을 검사하고 화이트리스트 밖 키는 받지 않는다(strip)", () => {
    const ok = GraphOpSchema.safeParse({ op: "addNode", ref: "new:1", label: "Company", props: { name: "페이랩", evil: "x" } });
    expect(ok.success).toBe(true);
    expect(ok.success && ok.data.op === "addNode" && "evil" in ok.data.props).toBe(false);
    expect(GraphOpSchema.safeParse({ op: "addNode", ref: "new:1", label: "Company", props: {} }).success).toBe(false);
    expect(GraphOpSchema.safeParse({ op: "addNode", ref: "x1", label: "Company", props: { name: "a" } }).success).toBe(false);
    expect(GraphOpSchema.safeParse({ op: "addNode", ref: "new:1", label: "Person", props: { name: "a" } }).success).toBe(false);
    expect(GraphOpSchema.safeParse({ op: "addEdge", type: "DROP_ALL", from: "me", to: "n1" }).success).toBe(false);
    expect(GraphOpSchema.safeParse({ op: "addNode", ref: "new:1", label: "Role", props: { title: "PM", startDate: "2021.03" } }).success).toBe(false);
  });

  it("updateNode는 null로 속성을 지울 수 있다", () => {
    const r = GraphOpSchema.safeParse({ op: "updateNode", id: "n1", label: "Role", props: { endDate: null, current: true } });
    expect(r.success).toBe(true);
  });
});

describe("toGraphOps", () => {
  it("평평한 LLM 연산을 엄격한 연산으로 바꾸고 값의 형을 맞춘다", () => {
    const { ops, errors } = toGraphOps([
      { ...blank, ref: "new:p", label: "Project", props: [{ key: "name", value: "정산 개편" }, { key: "teamSize", value: "5명" }, { key: "x", value: "y" }] },
      { ...blank, op: "updateNode", id: "n1", label: "Role", props: [{ key: "current", value: "true" }, { key: "endDate", value: "" }] },
      { ...blank, op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
      { ...blank, op: "addNode", ref: "new:bad", label: "" },
    ]);
    expect(errors).toHaveLength(1);
    expect(ops).toEqual<GraphOp[]>([
      { op: "addNode", ref: "new:p", label: "Project", props: { name: "정산 개편", teamSize: 5 } },
      { op: "updateNode", id: "n1", label: "Role", props: { current: true, endDate: null } },
      { op: "addEdge", type: "WORKED_ON", from: "me", to: "new:p" },
    ]);
  });

  it("속성 하나가 형식에 안 맞으면 그 속성만 빼고 노드·관계는 살린다", () => {
    const { ops, errors } = toGraphOps([
      {
        ...blank,
        ref: "new:proj",
        label: "Project",
        props: [
          { key: "name", value: "결제 시스템" },
          { key: "startDate", value: "2021.03" },
          { key: "endDate", value: "2022년 1월" },
          { key: "teamSize", value: "3-4" },
          { key: "url", value: "x".repeat(600) },
        ],
      },
      { ...blank, op: "addEdge", type: "WORKED_ON", from: "me", to: "new:proj" },
      { ...blank, ref: "new:p2", label: "Project", props: [{ key: "name", value: "정산" }, { key: "teamSize", value: "약 5~6명" }] },
    ]);
    expect(ops).toEqual<GraphOp[]>([
      { op: "addNode", ref: "new:proj", label: "Project", props: { name: "결제 시스템", startDate: "2021-03", endDate: "2022-01" } },
      { op: "addEdge", type: "WORKED_ON", from: "me", to: "new:proj" },
      // 범위는 56처럼 잘못 합치지 않고 뺀다
      { op: "addNode", ref: "new:p2", label: "Project", props: { name: "정산" } },
    ]);
    expect(errors.join("\n")).toMatch(/teamSize/);
    expect(errors.join("\n")).toMatch(/url/);
  });

  it("대표 속성이 없거나 틀리면 노드째 버린다", () => {
    const { ops, errors } = toGraphOps([{ ...blank, ref: "new:x", label: "Project", props: [{ key: "startDate", value: "2021-03" }] }]);
    expect(ops).toEqual([]);
    expect(errors).toHaveLength(1);
  });
});

describe("관계 규칙·설명", () => {
  it("허용된 방향만", () => {
    expect(isAllowedEdge("WORKED_AT", "Person", "Company")).toBe(true);
    expect(isAllowedEdge("WORKED_AT", "Company", "Person")).toBe(false);
    expect(isAllowedEdge("USED_SKILL", "Project", "Skill")).toBe(true);
  });
  it("describeGraphOp는 같은 변경안의 새 노드 이름을 쓴다", () => {
    const batch: GraphOp[] = [
      { op: "addNode", ref: "new:c", label: "Company", props: { name: "페이랩" } },
      { op: "addEdge", type: "WORKED_AT", from: "me", to: "new:c" },
    ];
    expect(describeGraphOp(batch[1]!, null, batch)).toBe("연결(재직): 나 → 페이랩");
  });
});

describe("LLM 출력 스키마", () => {
  it("구조화 출력 JSON schema로 바꿀 수 있다", () => {
    for (const s of [GraphChatOutputSchema, ReviewerChatOutputSchema, ResumeDraftOutputSchema]) {
      const json = JSON.stringify(toStrictJsonSchema(s));
      expect(json).toContain('"additionalProperties":false');
    }
  });
});

describe("자소서 소재 분류(categories)·STAR 속성", () => {
  const add = (props: { key: string; value: string }[]): LlmGraphOp => ({ ...blank, op: "addNode", ref: "new:p", label: "Project", props });

  it("toGraphOps: id·별칭으로 바꾸고 모르는 값은 errors에 남긴다", () => {
    const { ops, errors } = toGraphOps([add([{ key: "name", value: "대시보드" }, { key: "categories", value: "collaboration, 리더십, foo" }])]);
    expect(ops).toHaveLength(1);
    expect(ops[0]!.op === "addNode" && ops[0]!.props).toEqual({ name: "대시보드", categories: ["collaboration", "leadership"] });
    expect(errors.join("\n")).toContain("foo");
  });

  it("toGraphOps: 4개 넘으면 STORY_TAGS 순서로 3개까지, 모두 모르면 그 속성만 뺀다", () => {
    const four = toGraphOps([add([{ key: "name", value: "a" }, { key: "categories", value: "values|learning|협업|문제해결" }])]);
    expect(four.ops[0]!.op === "addNode" && four.ops[0]!.props).toEqual({
      name: "a",
      categories: ["problem-solving", "collaboration", "values"],
    });
    const none = toGraphOps([add([{ key: "name", value: "a" }, { key: "categories", value: "foo bar" }])]);
    expect(none.ops[0]!.op === "addNode" && none.ops[0]!.props).toEqual({ name: "a" });
  });

  it("toGraphOps: updateNode의 \"\"는 null, 공백이 든 별칭도 읽는다", () => {
    const { ops } = toGraphOps([
      { ...blank, op: "updateNode", id: "p1", label: "Experience", props: [{ key: "categories", value: "" }] },
      { ...blank, op: "updateNode", id: "p2", label: "Experience", props: [{ key: "categories", value: "도전·실패 극복" }] },
    ]);
    expect(ops[0]!.op === "updateNode" && ops[0]!.props).toEqual({ categories: null });
    expect(ops[1]!.op === "updateNode" && ops[1]!.props).toEqual({ categories: ["challenge-failure"] });
  });

  it("parseStoryTags: 쉼표 없이 공백으로 이어진 여러 분류는 가장 긴 별칭부터 맞춘다", () => {
    expect(parseStoryTags("리더십 문제 해결")).toEqual({ tags: ["problem-solving", "leadership"], unknown: [] });
    expect(parseStoryTags("협업 갈등 해결 지원 동기")).toEqual({ tags: ["collaboration", "motivation"], unknown: [] });
    expect(parseStoryTags("리더십 foo")).toEqual({ tags: ["leadership"], unknown: ["foo"] });
  });

  it("기존 props만 있는 addNode는 그대로, STAR 1000자 초과는 그 속성만 빠진다", () => {
    const old = toGraphOps([add([{ key: "name", value: "a" }, { key: "summary", value: "요약" }])]);
    expect(old.errors).toEqual([]);
    expect(old.ops[0]!.op === "addNode" && old.ops[0]!.props).toEqual({ name: "a", summary: "요약" });
    const long = toGraphOps([add([{ key: "name", value: "a" }, { key: "action", value: "가".repeat(1001) }, { key: "result", value: "30% 감소" }])]);
    expect(long.ops[0]!.op === "addNode" && long.ops[0]!.props).toEqual({ name: "a", result: "30% 감소" });
    expect(long.errors).toHaveLength(1);
  });

  it("GraphOpSchema는 모르는 태그와 빈 배열을 거부하고, Experience.myRole을 받는다", () => {
    const p = (categories: unknown) => ({ op: "addNode", ref: "new:1", label: "Project", props: { name: "a", categories } });
    expect(GraphOpSchema.safeParse(p(["collaboration"])).success).toBe(true);
    expect(GraphOpSchema.safeParse(p(["foo"])).success).toBe(false);
    expect(GraphOpSchema.safeParse(p([])).success).toBe(false);
    expect(GraphOpSchema.safeParse(p(["values", "learning", "leadership", "motivation"])).success).toBe(false);
    expect(GraphOpSchema.safeParse({ op: "addNode", ref: "new:1", label: "Experience", props: { title: "동아리", myRole: "회장" } }).success).toBe(true);
  });
});
