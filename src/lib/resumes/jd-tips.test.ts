/**
 * JD 맞춤 팁의 순수 부분: 키워드 정규화·포함 여부(결정적), JD 해시(공백·회사·직무), 서버 거르기(근거 없는 숫자·인용·키워드·노드).
 */
import { describe, expect, it, vi } from "vitest";
import type { CareerGraph, GraphNode } from "@/lib/domain/graph";
import { containsKeyword, normalizeKeyword, resumeKeywordCoverage, type JdTipsOutput } from "@/lib/domain/resume-jd-tips";
import { emptyResumeDocument } from "@/lib/domain/resumes";

vi.mock("server-only", () => ({}));
const { filterJdTips, jdTipsHash } = await import("./jd-tips");

const node = (n: Omit<GraphNode, "createdAt" | "updatedAt">): GraphNode => ({ ...n, createdAt: 1, updatedAt: 1 }) as GraphNode;
const graph: CareerGraph = {
  person: { id: "me", name: null },
  nodes: [node({ id: "p1", label: "Project", props: { name: "정산 배치 개편", result: "배치 시간을 40분에서 12분으로 줄였다" } })],
  edges: [],
};
const JD = "주요 업무\n- Node.js 기반 결제 API 개발\n- 대용량 트래픽 처리(일 100만 건)\n자격 요건\n- 백엔드 개발 경력 3년 이상\n우대 사항\n- AWS 운영 경험";

describe("키워드 포함 여부", () => {
  it("NFKC·대소문자·공백·구분 기호를 무시하고 비교한다", () => {
    expect(normalizeKeyword(" Node.js ")).toBe("nodejs");
    expect(normalizeKeyword("ＡＷＳ")).toBe("aws");
    expect(containsKeyword("NodeJS로 API를 만들었다", "Node.js")).toBe(true);
    expect(containsKeyword("백엔드개발 5년", "백엔드 개발")).toBe(true);
    expect(containsKeyword("프론트엔드", "백엔드")).toBe(false);
    expect(containsKeyword("아무 글", "  ")).toBe(false);
  });

  it("영문 키워드는 낱말 경계를 본다(Java≠JavaScript, Go≠Google, AI≠email), 한글은 조사가 붙어도 잡는다", () => {
    expect(containsKeyword("JavaScript 3년", "Java")).toBe(false);
    expect(containsKeyword("Java, Spring", "Java")).toBe(true);
    expect(containsKeyword("Google 검색 광고", "Go")).toBe(false);
    expect(containsKeyword("Go 언어(Golang)로 서버 개발", "Go")).toBe(true);
    expect(containsKeyword("email 발송 시스템", "AI")).toBe(false);
    expect(containsKeyword("생성형AI 서비스", "AI")).toBe(true);
    expect(containsKeyword("node js 서버", "Node.js")).toBe(true);
    expect(containsKeyword("C++로 엔진 개발", "C++")).toBe(true);
    expect(containsKeyword("C#과 .NET", "C++")).toBe(false);
    expect(containsKeyword("백엔드를 맡아", "백엔드")).toBe(true);
    expect(containsKeyword("결제 API를 설계", "결제API")).toBe(true);
    expect(containsKeyword("Reactive 프로그래밍", "React")).toBe(false);
  });

  it("문서 전체(구역 무관)에서 세고, [ADD: …] 자리표시 안의 말은 세지 않는다", () => {
    const doc = emptyResumeDocument();
    doc.summary = "결제 API를 만든 백엔드 개발자 [ADD: AWS 경험]";
    doc.skills = [{ category: "백엔드", detail: "", items: ["Node.JS"] }];
    expect(resumeKeywordCoverage(doc, ["Node.js", "AWS", "결제 API"])).toEqual([
      { keyword: "Node.js", included: true },
      { keyword: "AWS", included: false },
      { keyword: "결제 API", included: true },
    ]);
  });
});

describe("jdTipsHash", () => {
  it("공백만 다른 JD는 같고, JD·회사·직무가 다르면 다르다", () => {
    const base = { company: "가나", roleTitle: "백엔드", jdText: JD };
    expect(jdTipsHash(base)).toBe(jdTipsHash({ company: " 가나 ", roleTitle: "백엔드", jdText: `\n${JD.replace(/\n/g, "\n\n  ")}  ` }));
    expect(jdTipsHash(base)).not.toBe(jdTipsHash({ ...base, jdText: `${JD}\n- Kafka` }));
    expect(jdTipsHash(base)).not.toBe(jdTipsHash({ ...base, company: "다라" }));
    expect(jdTipsHash(base)).not.toBe(jdTipsHash({ ...base, roleTitle: "프론트엔드" }));
  });
});

