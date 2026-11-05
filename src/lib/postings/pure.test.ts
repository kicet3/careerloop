/**
 * 공고 순수 모듈: URL 정규화·검사·플랫폼, KST 마감 계산, JD 섹션, 목록 필터.
 * URL·마감 사례는 CareerLoop(src/lib/postings.test.ts, src/lib/postingDeadlineTime.test.ts, src/lib/writing.test.ts)에서 가져옴.
 */
import { describe, expect, it } from "vitest";
import type { JobPostingSummary } from "@/lib/domain/postings";
import { deadlineInfo, formatPostingDeadline, isClosingSoon, isValidDeadlineDate, postingDeadlineAt } from "./deadline";
import { EMPTY_POSTING_FILTERS, filterPostings } from "./filter";
import { analyzeJobDescription } from "./jd-sections";
import { inferPlatform, isValidUrl, normalizeUrl, parsePostingUrl, PostingUrlError } from "./url";

describe("URL 정규화와 중복 판별", () => {
  it("추적 파라미터, www, 끝 슬래시를 무시하고 같은 공고로 본다", () => {
    expect(normalizeUrl("https://www.wanted.co.kr/wd/231440/?utm_source=x")).toBe(normalizeUrl("https://wanted.co.kr/wd/231440"));
    expect(normalizeUrl("https://groupby.kr/positions/9983?client_id=zighang")).toBe(normalizeUrl("https://groupby.kr/positions/9983"));
    expect(normalizeUrl("wanted.co.kr/wd/231440")).toBe(normalizeUrl("https://www.wanted.co.kr/wd/231440#apply"));
  });

  it("서로 다른 공고는 다르게 본다", () => {
    expect(normalizeUrl("https://www.wanted.co.kr/wd/1")).not.toBe(normalizeUrl("https://www.wanted.co.kr/wd/2"));
  });

  it("개별 공고의 플랫폼 별칭과 검색 유입 정보를 무시한다", () => {
    for (const [bookmark, canonical] of [
      ["https://recruit.wanted.co.kr/wd/310318?country=kr&job_sort=job.latest_order", "https://www.wanted.co.kr/wd/310318"],
      ["https://m.catch.co.kr/NCS/RecruitInfoDetails/568470?side=true", "https://www.catch.co.kr/NCS/RecruitInfoDetails/568470"],
      ["https://www.jobkorea.co.kr/Recruit/GI_Read/50040504?Oem_Code=C1&logpath=1", "https://jobkorea.co.kr/Recruit/GI_Read/50040504"],
      ["https://career.rememberapp.co.kr/job/posting/336229?channel=search", "https://career.rememberapp.co.kr/job/posting/336229"],
      [
        "https://zighang.com/recruitment/02b6fce9-184c-4dd8-a278-d1590c89fd7c?from=search",
        "https://zighang.com/recruitment/02b6fce9-184c-4dd8-a278-d1590c89fd7c",
      ],
      ["https://www.jobplanet.co.kr/job/search?query=backend&posting_ids[]=1302847&page=2", "https://jobplanet.co.kr/job/search?posting_ids%5B%5D=1302847"],
    ]) {
      expect(normalizeUrl(bookmark!)).toBe(normalizeUrl(canonical!));
    }
  });

  it("공고 ID와 일반 검색 URL의 의미 있는 조건은 유지한다", () => {
    expect(normalizeUrl("https://www.jobplanet.co.kr/job/search?posting_ids[]=1302847")).not.toBe(
      normalizeUrl("https://www.jobplanet.co.kr/job/search?posting_ids[]=1475909"),
    );
    expect(normalizeUrl("https://www.jobplanet.co.kr/job/search?posting_ids[]=1&posting_ids[]=2")).not.toBe(
      normalizeUrl("https://www.jobplanet.co.kr/job/search?posting_ids[]=1"),
    );
    expect(normalizeUrl("https://wanted.co.kr/search?query=Python")).not.toBe(normalizeUrl("https://wanted.co.kr/search?query=Java"));
    expect(normalizeUrl("https://example.com/job?id=1")).not.toBe(normalizeUrl("https://example.com/job?id=2"));
    expect(normalizeUrl("https://m.catch.co.kr/NCS/RecruitInfoDetails/568470")).not.toBe(
      normalizeUrl("https://www.catch.co.kr/NCS/RecruitInfoDetails/572766"),
    );
  });

  it("URL 형식을 검사한다", () => {
    expect(isValidUrl("https://www.wanted.co.kr/wd/1")).toBe(true);
    expect(isValidUrl("wanted.co.kr/wd/1")).toBe(true);
    expect(isValidUrl("그냥 텍스트")).toBe(false);
    expect(isValidUrl("")).toBe(false);
    expect(isValidUrl("ftp://example.org/x")).toBe(false);
  });

  it.each(["file:///etc/passwd", "ftp://example.org", "https://user:pass@example.org", "http://example.org:8080", "javascript:alert(1)"])(
    "가져오기는 공개 http/https 주소만 받는다: %s",
    (url) => expect(() => parsePostingUrl(url)).toThrow(PostingUrlError),
  );

  it("스킴 없는 주소는 https로 보고, 해시는 뺀다", () => {
    expect(parsePostingUrl("wanted.co.kr/wd/1#top").href).toBe("https://wanted.co.kr/wd/1");
  });

  it("플랫폼을 호스트로 알아내고, 모르는 도메인은 호스트 이름으로 둔다", () => {
    expect(inferPlatform("https://www.wanted.co.kr/wd/1")).toBe("wanted");
    expect(inferPlatform("https://kr.linkedin.com/jobs/view/1")).toBe("linkedin");
    expect(inferPlatform("https://www.saramin.co.kr/zf_user/jobs/view?rec_idx=1")).toBe("saramin");
    expect(inferPlatform("https://www.talent.hyundai.com/apply")).toBe("talent.hyundai.com");
    expect(inferPlatform("사람인에서 봄")).toBe("");
  });
});

