/**
 * 경어체 통일(honorific.ts): 검출 정밀도(오탐 목록), 결정적 변환, 문서 적용 범위, 프롬프트 규칙 포함.
 * worker/tests/fixtures/honorific.json(입력 → 출력)을 만들고 Python(worker/app/honorific.py)이 같은 결과인지 pytest가 본다.
 * 고치면 `UPDATE_WORKER_FIXTURES=1 npx vitest run src/lib/resumes/honorific.test.ts`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { emptyResumeDocument, EMPTY_RESUME_ITEM, type ResumeDocument } from "@/lib/domain/resumes";
import { detectPlainEndings, HONORIFIC_RULE, honorificLeftoverNote, normalizeDocumentHonorific, normalizeHonorific } from "./honorific";
import { RESUME_WRITING_CRITERIA_PROMPT } from "./writing-guide";

const CONVERT: [string, string][] = [
  ["결제 API 응답 시간을 40% 줄였다.", "결제 API 응답 시간을 40% 줄였습니다."],
  ["주문 시스템을 개선했다", "주문 시스템을 개선했습니다"],
  ["배포 파이프라인을 운영한다.", "배포 파이프라인을 운영합니다."],
  ["결제 도메인 3년 차 백엔드 개발자이다.", "결제 도메인 3년 차 백엔드 개발자입니다."],
  ["팀 리드였다.", "팀 리드였습니다."],
  ["장애가 0건이 됐다.", "장애가 0건이 됐습니다."],
  ["매주 배포된다.", "매주 배포됩니다."],
  ["운영 경험이 있다.", "운영 경험이 있습니다."],
  ["재발이 없다.", "재발이 없습니다."],
  ["3년간 운영했었다. 정산도 맡았다!", "3년간 운영했었습니다. 정산도 맡았습니다!"],
  ["설계를 하였다.", "설계를 하였습니다."],
  ["성과를 냈다.", "성과를 냈습니다."],
  ["모니터링을 이끌어 왔다.", "모니터링을 이끌어 왔습니다."],
  ["배치 시간을 줄인다.", "배치 시간을 줄입니다."],
  ["대시보드를 만든다.", "대시보드를 만듭니다."],
  ["로그를 읽는다.", "로그를 읽습니다."],
  ["확장이 가능하다.", "확장이 가능합니다."],
  ["트래픽이 많다.", "트래픽이 많습니다."],
  ["재시도하지 않는다.", "재시도하지 않습니다."],
  ["단순 반복이 아니다.", "단순 반복이 아닙니다."],
  ["개선할 것이다.", "개선할 것입니다."],
  ["첫 줄을 고쳤다.\n둘째 줄을 고쳤다", "첫 줄을 고쳤습니다.\n둘째 줄을 고쳤습니다"],
  ["끝에 공백이 있다 .", "끝에 공백이 있습니다 ."],
  ["[ADD: 기준값]에서 [ADD: 개선값]으로 줄였다.", "[ADD: 기준값]에서 [ADD: 개선값]으로 줄였습니다."],
];

/** 바뀌면 안 되는 줄(검출도 없어야 한다). */
const UNTOUCHED: string[] = [
  "API 응답 40% 개선",
  "결제 API를 설계했습니다.",
  "주문 시스템을 운영합니다.",
  "백엔드 개발자입니다.",
  "다양한 결제 수단 지원",
  "다수의 고객사 대응",
  "다국어 지원 다.",
  "푸른 바다.",
  "기존보다.",
  "매주마다.",
  "서버리스: AWS 람다",
  "결제 배치는 AWS 람다.",
  "분기 아젠다.",
  "캐나다.",
  "고객이 \"빠르다.\"고 평가",
  "“만족했다”는 피드백",
  "「가능하다.」",
  "[ADD: 성과를 냈다.]",
  "Reduced latency by 40%.",
  "It is done.",
  "개선했다고 들음",
  "개선했다, 그리고 배포",
  "(운영했다)",
  "개선했다)",
  "",
];

