import { describe, expect, it } from "vitest";
import { GROUPS } from "./AppSidebar";

const active = (p: string) => GROUPS.flatMap((g) => g.items).filter((i) => i.match(p)).map((i) => i.label);

describe("사이드바 공고 메뉴", () => {
  it("공고 찾기는 보관함과 별도 메뉴다", () => {
    const labels = GROUPS.find((g) => g.label === "지원")!.items.map((i) => i.label);
    expect(labels).toEqual(["공고 찾기", "공고 보관함", "지원 현황"]);
  });

  it("공고 찾기 경로에서는 공고 찾기만 활성", () => {
    expect(active("/app/postings/explore")).toEqual(["공고 찾기"]);
    expect(active("/app/postings/explore/abc")).toEqual(["공고 찾기"]);
  });

  it("보관함·보관 공고 상세는 공고 보관함만 활성", () => {
    expect(active("/app/postings")).toEqual(["공고 보관함"]);
    expect(active("/app/postings/abc")).toEqual(["공고 보관함"]);
    expect(active("/app/postings/explorer")).toEqual(["공고 보관함"]);
  });
});

describe("사이드바 서류 메뉴", () => {
  it("서류 그룹은 이력서 다음에 포트폴리오", () => {
    const items = GROUPS.find((g) => g.label === "서류")!.items;
    expect(items.map((i) => i.label)).toEqual(["이력서", "포트폴리오"]);
    expect(items[1]!.href).toBe("/app/portfolios");
    expect(items[1]!.icon).toBeTruthy();
  });

  it("포트폴리오 목록·상세는 포트폴리오만 활성", () => {
    expect(active("/app/portfolios")).toEqual(["포트폴리오"]);
    expect(active("/app/portfolios/abc")).toEqual(["포트폴리오"]);
    expect(active("/app/resumes/abc")).toEqual(["이력서"]);
    expect(active("/app/portfoliosx")).toEqual([]);
  });
});