describe("한국 시간 마감", () => {
  const p = (deadline: string, deadlineTime = "", deadlineKind: "date" | "rolling" | "unspecified" = deadline ? "date" : "unspecified") => ({
    deadline,
    deadlineTime,
    deadlineKind,
  });
  // 2026-09-01 09:00 KST
  const TODAY = Date.parse("2026-09-01T00:00:00Z");

  it("마감일이 없으면 종류에 따라 상시 채용·미공개를 구분한다", () => {
    expect(deadlineInfo(p("", "", "unspecified"), TODAY)).toMatchObject({ level: "none", label: "마감일 미공개" });
    expect(deadlineInfo(p("", "", "rolling"), TODAY)).toMatchObject({ level: "none", label: "상시 채용" });
  });

  it("3일 이내는 긴급, 7일 이내는 임박, 오늘·지난 마감은 따로 표기한다", () => {
    expect(deadlineInfo(p("2026-09-03"), TODAY)).toMatchObject({ level: "urgent", label: "D-2" });
    expect(deadlineInfo(p("2026-09-06"), TODAY).level).toBe("soon");
    expect(deadlineInfo(p("2026-09-20"), TODAY).level).toBe("safe");
    expect(deadlineInfo(p("2026-09-01"), TODAY).label).toBe("오늘 마감");
    expect(deadlineInfo(p("2026-08-29"), TODAY)).toMatchObject({ level: "past", label: "마감 3일 지남" });
  });

  it("마감 1ms 전과 정각을 구분한다(시각은 KST)", () => {
    const base = p("2026-09-10", "18:00");
    expect(deadlineInfo(base, new Date("2026-09-10T08:59:59.999Z"))).toMatchObject({ level: "urgent", label: "1분 남음" });
    expect(deadlineInfo(base, new Date("2026-09-10T09:00:00Z"))).toMatchObject({ level: "past", label: "마감됨" });
    expect(deadlineInfo(base, new Date("2026-09-10T07:30:00Z")).label).toBe("1시간 30분 남음");
  });

  it("날짜만 있는 마감은 한국 자정까지 유지한다", () => {
    const base = p("2026-09-10");
    expect(deadlineInfo(base, new Date("2026-09-10T14:59:59Z")).level).toBe("urgent");
    expect(deadlineInfo(base, new Date("2026-09-10T15:00:00Z")).level).toBe("past");
    expect(postingDeadlineAt(p("2026-09-10", "00:00"))).toBe(Date.parse("2026-09-09T15:00:00Z"));
  });

  it("UTC 자정 직전(KST로는 다음 날)에도 남은 일수를 KST 달력으로 센다 — 서버 시간대와 무관(R-13)", () => {
    // 2026-09-01T15:30Z = 9월 2일 00:30 KST. 마감 9월 3일 → D-1.
    expect(deadlineInfo(p("2026-09-03"), Date.parse("2026-09-01T15:30:00Z"))).toMatchObject({ days: 1, label: "D-1" });
  });

  it("잘못된 날짜를 다음 달로 넘기지 않는다", () => {
    expect(isValidDeadlineDate("2026-02-30")).toBe(false);
    expect(isValidDeadlineDate("2028-02-29")).toBe(true);
    expect(deadlineInfo(p("2026-02-30"), TODAY)).toMatchObject({ level: "none", label: "마감일 확인 필요" });
    expect(deadlineInfo(p("2026-09-10"), new Date("invalid")).level).toBe("none");
  });

  it("마감 표시 문구", () => {
    expect(formatPostingDeadline(p("2026-11-20", "18:00"))).toBe("11월 20일 (금) 18:00 KST");
    expect(formatPostingDeadline(p("", "", "rolling"))).toBe("상시 채용");
    expect(isClosingSoon(p("2026-09-05"), TODAY)).toBe(true);
    expect(isClosingSoon(p("2026-08-30"), TODAY)).toBe(false);
  });
});

