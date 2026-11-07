import { describe, expect, it } from "vitest";
import {
  datesMentioned,
  isFutureGraphDate,
  kstMonthOf,
  legacyDateRewrites,
  normalizeNodeDates,
  normalizeStoredDates,
  parseGraphDate,
} from "./graph-dates";
import { normalizeGraphDate, toGraphOps, type LlmGraphOp } from "./graph";

const TODAY = "2026-11-07";

describe("parseGraphDate — 날짜 표기 표", () => {
  const cases: [string, ReturnType<typeof parseGraphDate>][] = [
    ["2024-03", { kind: "date", value: "2024-03" }],
    ["2024-3", { kind: "date", value: "2024-03" }],
    ["2024.3", { kind: "date", value: "2024-03" }],
    ["2024.03.", { kind: "date", value: "2024-03" }],
    ["2024. 03", { kind: "date", value: "2024-03" }],
    ["2024/03", { kind: "date", value: "2024-03" }],
    ["2024년 3월", { kind: "date", value: "2024-03" }],
    ["2024년3월", { kind: "date", value: "2024-03" }],
    ["24.03", { kind: "date", value: "2024-03" }],
    ["'24.03", { kind: "date", value: "2024-03" }],
    ["24년 3월", { kind: "date", value: "2024-03" }],
    ["98.03", { kind: "date", value: "1998-03" }],
    ["2024-03-15", { kind: "date", value: "2024-03" }],
    ["2024-03-15T09:30:00Z", { kind: "date", value: "2024-03" }],
    ["2024.03.15", { kind: "date", value: "2024-03" }],
    ["2024년 3월 15일", { kind: "date", value: "2024-03" }],
    ["202403", { kind: "date", value: "2024-03" }],
    ["20240315", { kind: "date", value: "2024-03" }],
    ["03/2024", { kind: "date", value: "2024-03" }],
    ["Mar 2024", { kind: "date", value: "2024-03" }],
    ["March 2024", { kind: "date", value: "2024-03" }],
    ["Sept. 2023", { kind: "date", value: "2023-09" }],
    ["2024", { kind: "date", value: "2024" }],
    ["2024년", { kind: "date", value: "2024" }],
    ["2024년 상반기", { kind: "date", value: "2024" }],
    ["현재", { kind: "ongoing" }],
    ["재직중", { kind: "ongoing" }],
    ["재직 중", { kind: "ongoing" }],
    ["진행 중", { kind: "ongoing" }],
    ["현재 재학 중", { kind: "ongoing" }],
    ["지금까지", { kind: "ongoing" }],
    ["~ 현재", { kind: "ongoing" }],
    ["Present", { kind: "ongoing" }],
    ["ongoing", { kind: "ongoing" }],
    ["~", { kind: "empty" }],
    ["-", { kind: "empty" }],
    ["", { kind: "empty" }],
    ["  ", { kind: "empty" }],
    ["모름", { kind: "empty" }],
    ["2024-13", { kind: "invalid" }],
    ["2024-02-30", { kind: "invalid" }],
    ["2024.03 ~ 2024.06", { kind: "invalid" }],
    ["작년쯤", { kind: "invalid" }],
    ["asdf", { kind: "invalid" }],
    ["3개월", { kind: "invalid" }],
    ["1800-01", { kind: "invalid" }],
    ["Foo 2024", { kind: "invalid" }],
  ];
  it.each(cases)("%s", (input, expected) => {
    expect(parseGraphDate(input)).toEqual(expected);
  });

  it("상대 표현은 오늘(KST) 기준으로 푼다 — today가 없으면 풀지 않는다", () => {
    expect(parseGraphDate("작년 3월", { today: TODAY })).toEqual({ kind: "date", value: "2025-03" });
    expect(parseGraphDate("올해", { today: TODAY })).toEqual({ kind: "date", value: "2026" });
    expect(parseGraphDate("재작년", { today: TODAY })).toEqual({ kind: "date", value: "2024" });
    expect(parseGraphDate("지난달", { today: TODAY })).toEqual({ kind: "date", value: "2026-10" });
    expect(parseGraphDate("지난달", { today: "2026-01-03" })).toEqual({ kind: "date", value: "2025-12" });
    expect(parseGraphDate("이번 달", { today: TODAY })).toEqual({ kind: "date", value: "2026-11" });
    expect(parseGraphDate("작년 3월")).toEqual({ kind: "invalid" });
  });

  it("normalizeGraphDate(옛 이름)는 같은 규칙, 모르는 값은 그대로", () => {
    expect(normalizeGraphDate("2021.03")).toBe("2021-03");
    expect(normalizeGraphDate("2021-03-05")).toBe("2021-03");
    expect(normalizeGraphDate("모르는 값")).toBe("모르는 값");
  });

  it("미래 판정은 달 단위(연도만이면 연도 단위)", () => {
    expect(isFutureGraphDate("2026-11", TODAY)).toBe(false);
    expect(isFutureGraphDate("2026-12", TODAY)).toBe(true);
    expect(isFutureGraphDate("2026", TODAY)).toBe(false);
    expect(isFutureGraphDate("2027", TODAY)).toBe(true);
  });

  it("kstMonthOf: UTC 시각을 한국 시간 달로", () => {
    expect(kstMonthOf("2026-08-31T20:00:00Z")).toBe("2026-09");
    expect(kstMonthOf("2026-08-31T10:00:00Z")).toBe("2026-08");
    expect(kstMonthOf(null)).toBeNull();
    expect(kstMonthOf("x")).toBeNull();
  });
});

