import { describe, expect, it, vi } from "vitest";
import { emptyResumeDocument } from "@/lib/domain/resumes";
import { AGENT_SYSTEM } from "@/lib/resume-agent/prompts";
import { RESUME_FACT_RULES } from "./draft-rules";
import {
  classifyExtra,
  EXTRAS_GUIDE_PROMPT_LINES,
  EXTRAS_MERGED_TITLE,
  extrasMissingQuestions,
  extrasPathMapper,
  isTrivialExtra,
  normalizeExtras,
  sortNewestFirst,
} from "./extras-guide";

vi.mock("server-only", () => ({}));
const { buildResumeDraftPrompt } = await import("./draft");

describe("수상·기타 작성 기준(프롬프트)", () => {
  it("단일 초안과 에이전트 프롬프트가 같은 기준(규칙 9)을 쓴다", () => {
    const { system } = buildResumeDraftPrompt({ company: "c", roleTitle: "r", jdText: "", templateId: "classic", material: { kind: "graph", text: "g" } });
    for (const line of EXTRAS_GUIDE_PROMPT_LINES) {
      expect(RESUME_FACT_RULES).toContain(line);
      expect(system).toContain(line);
      expect(AGENT_SYSTEM).toContain(line);
    }
  });

  it("카테고리별 한 줄 형식·뺄 것·경력자/신입 순서·묶음 규칙·missingInfo 질문을 담는다", () => {
    const text = EXTRAS_GUIDE_PROMPT_LINES.join("\n");
    expect(text).toContain("YYYY.MM 대회명 – 상 이름 (주최)");
    expect(text).toContain("시험명 점수 (YYYY.MM)");
    expect(text).toContain("병역: 육군 병장 만기전역");
    expect(text).toContain("단순 참석");
    expect(text).toContain("경력자 = 발표 > 기고·블로그 > 오픈소스 > 수상");
    expect(text).toContain("신입 = 교육 > 수상 > 대외활동");
    expect(text).toContain(`'${EXTRAS_MERGED_TITLE}' 한 묶음`);
    expect(text).toContain("missingInfo");
    expect(text).toContain("지어내지 말고");
  });

  it("단일 초안 프롬프트의 섹션 순서에는 지원 동기가 없다(사용자가 쓰는 칸)", () => {
    const { user } = buildResumeDraftPrompt({ company: "c", roleTitle: "r", jdText: "", templateId: "classic", material: { kind: "graph", text: "g" } });
    expect(user).toContain("자격·어학 → 기타)");
    expect(user).not.toContain("지원 동기");
  });
});

