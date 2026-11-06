/** 병역특례 판정(순수): 긍정·부정·변형 표현, 복무 구분(보충역·현역), 공개 필드만 읽기. */
import { describe, expect, it } from "vitest";
import { militaryServiceLabels } from "@/lib/domain/military-service";
import { structureFromText } from "./structure";
import { detectMilitaryService, detectPostingMilitaryService } from "./military-service";

const d = detectMilitaryService;

describe("긍정", () => {
  it.each([
    ["전문연구요원 가능", ["expert"]],
    ["전문연 가능", ["expert"]],
    ["전문연구요원 편입 가능", ["expert"]],
    ["전문연구요원 전직 가능", ["expert"]],
    ["- 병역특례: 전문연구요원", ["expert"]],
    ["산업기능요원 가능", ["industrial"]],
    ["산기요 TO 있음", ["industrial"]],
    ["병역지정업체(산업기능요원) 지원 가능", ["industrial"]],
    ["산업기능요원(보충역) 가능", ["industrial", "industrial_supplementary"]],
    ["산업기능요원 보충역 편입 가능, 현역 불가", ["industrial", "industrial_supplementary"]],
    ["산업기능요원 현역/보충역 모두 가능", ["industrial", "industrial_supplementary", "industrial_active"]],
    ["전문연구요원·산업기능요원 지원 가능", ["expert", "industrial"]],
    ["전문연구요원, 산업기능요원 모두 가능", ["expert", "industrial"]],
    ["전문연구요원이나 산업기능요원 지원 가능", ["expert", "industrial"]],
    ["병역특례 가능", ["general"]],
    ["병특 가능", ["general"]],
    ["병역특례(보충역) 가능", ["industrial", "industrial_supplementary"]],
    ["병역특례 : O", ["general"]],
    ["산업기능요원 가능 (경력 제한 없음)", ["industrial"]],
    ["전문연구요원 가능하나 산업기능요원 불가", ["expert"]],
    ["전문연구요원 가능, 산업기능요원 불가", ["expert"]],
    ["전문연구요원 가능 (산업기능요원 등 기타 병역특례 불가)", ["expert"]],
    ["전문연구요원뿐 아니라 산업기능요원도 가능합니다", ["expert", "industrial"]],
    ["산업기능요원 신규 편입 불가, 전직만 가능", ["industrial"]],
    ["전문연구요원 편입 불가하나 전직 가능", ["expert"]],
    ["산업기능요원 편입 가능 (현역 군필자 우대)", ["industrial"]],
    ["산업기능요원 가능, 현역 군필자 우대", ["industrial"]],
    ["산업기능요원 가능, 보충역 전역자 우대", ["industrial"]],
    ["산업기능요원 현역 편입 가능", ["industrial", "industrial_active"]],
  ])("%s", (text, tags) => {
    expect(d(text)).toEqual(tags);
  });
});

describe("부정·해당 없음", () => {
  it.each([
    "병역특례 불가",
    "병역특례 불가능",
    "전문연구요원 지원 불가",
    "병역특례 해당 없음",
    "병역특례 업체 아님",
    "병역특례 미해당",
    "전문연구요원, 산업기능요원 모두 불가",
    "전문연구요원/산업기능요원 지원 불가합니다",
    "병역특례 : X",
    "병역특례 가능 여부: 불가",
    "산업기능요원 가능 여부는 면접 시 문의",
    "남성의 경우 군필 또는 면제자",
    "병역: 군필 또는 면제자 (병역특례 대상자 제외)",
    "산업기능요원 복무 완료자",
    "현역 개발자와 함께 일합니다",
    "보충역 우대",
    "전직 가능한 분",
    "병역특례 비해당",
    "병역특례 미적용",
    "병역특례: 무",
    "병역특례 대상 기업이 아닌 점 참고 바랍니다",
    "전문연구요원 편입 안 함",
    "전문연구요원 TO 소진",
    "전문연구요원 TO 마감",
    "현재 병역특례 업체 지정 신청 중",
    "병역특례 지정 진행 중",
    "현역 군필자 우대",
    "",
  ])("%s", (text) => {
    expect(d(text)).toEqual([]);
  });
});

describe("여러 줄", () => {
  it("한 줄이라도 긍정이면 그 종류를 태그하고, 다른 줄의 일반 부정은 무시한다", () => {
    const text = ["자격 요건", "- 군필 또는 면제자", "- 병역특례 불가(전문연구요원 제외)", "기타", "- 전문연구요원 편입 가능"].join("\n");
    expect(d(text)).toEqual(["expert"]);
  });

  it("보충역·현역은 산업기능요원·병역특례 언급이 있는 문장에서만 붙인다", () => {
    expect(d("산업기능요원 가능\n보충역 우대")).toEqual(["industrial"]);
    expect(d("산업기능요원 가능\n산업기능요원 보충역 TO 1명")).toEqual(["industrial", "industrial_supplementary"]);
  });
});

describe("공개 필드", () => {
  it("직무명·JD·구역을 읽는다", () => {
    expect(detectPostingMilitaryService({ roleTitle: "백엔드 개발자 (전문연구요원 가능)" })).toEqual(["expert"]);
    const s = structureFromText("주요 업무\n- API 개발\n기타\n- 산업기능요원(보충역) 편입 가능");
    expect(detectPostingMilitaryService({ roleTitle: "개발자", jdText: "", structured: s })).toEqual(["industrial", "industrial_supplementary"]);
    expect(detectPostingMilitaryService({ roleTitle: "개발자", jdText: null, structured: null })).toEqual([]);
  });
});

describe("문구", () => {
  it("태그 → 화면 문구", () => {
    expect(militaryServiceLabels(["expert"])).toEqual(["전문연 가능"]);
    expect(militaryServiceLabels(["industrial", "industrial_supplementary"])).toEqual(["산업기능요원 가능(보충역)"]);
    expect(militaryServiceLabels(["expert", "industrial", "industrial_supplementary", "industrial_active"])).toEqual([
      "전문연 가능",
      "산업기능요원 가능(현역·보충역)",
    ]);
    expect(militaryServiceLabels(["general"])).toEqual(["병역특례 가능"]);
    expect(militaryServiceLabels([])).toEqual([]);
  });
});
