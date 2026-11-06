/** 보관함·공고 찾기 목록 화면(서버 렌더 마크업): 쪽 이동 링크(조건 유지·aria-current), 병역특례 태그·필터, 회사 필터(칩·주소). */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { JobPostingSummary } from "@/lib/domain/postings";
import { EMPTY_EXPLORE_FILTERS, exploreSearchParams, parseExploreSearchParams, type SharedPostingSummary } from "@/lib/domain/shared-postings";
import { EMPTY_POSTING_FILTERS, parsePostingSearchParams, postingSearchParams } from "@/lib/postings/filter";
import { ExploreView } from "./ExploreView";
import { PostingsView } from "./PostingsView";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }) }));

const sharedItem = (over: Partial<SharedPostingSummary> = {}): SharedPostingSummary => ({
  id: "s1",
  url: "https://example.com/j/1",
  urlKey: "example.com/j/1",
  platform: "",
  company: "토스",
  roleTitle: "백엔드",
  deadline: "",
  deadlineTime: "",
  deadlineKind: "rolling",
  employmentType: "unknown",
  workType: "unknown",
  location: "",
  careerLevel: "unknown",
  militaryService: [],
  importerCount: 0,
  fetchedAt: 0,
  myPostingId: null,
  ...over,
});

const libraryItem = (over: Partial<JobPostingSummary> = {}): JobPostingSummary => ({
  id: "p1",
  company: "토스",
  roleTitle: "백엔드",
  url: "",
  urlKey: null,
  platform: "",
  status: "saved",
  deadline: "",
  deadlineTime: "",
  deadlineKind: "rolling",
  employmentType: "unknown",
  workType: "unknown",
  location: "",
  careerLevel: "unknown",
  note: "",
  extractedBy: "manual",
  sharedPostingId: null,
  createdAt: 0,
  updatedAt: 0,
  hasJd: true,
  ...over,
});

const decode = (html: string) => html.replaceAll("&amp;", "&");

describe("ExploreView 쪽 나누기·병역특례", () => {
  const render = (page: number, pageCount: number) =>
    decode(
      renderToStaticMarkup(
        <ExploreView
          list={{ items: [sharedItem({ militaryService: ["expert", "industrial", "industrial_supplementary"] })], total: pageCount * 12, page, pageCount, pageSize: 12 }}
          filters={{ ...EMPTY_EXPLORE_FILTERS, q: "ios", military: "any" }}
          serverNow={0}
        />,
      ),
    );

  it("쪽 이동 링크는 지금 조건을 싣고 현재 쪽에 aria-current를 단다", () => {
    const html = render(2, 3);
    expect(html).toContain('aria-label="공고 찾기 쪽 이동"');
    expect(html).toMatch(/aria-current="page"[^>]*href="\/app\/postings\/explore\?q=ios&military=any&page=2"/);
    expect(html).toMatch(/rel="prev"[^>]*href="\/app\/postings\/explore\?q=ios&military=any"/);
    expect(html).toContain('href="/app/postings/explore?q=ios&military=any&page=3"');
    expect(html).not.toContain("더 보기");
    expect(html).toContain("36개 중 13–24");
  });

  it("첫 쪽의 '이전'은 링크가 아니고, 한 쪽뿐이면 쪽 이동을 그리지 않는다", () => {
    expect(render(1, 2)).toMatch(/<span aria-disabled="true"[^>]*>이전<\/span>/);
    expect(render(1, 1)).not.toContain("쪽 이동");
  });

  it("카드에 병역특례 태그, 필터에 병역특례 선택", () => {
    const html = render(1, 1);
    expect(html).toContain("전문연 가능");
    expect(html).toContain("산업기능요원 가능(보충역)");
    expect(html).toContain('id="explore-military"');
    expect(html).toMatch(/<option value="any" selected="">병역특례 가능<\/option>/);
  });

  it("결과가 없을 때 병역특례 조건을 걸었으면 그 조건도 넓혀 보라고 안내한다", () => {
    const empty = (military: "all" | "expert") =>
      renderToStaticMarkup(
        <ExploreView
          list={{ items: [], total: 0, page: 1, pageCount: 1, pageSize: 12 }}
          filters={{ ...EMPTY_EXPLORE_FILTERS, q: "ios", military }}
          serverNow={0}
        />,
      );
    expect(empty("expert")).toContain("병역특례 조건을 &#x27;병역특례 전체&#x27;로");
    expect(empty("all")).toContain("마감 조건을");
    expect(empty("all")).not.toContain("병역특례 조건을");
  });
});

