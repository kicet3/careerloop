/**
 * 구조화 공고(순수): LLM 구역 출력의 근거 검증, 정규식 대체 경로, jdText 조합(그래프 대조의 must/nice 제목 규칙과 맞물리는지).
 */
import { describe, expect, it } from "vitest";
import { emptyStructureContent, type PostingSectionsLlm } from "@/lib/domain/posting-structure";
import { requirementsFromJd } from "@/lib/graph/match";
import { stripBullet } from "./evidence";
import {
  composeJdText,
  groundStructure,
  isStructureStale,
  hasStructureContent,
  isThin,
  postingJdForPrompt,
  sourceHash,
  structureContentFromText,
  structureFromText,
  structureInputText,
} from "./structure";

const none: PostingSectionsLlm = {
  companyIndustry: "",
  companySize: "",
  companyIntro: [],
  summary: "",
  duties: [],
  requirements: [],
  preferred: [],
  techStack: [],
  salary: "",
  workHours: "",
  conditionsOther: [],
  benefits: [],
  process: [],
  documents: [],
  applyMethod: [],
  notes: [],
};

const PAGE = [
  "페이랩 백엔드 개발자 채용",
  "핀테크 · 직원 120명",
  "주요 업무",
  "• 결제 API 설계와 운영",
  "• 정산 배치 처리 시간 개선",
  "자격 요건",
  "- Python 3년 이상 백엔드 개발 경험",
  "- SQL 기반 데이터 모델링 경험",
  "우대 사항",
  "- Kubernetes 운영 경험",
  "- React 18 사용 경험",
  "근무 조건",
  "연봉: 6,000만원 ~ 8,000만원",
  "근무시간: 10:00 ~ 19:00",
  "복리후생",
  "점심 식대 지원",
  "전형 절차",
  "서류 전형 → 1차 면접 → 최종 합격",
].join("\n");

describe("groundStructure", () => {
  it("근거 없는 항목은 버리고, 공백만 다른 항목·글머리 붙은 항목은 인정한다", () => {
    const s = groundStructure(
      {
        ...none,
        duties: ["- 결제 API 설계와  운영", "결제API 설계와 운영합니다", "정산배치 처리시간 개선"],
        requirements: ["1. Python 3년 이상 백엔드 개발 경험.", "Go 5년 이상(지어냄)"],
      },
      PAGE,
    );
    expect(s.source).toBe("llm");
    expect(s.duties).toEqual(["결제 API 설계와 운영", "정산배치 처리시간 개선"]);
    expect(s.requirements).toEqual(["Python 3년 이상 백엔드 개발 경험"]);
  });

  it("제목 같은 줄은 버리고, 자격·우대에 같은 항목이 있으면 자격에 남긴다", () => {
    const s = groundStructure(
      {
        ...none,
        requirements: ["자격 요건", "SQL 기반 데이터 모델링 경험", "우대 사항:"],
        preferred: ["SQL 기반 데이터 모델링 경험", "Kubernetes 운영 경험"],
      },
      PAGE,
    );
    expect(s.requirements).toEqual(["SQL 기반 데이터 모델링 경험"]);
    expect(s.preferred).toEqual(["Kubernetes 운영 경험"]);
  });

  it("개수·길이 상한을 넘는 부분은 자른다", () => {
    const lines = Array.from({ length: 40 }, (_, i) => `업무 항목 ${i}번 ${"가".repeat(400)}`);
    const s = groundStructure({ ...none, duties: lines }, lines.join("\n"));
    expect(s.duties).toHaveLength(25);
    expect(s.duties[0]!.length).toBeLessThanOrEqual(300);
  });

  it("요약에 본문에 없는 숫자가 있으면 비운다", () => {
    expect(groundStructure({ ...none, summary: "Python 3년 이상 백엔드 개발자를 찾습니다." }, PAGE).summary).toContain("Python");
    expect(groundStructure({ ...none, summary: "연봉 1억 9999만원 백엔드 포지션" }, PAGE).summary).toBe("");
  });

  it("짧은 값은 근거가 있어야 남는다", () => {
    const rich = { duties: ["결제 API 설계와 운영"], requirements: ["SQL 기반 데이터 모델링 경험"], preferred: ["Kubernetes 운영 경험"] };
    const s = groundStructure({ ...none, ...rich, salary: "6,000만원 ~ 8,000만원", workHours: "주 4일 근무", companyIndustry: "핀테크" }, PAGE);
    expect(s.conditions.salary).toBe("6,000만원 ~ 8,000만원");
    expect(s.conditions.workHours).toBe("");
    expect(s.company.industry).toBe("핀테크");
  });

  it("기술 스택: 정식 명칭으로 바꾸고, 근거 없는 이름은 버리고, 업무·자격 문장의 키워드와 합친다", () => {
    const s = groundStructure(
      {
        ...none,
        requirements: ["Python 3년 이상 백엔드 개발 경험"],
        preferred: ["Kubernetes 운영 경험"],
        duties: ["결제 API 설계와 운영"],
        techStack: ["react 18", "Rust", "python"],
      },
      PAGE,
    );
    expect(s.techStack).toContain("React");
    expect(s.techStack).toContain("Python");
    expect(s.techStack).toContain("Kubernetes");
    expect(s.techStack).not.toContain("Rust");
    expect(s.techStack.filter((t) => t === "Python")).toHaveLength(1);
  });

  it("결과가 얇으면 정규식 결과로 빈 구역을 채운다(source는 llm 유지)", () => {
    const s = groundStructure({ ...none, duties: ["결제 API 설계와 운영"] }, PAGE);
    expect(isThin({ ...emptyStructureContent(), duties: ["결제 API 설계와 운영"] })).toBe(true);
    expect(s.source).toBe("llm");
    expect(s.duties).toEqual(["결제 API 설계와 운영"]);
    expect(s.requirements).toEqual(["Python 3년 이상 백엔드 개발 경험", "SQL 기반 데이터 모델링 경험"]);
    expect(s.preferred).toEqual(["Kubernetes 운영 경험", "React 18 사용 경험"]);
    expect(s.benefits).toEqual(["점심 식대 지원"]);
    expect(s.conditions.salary).toBe("6,000만원 ~ 8,000만원");
  });
});

