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
