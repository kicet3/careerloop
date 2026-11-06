/** 사용량 기간 시작(한국 시간 자정 기준). */
import { describe, expect, it } from "vitest";
import { periodStart } from "./llm-usage";

describe("periodStart", () => {
  // 2026-11-06T16:30Z = 한국 시간 11월 7일 01:30 — UTC 기준이면 하루 어긋난다.
  const now = Date.parse("2026-11-06T16:30:00Z");

  it("오늘: 한국 시간 자정(UTC 전날 15:00)부터", () => {
    expect(periodStart("today", now)?.toISOString()).toBe("2026-11-06T15:00:00.000Z");
  });

  it("7일·30일: 오늘 포함 N일의 한국 시간 자정부터", () => {
    expect(periodStart("7d", now)?.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    expect(periodStart("30d", now)?.toISOString()).toBe("2026-10-08T15:00:00.000Z");
  });

  it("한국 시간 자정 직전이면 아직 전날", () => {
    expect(periodStart("today", Date.parse("2026-11-06T14:59:59Z"))?.toISOString()).toBe("2026-11-05T15:00:00.000Z");
  });

  it("전체: null", () => {
    expect(periodStart("all", now)).toBeNull();
  });
});
