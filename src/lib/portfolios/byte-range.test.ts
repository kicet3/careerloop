import { describe, expect, it } from "vitest";
import { contentRangeHeader, parseRangeHeader, unsatisfiedRangeHeader } from "./byte-range";

describe("parseRangeHeader", () => {
  it("Range가 없거나 문법이 틀리면 none(무시)", () => {
    for (const h of [null, undefined, "", "bytes", "bytes=", "bytes=-", "items=0-1", "bytes=a-b", "bytes=0-1,5-9", "bytes=9-3", "bytes=1234567890123456-"]) {
      expect(parseRangeHeader(h, 1000)).toEqual({ kind: "none" });
    }
  });

  it("정상 구간·열린 끝·끝 넘침은 파일 끝으로 자른다", () => {
    expect(parseRangeHeader("bytes=0-99", 1000)).toEqual({ kind: "range", start: 0, end: 99 });
    expect(parseRangeHeader(" BYTES=100- ", 1000)).toEqual({ kind: "range", start: 100, end: 999 });
    expect(parseRangeHeader("bytes=900-5000", 1000)).toEqual({ kind: "range", start: 900, end: 999 });
    expect(parseRangeHeader("bytes=999-999", 1000)).toEqual({ kind: "range", start: 999, end: 999 });
  });

  it("끝에서 N바이트(suffix)", () => {
    expect(parseRangeHeader("bytes=-100", 1000)).toEqual({ kind: "range", start: 900, end: 999 });
    expect(parseRangeHeader("bytes=-5000", 1000)).toEqual({ kind: "range", start: 0, end: 999 });
    expect(parseRangeHeader("bytes=-0", 1000)).toEqual({ kind: "unsatisfiable" });
  });

  it("파일 밖에서 시작하거나 빈 파일이면 unsatisfiable(416)", () => {
    expect(parseRangeHeader("bytes=1000-", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=2000-3000", 1000)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=0-10", 0)).toEqual({ kind: "unsatisfiable" });
    expect(parseRangeHeader("bytes=-10", 0)).toEqual({ kind: "unsatisfiable" });
  });

  it("maxLength로 조각 길이를 자른다", () => {
    expect(parseRangeHeader("bytes=0-", 10_000, 4096)).toEqual({ kind: "range", start: 0, end: 4095 });
    expect(parseRangeHeader("bytes=-9000", 10_000, 4096)).toEqual({ kind: "range", start: 1000, end: 5095 });
    expect(parseRangeHeader("bytes=10-20", 10_000, 4096)).toEqual({ kind: "range", start: 10, end: 20 });
  });

  it("Content-Range 값", () => {
    expect(contentRangeHeader(0, 99, 1000)).toBe("bytes 0-99/1000");
    expect(unsatisfiedRangeHeader(1000)).toBe("bytes */1000");
  });
});
