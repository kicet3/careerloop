import { describe, expect, it } from "vitest";
import { EXPERIENCE_CATEGORIES, storyTagName } from "./experience-categories";
import { NODE_PROP_SCHEMAS, resolveStoryTag, STORY_TAGS } from "./graph";

const key = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/|]+/g, "");

describe("EXPERIENCE_CATEGORIES", () => {
  it("id가 유일하고 필수 6개·추천 4개", () => {
    const ids = EXPERIENCE_CATEGORIES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(EXPERIENCE_CATEGORIES.filter((c) => c.required)).toHaveLength(6);
    expect(EXPERIENCE_CATEGORIES.filter((c) => !c.required)).toHaveLength(4);
  });

  it("태그 카테고리 = STORY_TAGS, 자동 판정은 career·quantified-result", () => {
    expect(EXPERIENCE_CATEGORIES.filter((c) => c.source === "tag").map((c) => c.id)).toEqual([...STORY_TAGS]);
    expect(EXPERIENCE_CATEGORIES.filter((c) => c.source === "auto").map((c) => c.id)).toEqual(["career", "quantified-result"]);
  });

  it("별칭은 카테고리끼리 겹치지 않고 id로 풀린다", () => {
    const owner = new Map<string, string>();
    for (const c of EXPERIENCE_CATEGORIES.filter((x) => x.source === "tag")) {
      for (const a of [c.id, ...c.aliases]) {
        const k = key(a);
        expect(owner.get(k) ?? c.id, `${a}`).toBe(c.id);
        owner.set(k, c.id);
        expect(resolveStoryTag(a)).toBe(c.id);
      }
    }
  });

  it("모든 minFields는 Project·Experience 스키마의 키이고, 태그 카테고리는 최소 필드가 있다", () => {
    for (const c of EXPERIENCE_CATEGORIES) {
      if (c.source === "tag") expect(c.minFields.length).toBeGreaterThan(0);
      for (const f of c.minFields) {
        expect(Object.keys(NODE_PROP_SCHEMAS.Project.shape)).toContain(f);
        expect(Object.keys(NODE_PROP_SCHEMAS.Experience.shape)).toContain(f);
      }
    }
    expect(storyTagName("collaboration")).toBe("협업·갈등 해결");
    expect(storyTagName("foo")).toBe("foo");
  });
});
