import { describe, expect, it } from "vitest";
import { extractClaims, indexEvidence, normalizeText, unsupportedClaim } from "./claims";

describe("claims", () => {
  it("수치·날짜·이름 추출과 정규화(전각·쉼표, 2021.03 = 2021-03 = 2021년 3월)", () => {
    const c = extractClaims("２０２１.03부터 결제 시스템 개편에서 Kotlin으로 1,200건을 40% 줄였다", ["결제 시스템 개편"]);
    expect(c.dates).toEqual(["2021-03"]);
    expect(c.numbers).toEqual(expect.arrayContaining(["1200건", "40%"]));
    expect(c.names).toEqual(expect.arrayContaining(["결제 시스템 개편", "Kotlin"]));
    expect(normalizeText("１,２００ 건")).toBe("1200건");
    const ev = indexEvidence(["2021년 3월 시작. 결제 시스템 개편 Kotlin 1200건 40%"]);
    expect(unsupportedClaim(c, ev)).toBeNull();
    expect(unsupportedClaim(extractClaims("2021-03 시작"), indexEvidence(["2021.03"]))).toBeNull();
  });

  it("근거에 없는 수치·날짜·이름이면 그 종류를 돌려준다", () => {
    const ev = indexEvidence(["정산 시간 6시간에서 40분으로 단축 2023-09"]);
    expect(unsupportedClaim(extractClaims("정산 시간을 40% 줄였다"), ev)).toBe("number");
    expect(unsupportedClaim(extractClaims("2024-01에 끝났다"), ev)).toBe("date");
    expect(unsupportedClaim(extractClaims("Google과 함께 했다"), ev)).toBe("name");
    expect(unsupportedClaim(extractClaims("정산 시간을 40분으로 줄였다"), ev)).toBeNull();
  });

  it("수치는 숫자 경계·단위까지 같은 토큰으로만 맞춘다(부분 문자열 금지)", () => {
    const dates = indexEvidence(["프로젝트 · 결제 개편\n속성: startDate=2025-03; endDate=2025-11"]);
    expect(unsupportedClaim(extractClaims("주 5회 배포했습니다"), dates)).toBe("number");
    expect(unsupportedClaim(extractClaims("2회 수상했습니다"), dates)).toBe("number");
    expect(unsupportedClaim(extractClaims("3일 만에 복구했습니다"), dates)).toBe("number");
    const team = indexEvidence(["팀 15명, 매출 130% 증가"]);
    expect(unsupportedClaim(extractClaims("팀원 5명이었다"), team)).toBe("number");
    expect(unsupportedClaim(extractClaims("매출 30% 증가"), team)).toBe("number");
    expect(unsupportedClaim(extractClaims("팀 15명, 매출 130% 증가"), team)).toBeNull();
    expect(extractClaims("100TPS 처리, 주 5회").numbers).toEqual(expect.arrayContaining(["100tps", "5회"]));
    // 단위 있는 주장 ↔ 근거의 단위 없는 같은 값(속성값)은 인정, 단위 없는 주장은 같은 값과만.
    const prop = indexEvidence(["속성: teamSize=5"]);
    expect(unsupportedClaim(extractClaims("팀원 5명"), prop)).toBeNull();
    expect(unsupportedClaim(extractClaims("팀원 15명"), prop)).toBe("number");
    // 연도 없는 달은 근거 날짜의 달과.
    expect(unsupportedClaim(extractClaims("3월에 시작했다"), dates)).toBeNull();
    expect(unsupportedClaim(extractClaims("4월에 시작했다"), dates)).toBe("number");
  });
});