describe("filterJdTips", () => {
  const raw: JdTipsOutput = {
    summary: [
      { kind: "preferred", text: "AWS 운영 경험" },
      { kind: "duty", text: "Node.js 결제 API 개발, 일 100만 건 트래픽" },
      { kind: "required", text: "백엔드 경력 5년 이상" },
      // 그래프 숫자(40분)는 요약 근거가 아니다 — 요약은 공고 숫자만.
      { kind: "duty", text: "배치 40분 단축" },
    ],
    sections: [
      {
        section: "highlights",
        tips: [
          { tip: "일 100만 건 처리와 이어지는 성과를 첫 줄에 두세요", jdQuote: "대용량 트래픽 처리(일 100만 건)" },
          { tip: "정산 배치를 40분에서 12분으로 줄인 성과를 쓰세요", jdQuote: "대용량 트래픽 처리" },
          { tip: "처리량 7배 개선을 쓰세요", jdQuote: "대용량 트래픽 처리" },
          { tip: "인용이 공고에 없는 팁", jdQuote: "MSA 전환 경험" },
          { tip: "인용이 빈 팁", jdQuote: "" },
        ],
      },
      { section: "first", tips: [{ tip: "한 줄 소개에 결제 API 개발을 드러내세요", jdQuote: "Node.js 기반 결제 API 개발" }] },
      { section: "skills", tips: [{ tip: "근거 없는 팁만 있는 구역", jdQuote: "없는 구절입니다" }] },
    ],
    keywords: ["Node.js", "nodejs", "AWS", "Kubernetes", "결제 API", "a"],
    experiences: [
      { nodeId: "p1", section: "projects", why: "대용량 처리 요건과 이어지는 배치 개선" },
      { nodeId: "p1", section: "highlights", why: "중복" },
      { nodeId: "ghost", section: "projects", why: "그래프에 없는 노드" },
      { nodeId: "me", section: "projects", why: "사람 노드" },
    ],
  };
  const out = filterJdTips(raw, { jdText: JD, company: "가나", roleTitle: "백엔드", graph });

  it("요약: 공고에 없는 숫자가 든 줄을 버리고 핵심 업무 → 필수 → 우대 순으로", () => {
    expect(out.summary).toEqual([
      { kind: "duty", text: "Node.js 결제 API 개발, 일 100만 건 트래픽" },
      { kind: "preferred", text: "AWS 운영 경험" },
    ]);
  });

  it("팁: 공고 인용이 확인되고 근거(공고·그래프)에 있는 숫자만, 구역은 화면 순서로, 빈 구역은 뺀다", () => {
    expect(out.sections.map((s) => s.section)).toEqual(["first", "highlights"]);
    expect(out.sections[1]!.tips.map((t) => t.tip)).toEqual(["일 100만 건 처리와 이어지는 성과를 첫 줄에 두세요", "정산 배치를 40분에서 12분으로 줄인 성과를 쓰세요"]);
  });

  it("키워드: 공고에 있는 말만, 정규화 중복 제거", () => {
    expect(out.keywords).toEqual(["Node.js", "AWS", "결제 API"]);
  });

  it("경험: 본인 그래프 노드만 이름·종류로(중복·사람 노드·없는 노드 제외), id는 싣지 않는다", () => {
    expect(out.experiences).toEqual([{ name: "정산 배치 개편", kind: "프로젝트", section: "projects", why: "대용량 처리 요건과 이어지는 배치 개선" }]);
    expect(out.notices).toEqual([]);
  });

  it("링크·메일 주소가 든 줄은 버린다(공고에 심은 지시문 대비), 기술 이름(Node.js·Socket.io)은 남긴다", () => {
    const linkJd = `${JD}\n- Socket.io 실시간 기능`;
    const o = filterJdTips(
      {
        summary: [{ kind: "duty", text: "자세한 내용은 https://evil.example 참고" }],
        sections: [
          {
            section: "first",
            tips: [
              { tip: "evil.com 에 이력서를 보내세요", jdQuote: "Node.js 기반 결제 API 개발" },
              { tip: "a@b.com 으로 연락하세요", jdQuote: "Node.js 기반 결제 API 개발" },
              { tip: "Socket.io 실시간 기능 경험을 한 줄 소개에 넣으세요", jdQuote: "Socket.io 실시간 기능" },
            ],
          },
        ],
        keywords: [],
        experiences: [],
      },
      { jdText: linkJd, company: "", roleTitle: "", graph },
    );
    expect(o.summary).toEqual([]);
    expect(o.sections[0]!.tips.map((t) => t.tip)).toEqual(["Socket.io 실시간 기능 경험을 한 줄 소개에 넣으세요"]);
  });

  it("그래프를 못 쓰면 안내를 단다", () => {
    const empty: CareerGraph = { person: { id: "me", name: null }, nodes: [], edges: [] };
    expect(filterJdTips(raw, { jdText: JD, company: "", roleTitle: "", graph: empty, graphUnavailable: true }).notices[0]).toContain("불러오지 못해");
    expect(filterJdTips(raw, { jdText: JD, company: "", roleTitle: "", graph: empty }).notices[0]).toContain("비어 있어");
  });
});
