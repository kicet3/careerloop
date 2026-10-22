import { describe, expect, it } from "vitest";
import { saveCreationWarnings, takeCreationWarnings } from "./creation-warnings";

function memoryStore() {
  const m = new Map<string, string>();
  return {
    getItem: (k: string) => m.get(k) ?? null,
    setItem: (k: string, v: string) => void m.set(k, v),
    removeItem: (k: string) => void m.delete(k),
  };
}

describe("creation warnings", () => {
  it("진단 id별로 저장하고 한 번만 읽는다", () => {
    const store = memoryStore();
    saveCreationWarnings("d1", ["채용 공고가 매우 짧습니다."], store);
    expect(takeCreationWarnings("d2", store)).toEqual([]);
    expect(takeCreationWarnings("d1", store)).toEqual(["채용 공고가 매우 짧습니다."]);
    expect(takeCreationWarnings("d1", store)).toEqual([]);
  });

  it("개수·길이를 제한하고 형식이 틀리면 무시한다", () => {
    const store = memoryStore();
    saveCreationWarnings("d1", Array.from({ length: 9 }, () => "가".repeat(500)), store);
    const got = takeCreationWarnings("d1", store);
    expect(got).toHaveLength(5);
    expect(got[0]).toHaveLength(200);
    store.setItem("rp:create-warnings:d3", "{not json");
    expect(takeCreationWarnings("d3", store)).toEqual([]);
  });
});
