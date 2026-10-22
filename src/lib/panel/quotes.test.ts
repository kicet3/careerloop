import { describe, expect, it } from "vitest";
import { verifyQuote } from "./quotes";

const RESUME = `홍길동
hong@example.com · 010-1234-5678

경력
• 데이터 분석가 — ABC커머스 (2021.03 ~ 2024.02)
  - 주간 매출 대시보드를 “Tableau”로 구축해 보고 시간을 50% 단축
  - SQL 쿼리 최적화로 배치 시간을 3시간에서 40분으로 줄임
* Led a cross-functional team of 5 engineers to ship the
checkout redesign, increasing conversion by 12%.`;

describe("verifyQuote", () => {
  it("원문 줄 그대로면 통과", () => {
    expect(verifyQuote(RESUME, "SQL 쿼리 최적화로 배치 시간을 3시간에서 40분으로 줄임")).toBe(true);
  });

  it("글머리표·따옴표·대시 모양 차이는 무시", () => {
    expect(verifyQuote(RESUME, '- 주간 매출 대시보드를 "Tableau"로 구축해 보고 시간을 50% 단축')).toBe(true);
    expect(verifyQuote(RESUME, "데이터 분석가 - ABC커머스 (2021.03 ~ 2024.02)")).toBe(true);
  });

  it("공백·줄바꿈·대소문자 차이는 무시", () => {
    expect(
      verifyQuote(RESUME, "led a cross-functional team of 5 engineers to ship the checkout redesign"),
    ).toBe(true);
    expect(verifyQuote(RESUME, "SQL쿼리 최적화로  배치시간을")).toBe(true);
  });

  it("끝 마침표 유무는 무시", () => {
    expect(verifyQuote(RESUME, "SQL 쿼리 최적화로 배치 시간을 3시간에서 40분으로 줄임.")).toBe(true);
  });

  it("말줄임으로 끝나면 앞부분만 확인", () => {
    expect(verifyQuote(RESUME, "Led a cross-functional team of 5 engineers…")).toBe(true);
    expect(verifyQuote(RESUME, "Led a cross-functional team of 5 engineers...")).toBe(true);
  });

  it("중간 생략은 조각 순서를 확인", () => {
    expect(verifyQuote(RESUME, "주간 매출 대시보드를 … 50% 단축")).toBe(true);
    expect(verifyQuote(RESUME, "50% 단축 … 주간 매출 대시보드를")).toBe(false);
  });

  it("원문에 없는 문장·바꾼 숫자는 실패", () => {
    expect(verifyQuote(RESUME, "SQL 쿼리 최적화로 배치 시간을 4시간에서 40분으로 줄임")).toBe(false);
    expect(verifyQuote(RESUME, "Python으로 추천 모델 개발")).toBe(false);
  });

  it("너무 짧거나 빈 인용은 실패", () => {
    expect(verifyQuote(RESUME, "")).toBe(false);
    expect(verifyQuote(RESUME, "SQL")).toBe(false);
    expect(verifyQuote(RESUME, "…")).toBe(false);
  });

  it("전각 문자는 NFKC로 정규화", () => {
    expect(verifyQuote(RESUME, "ＳＱＬ 쿼리 최적화")).toBe(true);
  });
});