/** 평어체지만 판단할 수 없어 그대로 두는 줄(leftover). */
const LEFTOVER: [string, string[]][] = [
  ["결제 도메인 개발자다.", ["결제 도메인 개발자다"]],
  ["응답 개선율은 40%다.", ["응답 개선율은 40%다"]],
  ["주력 언어는 Kafka다.", ["주력 언어는 Kafka다"]],
  ["대시보드를 만들다.", ["대시보드를 만들다"]],
  ["핵심은 응답 속도 차이다.", ["핵심은 응답 속도 차이다"]],
  ["설계를 맡았다. 담당은 개발자다.", ["담당은 개발자다"]],
  [`${"가".repeat(70)} 개발자다.`, [`…${"가".repeat(54)} 개발자다`]],
];

describe("detectPlainEndings — 오탐 없음", () => {
  it.each(UNTOUCHED)("%j는 검출하지 않는다", (t) => {
    expect(detectPlainEndings(t)).toEqual([]);
    expect(normalizeHonorific(t)).toEqual({ text: t, leftovers: [], changed: 0 });
  });
});

describe("normalizeHonorific — 결정적 변환", () => {
  it.each(CONVERT)("%j → %j", (input, expected) => {
    const r = normalizeHonorific(input);
    expect(r.text).toBe(expected);
    expect(r.leftovers).toEqual([]);
    expect(r.changed).toBeGreaterThan(0);
    // 다시 돌려도 같다(멱등).
    expect(normalizeHonorific(r.text)).toEqual({ text: r.text, leftovers: [], changed: 0 });
  });
  it.each(LEFTOVER)("%j는 바꾸지 않고 leftovers로 남긴다", (input, leftovers) => {
    const r = normalizeHonorific(input);
    expect(r.leftovers).toEqual(leftovers);
    expect(r.text).toBe(input.replace("맡았다.", "맡았습니다."));
  });
});

function sampleDoc(): ResumeDocument {
  const d = emptyResumeDocument();
  d.basics.name = "김하다";
  d.basics.headline = "백엔드 개발자이다";
  d.basics.tagline = "결제 지연을 줄여 온 백엔드 개발자이다.";
  d.summary = "결제 시스템을 운영했다.\n정산 배치를 개선한다.";
  d.highlights = [{ title: "응답 시간 40% 단축", context: "2023년 / 캐시를 도입했다." }];
  d.experience = [{ ...EMPTY_RESUME_ITEM.experience(), company: "주식회사 했다", title: "리드였다", startDate: "2021.03", endDate: "현재", scope: "결제 API를 담당한다.", bullets: ["장애를 줄였다.", "담당은 개발자다."] }];
  d.projects = [{ ...EMPTY_RESUME_ITEM.project(), name: "정산 개편이다", role: "설계를 맡았다", summary: "정산을 다시 만들었다.", problem: "지연이 있었다.", action: "큐를 도입했다.", result: "지연이 사라졌다.", evidence: "대시보드였다.", bullets: ["테스트를 늘렸다."], techs: ["Kafka다."] }];
  d.skills = [{ category: "백엔드다", detail: "대용량 API를 설계할 수 있다.", items: ["Kotlin"] }];
  d.extras = [{ title: "수상이다", items: ["2022 해커톤에서 대상을 받았다."] }];
  d.education = [{ school: "한국대학교", degree: "학사", major: "컴퓨터공학", startDate: "", endDate: "", note: "졸업했다." }];
  d.motivation = "결제 안정성을 높여 왔다.";
  return d;
}

