import { describe, expect, it } from "vitest";
import {
  addKstDays,
  daysBetween,
  formatKstDate,
  isValidKstDate,
  isValidKstTime,
  kstDate,
  kstDateTimeToMs,
  relativeKstLabel,
} from "./kst";

describe("KST 날짜", () => {
  it("UTC 15:00이 KST 다음 날 자정이다", () => {
    expect(kstDate(Date.parse("2026-11-05T14:59:59Z"))).toBe("2026-11-05");
    expect(kstDate(Date.parse("2026-11-05T15:00:00Z"))).toBe("2026-11-06");
  });

  it("실제 있는 날짜·시각만 받는다", () => {
    expect(isValidKstDate("2026-02-28")).toBe(true);
    expect(isValidKstDate("2026-02-30")).toBe(false);
    expect(isValidKstDate("2026-2-3")).toBe(false);
    expect(isValidKstDate("")).toBe(false);
    expect(isValidKstTime("23:59")).toBe(true);
    expect(isValidKstTime("24:00")).toBe(false);
  });

  it("일수·더하기·시각 변환", () => {
    expect(daysBetween("2026-12-30", "2027-01-02")).toBe(3);
    expect(daysBetween("2026-11-05", "2026-11-04")).toBe(-1);
    expect(addKstDays("2026-12-31", 1)).toBe("2027-01-01");
    expect(kstDateTimeToMs("2026-11-05", "09:00")).toBe(Date.parse("2026-11-05T00:00:00Z"));
    expect(kstDateTimeToMs("nope")).toBeNull();
  });

  it("표시 문구", () => {
    expect(formatKstDate("2026-11-05", { withWeekday: true })).toBe("11월 5일 (목)");
    expect(formatKstDate("", {})).toBe("날짜 미정");
    expect(relativeKstLabel("2026-11-06", "2026-11-05")).toBe("내일");
    expect(relativeKstLabel("2026-11-03", "2026-11-05")).toBe("2일 지남");
  });
});
