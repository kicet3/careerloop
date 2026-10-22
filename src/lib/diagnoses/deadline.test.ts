import { describe, expect, it } from "vitest";
import { runDeadline } from "./deadline";

describe("runDeadline", () => {
  it("DIAGNOSIS_TIME_BUDGET_SEC가 우선", () => {
    expect(runDeadline(1000, 800, { DIAGNOSIS_TIME_BUDGET_SEC: "60", VERCEL: "1" })).toBe(61_000);
  });
  it("Vercel이면 maxDuration에서 30초 여유", () => {
    expect(runDeadline(0, 800, { VERCEL: "1" })).toBe(770_000);
  });
  it("자체 호스팅이면 마감 없음", () => {
    expect(runDeadline(0, 800, {})).toBeUndefined();
  });
});