describe("PostingsView 쪽 나누기", () => {
  it("조건(상태·정렬·검색)을 실은 쪽 링크와 병역특례 태그", () => {
    const html = decode(
      renderToStaticMarkup(
        <PostingsView
          list={{ items: [libraryItem({ militaryService: ["general"] })], total: 13, page: 1, pageCount: 2, pageSize: 12, allCount: 20, activeCount: 13 }}
          filters={{ ...EMPTY_POSTING_FILTERS, query: "토스", status: "all" }}
          sort="company"
          initialImports={[]}
          serverNow={0}
        />,
      ),
    );
    expect(html).toContain('aria-label="공고 보관함 쪽 이동"');
    expect(html).toMatch(/aria-current="page"[^>]*href="\/app\/postings\?q=%ED%86%A0%EC%8A%A4&status=all&sort=company"/);
    expect(html).toContain('href="/app/postings?q=%ED%86%A0%EC%8A%A4&status=all&sort=company&page=2"');
    expect(html).toContain("병역특례 가능");
    expect(html).toContain("20개");
  });
});

describe("보관함 주소(parsePostingSearchParams·postingSearchParams)", () => {
  it("기본값은 싣지 않고, 틀린 값은 기본값으로, 왕복하면 같다", () => {
    expect(postingSearchParams(EMPTY_POSTING_FILTERS)).toBe("");
    const qs = "q=toss&status=applied&sort=company&soon=1&page=2";
    const parsed = parsePostingSearchParams(Object.fromEntries(new URLSearchParams(qs)));
    expect(parsed).toEqual({ filters: { query: "toss", status: "applied", onlyClosingSoon: true, companies: [] }, sort: "company", page: 2 });
    expect(postingSearchParams(parsed.filters, parsed.sort, parsed.page)).toBe(qs);
    expect(parsePostingSearchParams({ status: "nope", sort: "x", page: "0" })).toEqual({ filters: EMPTY_POSTING_FILTERS, sort: "deadline", page: 1 });
  });
});