describe("normalizeNodeDates — 쓰기 계약", () => {
  const opts = { mode: "add" as const, today: TODAY };

  it("형식을 맞추고 종료 '현재'는 current=true(endDate 없음)", () => {
    expect(normalizeNodeDates("Project", { name: "P", startDate: "2024.3", endDate: "현재" }, opts)).toEqual({
      props: { name: "P", startDate: "2024-03", current: true },
      issues: [],
    });
  });

  it("current와 실제 종료일이 함께 오면 current가 이기고 종료일은 뺀다(진행 중인 일을 이번 달 종료로 적던 문제)", () => {
    expect(normalizeNodeDates("Role", { title: "R", startDate: "2025-10", endDate: "2026-11", current: true }, opts).props).toEqual({
      title: "R",
      startDate: "2025-10",
      current: true,
    });
  });

  it("오늘 이후는 뺀다(학력 종료 = 졸업 예정만 예외)", () => {
    const r = normalizeNodeDates("Project", { name: "P", startDate: "2026-12" }, opts);
    expect(r.props).toEqual({ name: "P" });
    expect(r.issues).toEqual([{ key: "startDate", value: "2026-12", reason: "future" }]);
    expect(normalizeNodeDates("Education", { school: "S", endDate: "2028-02" }, opts).issues).toEqual([]);
    expect(normalizeNodeDates("Certification", { name: "C", date: "2027-01" }, opts).issues[0]?.reason).toBe("future");
  });

  it("시작 > 종료면 이번 연산이 준 날짜를 뺀다(기존 값과도 비교)", () => {
    expect(normalizeNodeDates("Project", { name: "P", startDate: "2024-05", endDate: "2023-01" }, opts).issues.map((i) => i.reason)).toEqual([
      "order",
      "order",
    ]);
    const upd = normalizeNodeDates("Project", { endDate: "2023-01" }, { mode: "update", existing: { startDate: "2024-05" }, today: TODAY });
    expect(upd.props).toEqual({});
    expect(upd.issues).toEqual([{ key: "endDate", value: "2023-01", reason: "order" }]);
    // 연도만 있는 값은 연도로만 비교한다
    expect(normalizeNodeDates("Project", { name: "P", startDate: "2024", endDate: "2024-01" }, opts).issues).toEqual([]);
  });

  it("알아볼 수 없는 값·'~'·시작 '현재'", () => {
    const r = normalizeNodeDates("Experience", { title: "E", startDate: "현재", endDate: "~" }, opts);
    expect(r.props).toEqual({ title: "E" });
    expect(r.issues.map((i) => [i.key, i.reason])).toEqual([["startDate", "ongoing-start"]]);
    expect(normalizeNodeDates("Achievement", { summary: "A", date: "어제쯤" }, opts).issues[0]?.reason).toBe("format");
  });

  it("수정: 진행 중으로 바꾸면 기존 종료일을 지우고, 종료일을 주면 기존 진행 중을 지운다", () => {
    expect(normalizeNodeDates("Role", { endDate: "재직중" }, { mode: "update", existing: { endDate: "2026-10" }, today: TODAY }).props).toEqual({
      current: true,
      endDate: null,
    });
    expect(normalizeNodeDates("Role", { endDate: "2026-06" }, { mode: "update", existing: { current: true }, today: TODAY }).props).toEqual({
      endDate: "2026-06",
      current: null,
    });
    // 빈 값·null은 지우기
    expect(normalizeNodeDates("Project", { startDate: "", endDate: null }, { mode: "update", today: TODAY }).props).toEqual({
      startDate: null,
      endDate: null,
    });
  });
});