describe("structureFromText(정규식)", () => {
  it("복리후생·전형 절차·근무 조건·지원 방법 제목을 구분한다", () => {
    const s = structureFromText(
      `${PAGE}\n지원 방법\n이력서와 포트폴리오 제출\n채용 홈페이지에서 지원\n회사 소개\n결제 인프라를 만드는 회사입니다.`,
      1,
    );
    expect(s).toMatchObject({ source: "regex", jdComposed: false, extractedAt: 1, summary: "" });
    expect(s.conditions).toEqual({ salary: "6,000만원 ~ 8,000만원", workHours: "10:00 ~ 19:00", other: [] });
    expect(s.benefits).toEqual(["점심 식대 지원"]);
    expect(s.process).toEqual(["서류 전형 → 1차 면접 → 최종 합격"]);
    expect(s.application).toEqual({ documents: ["이력서와 포트폴리오 제출"], method: ["채용 홈페이지에서 지원"] });
    expect(s.company.intro).toEqual(["결제 인프라를 만드는 회사입니다."]);
    expect(s.techStack).toEqual(expect.arrayContaining(["Python", "SQL", "Kubernetes", "React"]));
  });

  it("구역 제목이 하나도 없으면 빈 구조(본문을 '기타' 한 칸에 잘라 넣지 않는다)", () => {
    const text = Array.from({ length: 30 }, (_, i) => `${i + 1}번째 줄: Python과 SQL로 결제 API를 만듭니다`).join("\n");
    const s = structureFromText(text);
    expect(s.notes).toEqual([]);
    expect(s.techStack).toEqual([]);
    expect(hasStructureContent(s)).toBe(false);
  });

  it("'기술 스택' 구역의 이름을 기술로 읽고 앞 구역에 섞지 않는다", () => {
    const s = structureFromText("우대 사항\n- Kubernetes 운영 경험\n기술 스택\nPython, Kafka\nGo");
    expect(s.preferred).toEqual(["Kubernetes 운영 경험"]);
    expect(s.techStack).toEqual(expect.arrayContaining(["Kubernetes", "Python", "Kafka", "Go"]));
  });
});