describe("결정적 판정", () => {
  it("사소한 일화·소감·신상·단순 참석은 trivial, 수상·발표·병역은 아니다", () => {
    for (const t of ["사내 툴을 1일 만에 만듦", "프로젝트를 하며 많이 배웠다", "기술 컨퍼런스 참석", "취미로 게임 랭크 다이아"]) expect(isTrivialExtra(t)).toBe(true);
    for (const t of ["2023.05 해커톤 – 대상 (주최: 카카오)", "if(kakao) 2024 – 「정산 배치 이야기」 발표", "병역: 육군 병장 만기전역 (2015.03 ~ 2016.12)", "컨퍼런스 참석 후 사내 발표", "2023.08 OO 해커톤 – 대상 (48시간 만에 MVP 구현)", "2024.03 DEVIEW 발표 – 많이 배웠다", "react-query PR #1234 머지 (2일 만에 리뷰 반영)"]) {
      expect(isTrivialExtra(t)).toBe(false);
    }
  });

  it("묶음 제목·항목으로 카테고리를 고른다", () => {
    expect(classifyExtra("수상")).toBe("award");
    expect(classifyExtra("", ["TOEIC 900 (2024.01)"])).toBe("language");
    expect(classifyExtra("기타", ["병역: 공군 병장 만기전역"])).toBe("military");
    // 개발 용어의 '전역(global)'·'면제'·일반 '기여'는 병역·오픈소스가 아니다.
    expect(classifyExtra("기타", ["전역 상태 관리(Redux) 리팩터링"])).not.toBe("military");
    expect(classifyExtra("기타", ["수수료 면제 기능 개발"])).not.toBe("military");
    expect(classifyExtra("기타", ["팀 성과에 기여"])).not.toBe("opensource");
    expect(classifyExtra("기타", ["react-query PR #1234 머지"])).toBe("opensource");
    expect(classifyExtra("기타", ["병역: 군필"])).toBe("military");
    expect(classifyExtra("기타", ["사내 체육대회"])).toBeNull();
  });

  it("최신순(기간은 끝 기준, 날짜 없는 줄은 뒤에)", () => {
    expect(sortNewestFirst(["2021.03 A", "날짜 없음", "2023.11 B", "2022.01 ~ 현재 C"])).toEqual(["2022.01 ~ 현재 C", "2023.11 B", "2021.03 A", "날짜 없음"]);
  });

  it("빈 묶음 생략, 2개 이하면 '수상·기타' 하나로 합친다", () => {
    const r = normalizeExtras(
      [
        { title: "수상", items: ["2021.05 공모전 – 우수상", " "] },
        { title: "빈 묶음", items: [] },
        { title: "어학", items: ["TOEIC 900 (2024.01)", "툴을 1일 만에 만듦"] },
      ],
      { newcomer: false },
    );
    expect(r.extras).toEqual([{ title: EXTRAS_MERGED_TITLE, items: ["TOEIC 900 (2024.01)", "2021.05 공모전 – 우수상"] }]);
    expect(r.dropped).toEqual(["툴을 1일 만에 만듦"]);
    expect(normalizeExtras([{ title: "x", items: ["", " "] }], { newcomer: false }).extras).toEqual([]);
  });

  it("3개 이상이면 묶음 순서를 경력자/신입 기준으로", () => {
    const extras = [
      { title: "수상", items: ["2022.05 해커톤 – 대상"] },
      { title: "교육", items: ["2020.01 ~ 2020.06 백엔드 부트캠프 (기관) 수료"] },
      { title: "발표", items: ["행사 2024 – 「제목」"] },
    ];
    expect(normalizeExtras(extras, { newcomer: false }).extras.map((g) => g.title)).toEqual(["발표", "수상", "교육"]);
    expect(normalizeExtras(extras, { newcomer: true }).extras.map((g) => g.title)).toEqual(["교육", "수상", "발표"]);
  });

  it("흔한 기타 정보(수상·어학, 신입이면 교육·병역)가 없으면 질문 하나 — 있으면 묻지 않는다", () => {
    const doc = emptyResumeDocument();
    const q = extrasMissingQuestions(doc);
    expect(q).toHaveLength(1);
    expect(q[0]).toContain("수상·어학·교육·병역");
    doc.experience = [{ company: "페이랩", department: "", title: "개발자", startDate: "", endDate: "", location: "", scope: "", bullets: [] }];
    expect(extrasMissingQuestions(doc)[0]).toContain("수상·어학 정보");
    doc.extras = [{ title: "수상", items: ["2022 해커톤 대상"] }];
    doc.certifications = [{ name: "TOEIC 900", issuer: "ETS", date: "2024.01" }];
    expect(extrasMissingQuestions(doc)).toEqual([]);
  });

  it("개발 용어 '전역 상태'가 있어도 신입에게 병역을 묻는다", () => {
    const doc = emptyResumeDocument();
    doc.extras = [{ title: "기타", items: ["전역 상태 관리(Redux) 스터디 발표"] }];
    expect(extrasMissingQuestions(doc)[0]).toContain("병역");
  });

  it("정리 전후 경로 대응: 합치기·순서 바꾸기 뒤에도 같은 줄을 가리키고, 뺀 줄은 null", () => {
    const before = [
      { title: "교육", items: ["2020.01 백엔드 부트캠프 수료"] },
      { title: "수상", items: ["사내 툴을 1일 만에 만듦", "2022.05 해커톤 – 대상"] },
      { title: "발표", items: ["행사 2024 – 「제목」"] },
    ];
    const after = normalizeExtras(before, { newcomer: false }).extras;
    const map = extrasPathMapper(before, after);
    const at = (p: string | null) => {
      const m = /^extras\[(\d+)\]\.items\[(\d+)\]$/.exec(p ?? "");
      return m ? after[Number(m[1])]!.items[Number(m[2])] : null;
    };
    expect(at(map("extras[1].items[1]"))).toBe("2022.05 해커톤 – 대상");
    expect(at(map("extras[0].items[0]"))).toBe("2020.01 백엔드 부트캠프 수료");
    expect(map("extras[1].items[0]")).toBeNull();
    expect(map("summary")).toBe("summary");
    expect(map("extras[2]")).toBe(`extras[${after.findIndex((g) => g.title === "발표")}]`);
  });
});
