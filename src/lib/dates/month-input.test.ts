import { describe, expect, it } from "vitest";
import { formatMonth, fromPickerValue, isUnrecognizedMonth, moveMonth, normalizeMonthInput, parseMonthInput, toPickerMonth } from "./month-input";

describe("normalizeMonthInput", () => {
  it.each([
    ["2024-02", "2024-02", "2024.02"],
    ["2024.2", "2024-02", "2024.02"],
    ["24.02", "2024-02", "2024.02"],
    ["2024년 2월", "2024-02", "2024.02"],
    ["2024/02", "2024-02", "2024.02"],
    ["202402", "2024-02", "2024.02"],
    [" 2024. 02 ", "2024-02", "2024.02"],
    ["2024-02-15", "2024-02", "2024.02"],
    ["2024", "2024", "2024"],
  ])("%s → dash %s / dot %s", (raw, dash, dot) => {
    expect(normalizeMonthInput(raw, "dash")).toEqual({ value: dash, current: false, recognized: true });
    expect(normalizeMonthInput(raw, "dot")).toEqual({ value: dot, current: false, recognized: true });
  });

  it.each(["현재", "재직중", "재직 중", "진행 중", "present"])("%s: 종료일이면 '현재', 시작일이면 알아볼 수 없음(그대로 둔다)", (raw) => {
    expect(normalizeMonthInput(raw, "dot", { allowCurrent: true })).toEqual({ value: "현재", current: true, recognized: true });
    expect(normalizeMonthInput(raw, "dash", { allowCurrent: true })).toEqual({ value: "현재", current: true, recognized: true });
    expect(normalizeMonthInput(raw, "dot")).toEqual({ value: raw, current: false, recognized: false });
  });

  it.each([
    ["아무 글", "아무 글"],
    ["2024-13", "2024-13"],
    ["2024.13", "2024.13"],
    ["202413", "202413"],
    ["2024-00", "2024-00"],
    ["  두 해 전  ", "두 해 전"],
    ["2024.03 ~ 2024.06", "2024.03 ~ 2024.06"],
    ["미정", "미정"],
  ])("%s: 알아볼 수 없으면 입력한 그대로(앞뒤 공백만 뺀다)", (raw, kept) => {
    expect(normalizeMonthInput(raw, "dash")).toEqual({ value: kept, current: false, recognized: false });
    expect(isUnrecognizedMonth(raw, "dot", { allowCurrent: true })).toBe(true);
  });

  it("빈 값은 빈 값", () => {
    expect(normalizeMonthInput("", "dot")).toEqual({ value: "", current: false, recognized: true });
    expect(normalizeMonthInput("   ", "dash")).toEqual({ value: "", current: false, recognized: true });
    expect(isUnrecognizedMonth("", "dash")).toBe(false);
  });
});

describe("달력 값 변환", () => {
  it("parseMonthInput은 연·월을 함께 돌려준다", () => {
    expect(parseMonthInput("2024년 2월", "dot")).toEqual({ kind: "date", value: "2024.02", year: 2024, month: 2 });
    expect(parseMonthInput("현재", "dot")).toEqual({ kind: "current" });
    expect(parseMonthInput("2024.13", "dot")).toEqual({ kind: "invalid" });
  });

  it("toPickerMonth: 연·월을 다 알 때만", () => {
    expect(toPickerMonth("2021.03")).toEqual({ year: 2021, month: 3 });
    expect(toPickerMonth("2021")).toBeNull();
    expect(toPickerMonth("현재")).toBeNull();
    expect(toPickerMonth("")).toBeNull();
  });

  it("fromPickerValue: <input type=month> 값 → 칸 형식", () => {
    expect(fromPickerValue("2024-02", "dot")).toBe("2024.02");
    expect(fromPickerValue("2024-02", "dash")).toBe("2024-02");
    expect(fromPickerValue("", "dash")).toBeNull();
    expect(fromPickerValue("2024-13", "dash")).toBeNull();
    expect(formatMonth(2024, null, "dot")).toBe("2024");
  });

  it("moveMonth: 3열 격자 방향키, 해를 넘긴다", () => {
    expect(moveMonth(2024, 1, "ArrowLeft")).toEqual({ year: 2023, month: 12 });
    expect(moveMonth(2024, 12, "ArrowRight")).toEqual({ year: 2025, month: 1 });
    expect(moveMonth(2024, 5, "ArrowUp")).toEqual({ year: 2024, month: 2 });
    expect(moveMonth(2024, 11, "ArrowDown")).toEqual({ year: 2025, month: 2 });
    expect(moveMonth(2024, 5, "PageUp")).toEqual({ year: 2023, month: 5 });
    expect(moveMonth(2024, 5, "Home")).toEqual({ year: 2024, month: 1 });
    expect(moveMonth(2024, 5, "End")).toEqual({ year: 2024, month: 12 });
    expect(moveMonth(2024, 5, "Enter")).toBeNull();
  });
});