describe("normalizeStoredDates — 읽기(저장값은 바꾸지 않는다)", () => {
  it("옛 형식 YYYY-MM-DD → YYYY-MM, 종료 '현재' → current", () => {
    const stored = { title: "육군 병장", startDate: "2019-03-04", endDate: "2020-10-03" };
    expect(normalizeStoredDates("Experience", stored)).toEqual({ title: "육군 병장", startDate: "2019-03", endDate: "2020-10" });
    expect(stored.startDate).toBe("2019-03-04");
    expect(normalizeStoredDates("Role", { title: "R", startDate: "2024-01", endDate: "현재" })).toEqual({ title: "R", startDate: "2024-01", current: true });
    expect(normalizeStoredDates("Role", { title: "R", endDate: "2026-10", current: true })).toEqual({ title: "R", current: true });
  });

  it("이미 계약대로면 같은 객체, 알아볼 수 없는 값은 지우지 않는다", () => {
    const ok = { name: "P", startDate: "2024-03" };
    expect(normalizeStoredDates("Project", ok)).toBe(ok);
    expect(normalizeStoredDates("Project", { name: "P", startDate: "언젠가" })).toEqual({ name: "P", startDate: "언젠가" });
  });

  it("legacyDateRewrites: 다음 수정 때 다시 쓸 옛 형식만(멱등)", () => {
    expect(legacyDateRewrites({ startDate: "2019-03-04", endDate: "2020-10", date: "언젠가" })).toEqual({ startDate: "2019-03" });
    expect(legacyDateRewrites({ startDate: "2019-03" })).toEqual({});
  });
});

describe("datesMentioned", () => {
  it("글에 나온 연월·연도", () => {
    const s = datesMentioned("2025년 10월에 입사했고 24.03부터 사이드 프로젝트, 2023년에는 군복무");
    expect(s.has("2025-10")).toBe(true);
    expect(s.has("2024-03")).toBe(true);
    expect(s.has("2023")).toBe(true);
    expect(datesMentioned("작년 3월부터", TODAY).has("2025-03")).toBe(true);
  });
});

describe("toGraphOps — 날짜 계약", () => {
  const blank: LlmGraphOp = { op: "addNode", ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };
  it("'현재'는 current, 미래·순서 오류는 그 속성만 빼고 질문이 될 수 있는 사유를 남긴다", () => {
    const { ops, errors } = toGraphOps(
      [
        { ...blank, ref: "new:p", label: "Project", props: [{ key: "name", value: "P" }, { key: "startDate", value: "2025.10" }, { key: "endDate", value: "현재" }] },
        { ...blank, ref: "new:q", label: "Project", props: [{ key: "name", value: "Q" }, { key: "startDate", value: "2027-01" }] },
        { ...blank, ref: "new:c", label: "Certification", props: [{ key: "name", value: "정보처리기사" }, { key: "acquiredDate", value: "2023년 6월" }] },
      ],
      { today: TODAY },
    );
    expect(ops).toEqual([
      { op: "addNode", ref: "new:p", label: "Project", props: { name: "P", startDate: "2025-10", current: true } },
      { op: "addNode", ref: "new:q", label: "Project", props: { name: "Q" } },
      { op: "addNode", ref: "new:c", label: "Certification", props: { name: "정보처리기사", date: "2023-06" } },
    ]);
    expect(errors).toEqual(["#2 addNode: 속성 startDate 값 '2027-01'은(는) 오늘 이후 날짜라 뺐습니다"]);
  });
});
