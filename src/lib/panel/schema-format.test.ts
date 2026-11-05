import { describe, expect, it } from "vitest";
import { toStrictJsonSchema } from "@/lib/llm/anthropic";
import { STAGE_KEYS, STAGE_SCHEMAS } from "@/lib/domain/schemas";
import { PostingFactsSchema } from "@/lib/domain/postings";

function walk(node: unknown, visit: (n: Record<string, unknown>) => void) {
  if (Array.isArray(node)) return node.forEach((n) => walk(n, visit));
  if (node && typeof node === "object") {
    visit(node as Record<string, unknown>);
    Object.values(node).forEach((v) => walk(v, visit));
  }
}

describe("toStrictJsonSchema", () => {
  it.each(STAGE_KEYS)("%s 스키마를 구조화 출력 부분집합으로 변환", (stage) => {
    const schema = toStrictJsonSchema(STAGE_SCHEMAS[stage]);
    expect(schema.$schema).toBeUndefined();
    walk(schema, (n) => {
      if (n.type === "object") expect(n.additionalProperties).toBe(false);
      for (const k of ["minimum", "maximum", "maxItems", "minLength", "maxLength"]) expect(n[k]).toBeUndefined();
      if (n.minItems !== undefined) expect([0, 1]).toContain(n.minItems);
    });
  });

  it("enum은 유지한다(판정 값 강제)", () => {
    const s = JSON.stringify(toStrictJsonSchema(STAGE_SCHEMAS.ats));
    expect(s).toContain('"enum":["PASS","REJECT"]');
    const syn = JSON.stringify(toStrictJsonSchema(STAGE_SCHEMAS.synthesis));
    expect(syn).toContain('"critical","major","minor"');
  });

  it("공고 추출 스키마(PostingFactsSchema)도 모든 필드 필수·enum 유지", () => {
    const schema = toStrictJsonSchema(PostingFactsSchema) as { required?: string[]; properties?: Record<string, unknown> };
    expect(new Set(schema.required)).toEqual(new Set(Object.keys(PostingFactsSchema.shape)));
    const s = JSON.stringify(schema);
    expect(s).toContain('"full_time"');
    walk(schema, (n) => {
      if (n.type === "object") expect(n.additionalProperties).toBe(false);
      expect(n.anyOf).toBeUndefined();
    });
  });
});