describe("JD 섹션", () => {
  it("필수·우대·업무를 구분하고 다른 제목은 필수 조건에 섞지 않는다", () => {
    const result = analyzeJobDescription("자격요건:\n- Python\n우대사항: Docker\n주요 업무\nAPI 구현\n복리후생\n식대 지원");
    expect(result.required).toEqual(["Python"]);
    expect(result.preferred).toEqual(["Docker"]);
    expect(result.duties).toEqual(["API 구현"]);
    expect(result.other).toEqual([]);
    expect(result.benefits).toEqual(["식대 지원"]);
    expect(result.keywords).toEqual(expect.arrayContaining(["Python", "Docker"]));
    expect(analyzeJobDescription("Python 개발\n협업 경험").required).toEqual([]);
  });

  it("복리후생·전형 절차·근무 조건·회사 소개·지원 방법 구역을 나눈다", () => {
    const result = analyzeJobDescription(
      [
        "[회사 소개]",
        "페이랩은 결제 인프라를 만듭니다.",
        "자격 요건",
        "- Python 3년 이상",
        "근무 조건",
        "연봉: 5,000만원 이상",
        "근무지: 서울 강남",
        "[복리후생]",
        "- 점심 식대",
        "전형 절차",
        "서류 → 1차 면접 → 최종 합격",
        "지원 방법",
        "이력서와 포트폴리오 제출",
        "기타 사항",
        "보훈 대상자 우대",
      ].join("\n"),
    );
    expect(result.company).toEqual(["페이랩은 결제 인프라를 만듭니다."]);
    expect(result.required).toEqual(["Python 3년 이상"]);
    expect(result.conditions).toEqual(["연봉: 5,000만원 이상", "근무지: 서울 강남"]);
    expect(result.benefits).toEqual(["점심 식대"]);
    expect(result.process).toEqual(["서류 → 1차 면접 → 최종 합격"]);
    expect(result.application).toEqual(["이력서와 포트폴리오 제출"]);
    expect(result.other).toEqual(["보훈 대상자 우대"]);
  });

  it("[대괄호] 제목과 영문 제목도 인식한다", () => {
    const result = analyzeJobDescription("[자격 요건]\n3년 이상 경력\n[우대 사항]\nAWS 경험\nResponsibilities\nBuild APIs");
    expect(result.required).toEqual(["3년 이상 경력"]);
    expect(result.preferred).toEqual(["AWS 경험"]);
    expect(result.duties).toEqual(["Build APIs"]);
  });
});

describe("목록 필터·정렬", () => {
  const base: JobPostingSummary = {
    id: "p",
    company: "제논",
    roleTitle: "Backend Engineer",
    url: "",
    urlKey: null,
    platform: "",
    sharedPostingId: null,
    status: "reviewing",
    deadline: "",
    deadlineTime: "",
    deadlineKind: "unspecified",
    employmentType: "unknown",
    workType: "unknown",
    location: "서울",
    careerLevel: "unknown",
    note: "Python · TDD",
    extractedBy: "manual",
    createdAt: 1,
    updatedAt: 1,
    hasJd: true,
  };
  const now = Date.parse("2026-09-10T00:00:00Z");
  const rows = [
    { ...base, id: "late", deadline: "2026-09-10", deadlineTime: "18:00", deadlineKind: "date" as const },
    { ...base, id: "early", deadline: "2026-09-10", deadlineTime: "10:00", deadlineKind: "date" as const },
    { ...base, id: "none", company: "누아" },
    { ...base, id: "past", deadline: "2026-09-01", deadlineKind: "date" as const },
    { ...base, id: "closed", status: "closed" as const },
  ];

  it("마감 임박순: 같은 날짜도 시각순, 마감 없음 다음에 지난 공고", () => {
    expect(filterPostings(rows, { ...EMPTY_POSTING_FILTERS, status: "all" }, "deadline", now).map((p) => p.id)).toEqual([
      "early",
      "late",
      "none",
      "closed",
      "past",
    ]);
  });

  it("기본(진행 중)은 마감·보류 상태를 빼고, 검색은 회사·메모까지 본다", () => {
    expect(filterPostings(rows, EMPTY_POSTING_FILTERS, "deadline", now).map((p) => p.id)).not.toContain("closed");
    expect(filterPostings(rows, { ...EMPTY_POSTING_FILTERS, query: "누아" }, "deadline", now).map((p) => p.id)).toEqual(["none"]);
    expect(filterPostings(rows, { ...EMPTY_POSTING_FILTERS, query: "tdd" }, "deadline", now)).toHaveLength(4);
  });

  it("마감 임박만: 이미 마감 시각이 지난 공고는 뺀다", () => {
    const after = Date.parse("2026-09-10T01:30:00Z"); // 10:30 KST
    expect(filterPostings(rows, { ...EMPTY_POSTING_FILTERS, onlyClosingSoon: true }, "deadline", after).map((p) => p.id)).toEqual(["late"]);
  });
});