describe("composeJdText", () => {
  const s = groundStructure(
    {
      ...none,
      summary: "결제 백엔드 개발자",
      duties: ["결제 API 설계와 운영"],
      requirements: ["Python 3년 이상 백엔드 개발 경험", "SQL 기반 데이터 모델링 경험"],
      preferred: ["Kubernetes 운영 경험"],
      salary: "6,000만원 ~ 8,000만원",
      benefits: ["점심 식대 지원"],
      process: ["서류 전형 → 1차 면접 → 최종 합격"],
    },
    PAGE,
  );

  it("구역 순서와 제목", () => {
    const text = composeJdText(s);
    const order = ["[포지션 개요]", "주요 업무", "자격 요건", "우대 사항", "기술 스택:", "근무 조건", "복리후생", "채용 절차"].map((h) => text.indexOf(h));
    expect(order.every((i) => i >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(text).toContain("자격 요건\n- Python 3년 이상 백엔드 개발 경험");
    expect(text).toContain("근무 조건\n- 연봉: 6,000만원 ~ 8,000만원");
    expect(text).toContain("채용 절차\n1. 서류 전형");
  });

  it("그래프 대조: 자격 항목의 키워드는 must, 우대 항목의 키워드는 nice", () => {
    const { requirements } = requirementsFromJd(null, composeJdText(s));
    const by = Object.fromEntries(requirements.map((r) => [r.name, r.importance]));
    expect(by.Python).toBe("must");
    expect(by.SQL).toBe("must");
    expect(by.Kubernetes).toBe("nice");
  });

  it("다시 제목 기준으로 나누어도 구역이 유지된다(조합 텍스트 왕복)", () => {
    const full = {
      ...s,
      techStack: ["Python", "SQL", "Kubernetes"],
      conditions: { salary: "6,000만원 ~ 8,000만원", workHours: "10:00 ~ 19:00", other: [] },
      application: { documents: ["이력서"], method: ["채용 홈페이지에서 지원"] },
      company: { industry: "", size: "", intro: ["결제 인프라를 만드는 회사입니다."] },
    };
    const back = structureContentFromText(composeJdText(full));
    expect(back.duties).toEqual(full.duties);
    expect(back.requirements).toEqual(full.requirements);
    expect(back.preferred).toEqual(full.preferred);
    expect(back.benefits).toEqual(full.benefits);
    expect(back.process).toEqual(full.process);
    expect(back.conditions).toEqual(full.conditions);
    expect(back.application).toEqual(full.application);
    expect(back.company.intro).toEqual(full.company.intro);
    expect(back.techStack).toEqual(expect.arrayContaining(full.techStack));
  });

  it("30,000자에서 자른다", () => {
    const big = { ...emptyStructureContent(), notes: Array.from({ length: 15 }, () => "가".repeat(300)), duties: Array.from({ length: 25 }, () => "나".repeat(300)), requirements: Array.from({ length: 25 }, () => "다".repeat(300)), preferred: Array.from({ length: 25 }, () => "라".repeat(300)), benefits: Array.from({ length: 25 }, () => "마".repeat(300)) };
    expect(composeJdText(big).length).toBeLessThanOrEqual(30_000);
    expect(composeJdText(big).length).toBeGreaterThan(29_000);
  });
});

describe("원문 변경·프롬프트용 JD", () => {
  it("구조를 만든 원문이 바뀌면 stale, 정규식 구조는 해당 없음", () => {
    const llm = { ...groundStructure({ ...none }, "원문 A"), jdComposed: false };
    expect(isStructureStale({ jdText: "원문 A", sourceText: "", structured: llm })).toBe(false);
    expect(isStructureStale({ jdText: "원문 B", sourceText: "", structured: llm })).toBe(true);
    expect(isStructureStale({ jdText: "원문 B", sourceText: "", structured: structureFromText("원문 A") })).toBe(false);
    expect(sourceHash("a  b\nc")).toBe(sourceHash("a b c"));
  });

  it("jdText가 조합된 상태면 다시 정리할 입력은 원문(sourceText)", () => {
    const composed = { ...groundStructure({ ...none }, "원문"), jdComposed: true };
    expect(structureInputText({ jdText: "조합", sourceText: "원문", structured: composed })).toBe("원문");
    expect(structureInputText({ jdText: "고친 JD", sourceText: "원문", structured: { ...composed, jdComposed: false } })).toBe("고친 JD");
  });

  it("postingJdForPrompt: 충분한 AI 구조면 구역 텍스트, 정규식·얇은 구조면 jdText", () => {
    const rich = groundStructure({ ...none, duties: ["결제 API 설계와 운영"], requirements: ["SQL 기반 데이터 모델링 경험"], preferred: ["Kubernetes 운영 경험"] }, PAGE);
    expect(postingJdForPrompt({ jdText: PAGE, structured: rich })).toBe(composeJdText(rich));
    expect(postingJdForPrompt({ jdText: PAGE, structured: structureFromText(PAGE) })).toBe(PAGE);
    expect(postingJdForPrompt({ jdText: PAGE, structured: null })).toBe(PAGE);
  });

  it("postingJdForPrompt: 구조를 만든 뒤 jdText를 고쳤으면(jdComposed=false, 해시 불일치) 고친 jdText", () => {
    const rich = groundStructure({ ...none, duties: ["결제 API 설계와 운영"], requirements: ["SQL 기반 데이터 모델링 경험"], preferred: ["Kubernetes 운영 경험"] }, PAGE);
    const edited = `${PAGE}\n- Go 언어 사용 경험`;
    expect(postingJdForPrompt({ jdText: edited, structured: rich })).toBe(edited);
    // URL 가져오기(조합)였다가 jdText를 고쳐 jdComposed=false가 된 경우도 같다.
    expect(postingJdForPrompt({ jdText: edited, structured: { ...rich, jdComposed: false } })).toBe(edited);
  });

  it("stripBullet: 글머리·번호·끝 문장부호", () => {
    expect(stripBullet("① 서류 전형.")).toBe("서류 전형.");
    expect(stripBullet("- • Python")).toBe("Python");
    expect(stripBullet("2) 면접")).toBe("면접");
  });
});