describe("normalizeDocumentHonorific", () => {
  it("서술 칸만 바꾸고 이름·직무명·회사·기술·학력은 그대로", () => {
    const before = sampleDoc();
    const snapshot = structuredClone(before);
    const { document: d, changed, leftovers } = normalizeDocumentHonorific(before);
    expect(before).toEqual(snapshot); // 입력은 바꾸지 않는다
    expect(d.basics.name).toBe("김하다");
    expect(d.basics.headline).toBe("백엔드 개발자이다");
    expect(d.basics.tagline).toBe("결제 지연을 줄여 온 백엔드 개발자입니다.");
    expect(d.summary).toBe("결제 시스템을 운영했습니다.\n정산 배치를 개선합니다.");
    expect(d.highlights[0]).toEqual({ title: "응답 시간 40% 단축", context: "2023년 / 캐시를 도입했습니다." });
    expect(d.experience[0]!.company).toBe("주식회사 했다");
    expect(d.experience[0]!.title).toBe("리드였다");
    expect(d.experience[0]!.scope).toBe("결제 API를 담당합니다.");
    expect(d.experience[0]!.bullets).toEqual(["장애를 줄였습니다.", "담당은 개발자다."]);
    expect(d.projects[0]!.name).toBe("정산 개편이다");
    expect(d.projects[0]!.role).toBe("설계를 맡았다");
    expect(d.projects[0]!.evidence).toBe("대시보드였다.");
    expect(d.projects[0]!.techs).toEqual(["Kafka다."]);
    expect([d.projects[0]!.summary, d.projects[0]!.problem, d.projects[0]!.action, d.projects[0]!.result, ...d.projects[0]!.bullets]).toEqual([
      "정산을 다시 만들었습니다.",
      "지연이 있었습니다.",
      "큐를 도입했습니다.",
      "지연이 사라졌습니다.",
      "테스트를 늘렸습니다.",
    ]);
    expect(d.skills[0]).toEqual({ category: "백엔드다", detail: "대용량 API를 설계할 수 있습니다.", items: ["Kotlin"] });
    expect(d.extras[0]).toEqual({ title: "수상이다", items: ["2022 해커톤에서 대상을 받았습니다."] });
    expect(d.education[0]!.note).toBe("졸업했다.");
    expect(d.motivation).toBe("결제 안정성을 높여 왔습니다.");
    expect(changed).toBe(14);
    expect(leftovers).toEqual([{ path: "experience[0].bullets[1]", text: "담당은 개발자다" }]);
    expect(honorificLeftoverNote(leftovers)).toBe("문장 끝을 '~습니다'로 자동으로 바꾸지 못한 문장 1개가 있습니다. 직접 확인해 주세요: '담당은 개발자다'");
    expect(honorificLeftoverNote([])).toBeNull();
  });
});

describe("프롬프트 규칙", () => {
  it("공용 작성 기준(단일 초안·에이전트·심사위원 채팅)에 경어체 규칙이 들어 있다", () => {
    expect(RESUME_WRITING_CRITERIA_PROMPT).toContain(HONORIFIC_RULE);
    expect(HONORIFIC_RULE).toContain("~했습니다");
    expect(HONORIFIC_RULE).toContain("(틀림)");
    expect(HONORIFIC_RULE).toContain("[ADD: …]");
  });
});

// ---------------------------------------------------------------------------
// Python 워커 계약
// ---------------------------------------------------------------------------

const ROOT = path.resolve(import.meta.dirname, "../../..");
const FIXTURE = path.join(ROOT, "worker/tests/fixtures/honorific.json");

describe("honorific.json(Python 워커 계약)", () => {
  it("지금 TS 결과와 같다", () => {
    const texts = [...CONVERT.map(([t]) => t), ...UNTOUCHED, ...LEFTOVER.map(([t]) => t), "😀 이모지 뒤에 개선했다.", "줄바꿈 뒤\r\n운영했다\r\n", `${"😀".repeat(31)}가 개발자다.`];
    const value = {
      rule: HONORIFIC_RULE,
      texts: texts.map((input) => ({ input, ...normalizeHonorific(input) })),
      document: { input: sampleDoc(), ...normalizeDocumentHonorific(sampleDoc()) },
    };
    const content = `${JSON.stringify(value, null, 2)}\n`;
    if (process.env.UPDATE_WORKER_FIXTURES === "1") {
      mkdirSync(path.dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, content);
    }
    let current = "";
    try {
      current = readFileSync(FIXTURE, "utf8");
    } catch {
      // 없으면 아래 비교에서 실패한다.
    }
    expect(current, "honorific.json이 오래됐습니다. UPDATE_WORKER_FIXTURES=1 npx vitest run src/lib/resumes/honorific.test.ts").toBe(content);
  });
});
