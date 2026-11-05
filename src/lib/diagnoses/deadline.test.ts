import { describe, expect, it } from "vitest";
import { runDeadline } from "./deadline";

describe("runDeadline", () => {
  it("DIAGNOSIS_TIME_BUDGET_SEC가 더 짧으면 그 값", () => {
    expect(runDeadline(1000, 300, { DIAGNOSIS_TIME_BUDGET_SEC: "60", VERCEL: "1" })).toBe(61_000);
    expect(runDeadline(1000, 300, { DIAGNOSIS_TIME_BUDGET_SEC: "60" })).toBe(61_000);
  });
  it("Vercel이면 maxDuration에서 30초 여유", () => {
    expect(runDeadline(0, 300, { VERCEL: "1" })).toBe(270_000);
    expect(runDeadline(0, 800, { VERCEL: "1" })).toBe(770_000);
  });
  it("Vercel에서는 예산이 maxDuration보다 길어도 maxDuration - 30초에서 멈춘다", () => {
    expect(runDeadline(0, 300, { VERCEL: "1", DIAGNOSIS_TIME_BUDGET_SEC: "800" })).toBe(270_000);
  });
  it("자체 호스팅이면 마감 없음", () => {
    expect(runDeadline(0, 300, {})).toBeUndefined();
    expect(runDeadline(0, 300, { DIAGNOSIS_TIME_BUDGET_SEC: "abc" })).toBeUndefined();
  });
});
