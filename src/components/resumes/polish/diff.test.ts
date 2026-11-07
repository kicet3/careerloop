import { describe, expect, it } from "vitest";
import { wordDiff } from "./diff";

describe("wordDiff", () => {
  it("같은 낱말은 남기고 바뀐 낱말만 지움·더함으로 표시한다", () => {
    const parts = wordDiff("정산 배치를 개편했다", "정산 배치를 스트리밍으로 개편했다");
    expect(parts.filter((p) => p.kind === "add").map((p) => p.text.trim())).toEqual(["스트리밍으로"]);
    expect(parts.some((p) => p.kind === "del")).toBe(false);
  });

  it("조각을 이으면 전·후 원문이 된다", () => {
    const before = "결제 API 개발\n정산 담당";
    const after = "결제 API를 Go로 개발\n정산 배치 담당";
    const parts = wordDiff(before, after);
    expect(parts.filter((p) => p.kind !== "add").map((p) => p.text).join("")).toBe(before);
    expect(parts.filter((p) => p.kind !== "del").map((p) => p.text).join("")).toBe(after);
  });
});