describe("회사 필터(주소·칩)", () => {
  const toss = { key: "토스", label: "토스", count: 3 };
  const kakao = { key: "카카오", label: "(주)카카오", count: 2 };

  it("보관함: ?company=키 여러 번(또는 쉼표 목록)을 받고, 다른 조건·쪽과 함께 왕복한다", () => {
    const qs = "q=ios&status=all&company=%ED%86%A0%EC%8A%A4&company=%EC%B9%B4%EC%B9%B4%EC%98%A4&sort=company&page=2";
    // Next의 searchParams: 같은 이름이 여러 번이면 배열.
    const parsed = parsePostingSearchParams({ q: "ios", status: "all", company: ["토스", "카카오"], sort: "company", page: "2" });
    expect(parsed.filters.companies).toEqual(["토스", "카카오"]);
    expect(postingSearchParams(parsed.filters, parsed.sort, parsed.page)).toBe(qs);
    // 쉼표 목록·원래 표기도 키로 바꾼다(중복은 하나로).
    expect(parsePostingSearchParams({ company: "(주)카카오, 토스 ,카카오 주식회사" }).filters.companies).toEqual(["카카오", "토스"]);
    // 회사를 바꾼 조건의 주소는 1쪽(쪽을 싣지 않는다) — useUrlFilters가 toQuery(draft)로 바꾼다.
    expect(postingSearchParams({ ...parsed.filters, companies: ["토스"] }, parsed.sort)).toBe("q=ios&status=all&company=%ED%86%A0%EC%8A%A4&sort=company");
  });

  it("공고 찾기: ?company=키를 다른 조건과 함께 왕복한다(예전 주소의 회사 이름도 키로)", () => {
    const qs = "q=ios&company=%ED%86%A0%EC%8A%A4&company=kakao&role=%EB%B0%B1%EC%97%94%EB%93%9C&military=any&page=3";
    const parsed = parseExploreSearchParams({ q: "ios", company: ["토스", "kakao"], role: "백엔드", military: "any", page: "3" });
    expect(parsed.filters.companies).toEqual(["토스", "kakao"]);
    expect(exploreSearchParams(parsed.filters, parsed.page)).toBe(qs);
    expect(parseExploreSearchParams({ company: "Kakao Corp." }).filters.companies).toEqual(["kakao"]);
    expect(parseExploreSearchParams({}).filters.companies).toEqual([]);
  });

  it("공고 찾기: 고른 회사는 칩(이름·빼기 버튼)으로, 쪽 링크는 회사 조건을 싣는다", () => {
    const html = decode(
      renderToStaticMarkup(
        <ExploreView
          list={{ items: [sharedItem()], total: 24, page: 1, pageCount: 2, pageSize: 12 }}
          filters={{ ...EMPTY_EXPLORE_FILTERS, companies: ["카카오", "토스"] }}
          companyOptions={[toss, kakao]}
          serverNow={0}
        />,
      ),
    );
    expect(html).toMatch(/<input[^>]*id="explore-company"[^>]*role="combobox"[^>]*aria-expanded="false"/);
    expect(html).toContain('aria-label="(주)카카오 빼기"');
    expect(html).toContain('aria-label="토스 빼기"');
    expect(html).toContain("회사 지우기");
    expect(html).toContain('href="/app/postings/explore?company=%EC%B9%B4%EC%B9%B4%EC%98%A4&company=%ED%86%A0%EC%8A%A4&page=2"');
  });

  it("보관함: 회사 필터 입력칸, 고른 회사가 목록에 없으면 키로 보인다, 쪽 링크에 회사 조건", () => {
    const html = decode(
      renderToStaticMarkup(
        <PostingsView
          list={{ items: [libraryItem()], total: 13, page: 1, pageCount: 2, pageSize: 12, allCount: 20, activeCount: 13 }}
          filters={{ ...EMPTY_POSTING_FILTERS, companies: ["토스", "없는회사"] }}
          companyOptions={[toss]}
          initialImports={[]}
          serverNow={0}
        />,
      ),
    );
    expect(html).toContain('id="posting-company"');
    expect(html).toContain('aria-label="토스 빼기"');
    expect(html).toContain('aria-label="없는회사 빼기"');
    expect(html).toContain('href="/app/postings?company=%ED%86%A0%EC%8A%A4&company=%EC%97%86%EB%8A%94%ED%9A%8C%EC%82%AC&page=2"');
    // 고른 회사가 없으면 칩·지우기 버튼이 없다.
    const plain = renderToStaticMarkup(
      <PostingsView list={{ items: [libraryItem()], total: 1, page: 1, pageCount: 1, pageSize: 12, allCount: 1, activeCount: 1 }} filters={EMPTY_POSTING_FILTERS} initialImports={[]} serverNow={0} />,
    );
    expect(plain).toContain('id="posting-company"');
    expect(plain).not.toContain("회사 지우기");
    // 목록에 없는 회사 키는 '(공고 없음)'으로 표시한다.
    expect(html).toContain("(공고 없음)");
  });

  it("보관함: 진행 중 조건에서만 빈 목록이면 고른 회사를 지우지 않고 상태만 넓히는 버튼", () => {
    const html = decode(
      renderToStaticMarkup(
        <PostingsView
          list={{ items: [], total: 0, page: 1, pageCount: 1, pageSize: 12, allCount: 5, activeCount: 3, allStatusCount: 2 }}
          filters={{ ...EMPTY_POSTING_FILTERS, companies: ["마감회사"] }}
          initialImports={[]}
          serverNow={0}
        />,
      ),
    );
    expect(html).toContain("마감·보류 공고 2개까지 보기");
    expect(html).not.toContain("필터 초기화");
  });
});
