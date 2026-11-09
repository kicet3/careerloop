/**
 * 다듬기 항목 제안 검증(순수): 대상 항목·자리·칸은 서버가 정한다(없는 항목·없는 칸·상한 넘침은 버린다), before는 지금 문서 값,
 * 칸 글자·줄 수 상한, 근거 없는 숫자·기술·이름 처리, 추가 자리표시, 적용(고치기·추가 순서), 상태(live·applied·stale·full),
 * 예전 메시지 호환(polishContinuationStart).
 */
import { describe, expect, it } from "vitest";
import {
  polishContinuationStart,
  polishItemConflicts,
  polishItemEditState,
  polishItemFieldLimit,
  polishItemSectionMax,
  polishItemState,
  type PolishItemSuggestion,
  ResumePolishDocOutputSchema,
  ResumePolishOutputSchema,
  withPolishItemAdds,
  withPolishItemEdit,
} from "@/lib/domain/resume-polish";
import { EMPTY_RESUME_ITEM, emptyResumeDocument, type ResumeDocument } from "@/lib/domain/resumes";
import { itemKeys } from "@/components/resumes/reorder";
import { pathCoveredByItem, politeKey, politeText, verifyItemSuggestion, verifyItemSuggestions } from "./polish-items";

function doc(): ResumeDocument {
  const d = emptyResumeDocument();
  d.projects = [
    { ...EMPTY_RESUME_ITEM.project(), name: "정산 개편", problem: "정산이 늦었다", bullets: ["배치를 나눴다"], techs: ["Kotlin"] },
    { ...EMPTY_RESUME_ITEM.project(), name: "주문 대시보드" },
  ];
  d.experience = [{ ...EMPTY_RESUME_ITEM.experience(), company: "페이랩", title: "백엔드", scope: "정산 담당" }];
  return d;
}

const SOURCE = "결제 개선 프로젝트: Go와 Kafka로 정산 배치를 다시 설계. 2023-01 ~ 2023-09. 정산 시간을 6시간에서 40분으로 줄였다.";

describe("항목 고치기(item-edit) 검증", () => {
  it("before는 서버가 지금 문서로 채우고, 같은 값·빈 값·허용 밖 칸은 뺀다", () => {
    const s = verifyItemSuggestion(
      {
        kind: "edit",
        section: "projects",
        index: 0,
        changes: [
          { field: "name", value: "결제 개선" },
          { field: "problem", value: "정산이 늦었다" },
          { field: "action", value: "" },
          { field: "motivation", value: "허용 밖" },
          { field: "name", value: "중복 칸" },
          { field: "result", value: "정산 시간을 6시간에서 40분으로 줄였다" },
        ],
        reason: "한 번에",
      },
      doc(),
      SOURCE,
      { allowAdd: false },
    )!;
    expect(s.kind).toBe("item-edit");
    expect(s.label).toBe("프로젝트 1 · 정산 개편");
    expect(s.changes.map((c) => [c.field, c.before, c.after])).toEqual([
      ["name", "정산 개편", "결제 개선"],
      // 서술 칸은 경어체로 맞춘다(이름 칸은 그대로).
      ["result", "", "정산 시간을 6시간에서 40분으로 줄였습니다"],
    ]);
    expect(s.flagged).toEqual([]);
  });

  it("없는 항목·없는 섹션·정수 아닌 자리는 버린다", () => {
    const changes = [{ field: "name", value: "새 이름" }];
    expect(verifyItemSuggestion({ kind: "edit", section: "projects", index: 2, changes }, doc(), SOURCE, { allowAdd: true })).toBeNull();
    expect(verifyItemSuggestion({ kind: "edit", section: "projects", index: -1, changes }, doc(), SOURCE, { allowAdd: true })).toBeNull();
    expect(verifyItemSuggestion({ kind: "edit", section: "projects", index: 0.5, changes }, doc(), SOURCE, { allowAdd: true })).toBeNull();
    expect(verifyItemSuggestion({ kind: "edit", section: "skills", index: 0, changes }, doc(), SOURCE, { allowAdd: true })).toBeNull();
    // 경력에는 name 칸이 없다.
    expect(verifyItemSuggestion({ kind: "edit", section: "experience", index: 0, changes }, doc(), SOURCE, { allowAdd: true })).toBeNull();
  });

  it("칸 모드(fixed)는 LLM의 kind·section·index를 무시하고 대상 항목으로 고정한다", () => {
    const s = verifyItemSuggestion({ kind: "add", section: "experience", index: 0, changes: [{ field: "action", value: "배치를 나눴다" }] }, doc(), SOURCE, {
      fixed: { section: "projects", index: 1 },
      allowAdd: false,
    })!;
    expect([s.kind, s.section, s.index]).toEqual(["item-edit", "projects", 1]);
  });

  it("근거 없는 숫자는 [ADD: 수치 확인 — …], 근거 없는 기술은 빼고, 근거 없는 기간은 바꾸지 않는다", () => {
    const s = verifyItemSuggestion(
      {
        kind: "edit",
        section: "projects",
        index: 0,
        changes: [
          { field: "result", value: "처리 시간을 73% 줄였다" },
          { field: "techs", value: "Go\nKafka\nRust" },
          { field: "startDate", value: "2021.05" },
          { field: "endDate", value: "2023.09" },
          { field: "bullets", value: "- 배치를 나눴다\n- 장애를 99% 줄였다" },
        ],
      },
      doc(),
      SOURCE,
      { allowAdd: false },
    )!;
    const by = Object.fromEntries(s.changes.map((c) => [c.field, c]));
    expect(by.result!.after).toMatch(/^\[ADD: 수치 확인 — 처리 시간을 73% 줄였다\]$/);
    expect(by.result!.flagged).toEqual(["73"]);
    expect(by.techs!.after).toEqual(["Go", "Kafka"]);
    expect(by.techs!.flagged).toEqual(["Rust"]);
    expect(by.startDate).toBeUndefined();
    expect(by.endDate!.after).toBe("2023.09");
    expect(by.bullets!.before).toEqual(["배치를 나눴다"]);
    expect(by.bullets!.after).toEqual(["배치를 나눴다", expect.stringMatching(/^\[ADD: 수치 확인 — 장애를 99% 줄였다\]$/)]);
    expect(s.flagged).toEqual(expect.arrayContaining(["73", "Rust", "2021.05", "99"]));
  });

  it("칸 글자·줄 수 상한(문서 스키마)을 넘으면 자른다", () => {
    const long = "가".repeat(400);
    const s = verifyItemSuggestion(
      { kind: "edit", section: "projects", index: 0, changes: [{ field: "name", value: long }, { field: "bullets", value: Array.from({ length: 30 }, (_, i) => `기여 ${i}`).join("\n") }] },
      doc(),
      "기여 0 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15 16 17 18 19 20 21 22 23 24 25 26 27 28 29",
      { allowAdd: false },
    )!;
    const name = s.changes.find((c) => c.field === "name")!.after as string;
    expect(name.length).toBe(polishItemFieldLimit("projects", "name").maxChars);
    expect((s.changes.find((c) => c.field === "bullets")!.after as string[]).length).toBe(15);
  });

  it("같은 항목 고치기는 첫 제안만, pathCoveredByItem은 고친 칸 안의 칸 경로만 덮는다", () => {
    const { suggestions, dropped } = verifyItemSuggestions(
      [
        { kind: "edit", section: "projects", index: 0, changes: [{ field: "action", value: "배치를 나눴다" }] },
        { kind: "edit", section: "projects", index: 0, changes: [{ field: "result", value: "줄였다" }] },
      ],
      doc(),
      SOURCE,
      3,
    );
    expect(suggestions).toHaveLength(1);
    expect(dropped).toBe(1);
    expect(pathCoveredByItem("projects[0].action", suggestions)).toBe(true);
    expect(pathCoveredByItem("projects[0].problem", suggestions)).toBe(false);
    expect(pathCoveredByItem("projects[1].action", suggestions)).toBe(false);
  });
});

describe("문체(경어체)", () => {
  it("고치기: 서술 칸만 경어체로(이름·역할·팀·기술·기간은 그대로), [ADD: …]·다시 온 지금 줄은 그대로", () => {
    const s = verifyItemSuggestion(
      {
        kind: "edit",
        section: "projects",
        index: 0,
        changes: [
          { field: "name", value: "결제 개선" },
          { field: "role", value: "정산을 맡았다" },
          { field: "team", value: "결제팀과 함께 했다" },
          { field: "action", value: "배치를 이벤트 기반으로 다시 설계했다." },
          { field: "result", value: "장애를 99% 줄였다" },
          { field: "bullets", value: "배치를 나눴다\n정산 지연을 줄였다" },
          { field: "techs", value: "Kotlin\nKafka" },
        ],
        reason: "한 번에",
      },
      doc(),
      SOURCE,
      { allowAdd: false },
    )!;
    const by = Object.fromEntries(s.changes.map((c) => [c.field, c.after]));
    expect(by.name).toBe("결제 개선");
    expect(by.role).toBe("정산을 맡았다");
    expect(by.team).toBe("결제팀과 함께 했다");
    expect(by.action).toBe("배치를 이벤트 기반으로 다시 설계했습니다.");
    // 근거 없는 숫자는 자리표시가 먼저 — [ADD: …] 안의 평어체는 그대로.
    expect(by.result).toBe("[ADD: 수치 확인 — 장애를 99% 줄였다]");
    // 지금 있는 줄(사용자가 쓴 줄)은 문체를 바꾸지 않고, 새 줄만 경어체.
    expect(by.bullets).toEqual(["배치를 나눴다", "정산 지연을 줄였습니다"]);
    expect(by.techs).toEqual(["Kotlin", "Kafka"]);
    expect(s.reason).toBe("한 번에");
  });

  it("고치기: 지금 값을 문체만 바꾼 칸은 변경으로 보지 않는다(사용자가 쓴 칸을 덮지 않는다)", () => {
    const s = verifyItemSuggestion(
      { kind: "edit", section: "projects", index: 0, changes: [{ field: "problem", value: "정산이 늦었습니다" }, { field: "bullets", value: "배치를 나눴습니다" }] },
      doc(),
      SOURCE,
      { allowAdd: false },
    );
    expect(s).toBeNull();
  });

  it("추가: 서술 칸만 경어체, 이름·역할은 그대로, 못 바꾼 평어체는 reason에 '문체 확인 필요'", () => {
    const s = verifyItemSuggestion(
      {
        kind: "add",
        section: "projects",
        changes: [
          { field: "name", value: "결제 개선" },
          { field: "role", value: "정산 배치를 맡았다" },
          { field: "summary", value: "정산 배치를 다시 만들었다." },
          { field: "action", value: "배치를 이벤트 기반으로 다시 만들다." },
        ],
        reason: "그래프에 있는 프로젝트",
      },
      doc(),
      SOURCE,
      { allowAdd: true },
    )!;
    expect(s.kind).toBe("item-add");
    expect(s.item).toMatchObject({ name: "결제 개선", role: "정산 배치를 맡았다", summary: "정산 배치를 다시 만들었습니다.", action: "배치를 이벤트 기반으로 다시 만들다." });
    expect(s.item!.problem).toMatch(/^\[ADD: /);
    expect(s.reason).toMatch(/^그래프에 있는 프로젝트 · 문체 확인 필요: '/);
  });

  it("경력 고치기: 담당 범위·기여 줄만 경어체(회사·직무는 그대로)", () => {
    const s = verifyItemSuggestion(
      { kind: "edit", section: "experience", index: 0, changes: [{ field: "title", value: "백엔드 리드" }, { field: "scope", value: "정산 API를 설계하고 운영한다." }] },
      doc(),
      "백엔드 리드 " + SOURCE,
      { allowAdd: false },
    )!;
    const by = Object.fromEntries(s.changes.map((c) => [c.field, c.after]));
    expect(by.title).toBe("백엔드 리드");
    expect(by.scope).toBe("정산 API를 설계하고 운영합니다.");
  });
});

describe("항목 추가(item-add) 검증", () => {
  it("근거에 있는 값만 넣고, 비어 있는 핵심 칸은 [ADD: …] 자리표시, 자리가 범위 밖이면 맨 뒤", () => {
    const s = verifyItemSuggestion(
      {
        kind: "add",
        section: "projects",
        index: 99,
        changes: [
          { field: "name", value: "결제 개선" },
          { field: "summary", value: "Go와 Kafka로 정산 배치를 다시 설계" },
          { field: "startDate", value: "2023.01" },
          { field: "techs", value: "Go, Kafka, Rust" },
        ],
        reason: "그래프에 있다",
      },
      doc(),
      SOURCE,
      { allowAdd: true },
    )!;
    expect(s.kind).toBe("item-add");
    expect(s.index).toBe(2);
    expect(s.label).toBe("새 프로젝트 · 결제 개선");
    expect(s.item).toMatchObject({
      name: "결제 개선",
      startDate: "2023.01",
      techs: ["Go", "Kafka"],
      problem: expect.stringMatching(/^\[ADD: 문제/),
      action: expect.stringMatching(/^\[ADD: 행동/),
      result: expect.stringMatching(/^\[ADD: 결과/),
      company: "",
      bullets: [],
    });
    expect(s.flagged).toEqual(["Rust"]);
    expect(s.changes.every((c) => (Array.isArray(c.before) ? c.before.length === 0 : c.before === ""))).toBe(true);
  });

  it("근거 없는 숫자는 표시하고, 이름(프로젝트 이름·회사)이 근거에 없는 새 항목은 받지 않는다(통째로 지어낸 항목)", () => {
    const s = verifyItemSuggestion(
      {
        kind: "add",
        section: "projects",
        index: -1,
        changes: [
          { field: "name", value: "결제 개선" },
          { field: "company", value: "블록체인 랩" },
          { field: "summary", value: "Go와 Kafka로 정산 배치를 다시 설계" },
          { field: "result", value: "매출을 300% 올렸다" },
        ],
      },
      doc(),
      SOURCE,
      { allowAdd: true },
    )!;
    expect(s.item!.name).toBe("결제 개선");
    // 이름 칸 중 하나가 근거에 있으면 받되, 근거 없는 회사는 확인을 받는다.
    expect(s.item!.company).toBe("[ADD: 이름 확인 — 블록체인 랩]");
    expect(s.item!.result).toBe("[ADD: 수치 확인 — 매출을 300% 올렸다]");
    expect(s.flagged).toEqual(expect.arrayContaining(["블록체인 랩", "300"]));
    // 이름이 근거에 없으면 요약·문제·행동이 숫자 없이 그럴듯해도 추가하지 않는다.
    expect(
      verifyItemSuggestion(
        {
          kind: "add",
          section: "projects",
          index: -1,
          changes: [
            { field: "name", value: "블록체인 정산 혁신" },
            { field: "summary", value: "Go와 Kafka로 정산 배치를 다시 설계" },
            { field: "problem", value: "정산 오류가 잦았다" },
            { field: "action", value: "검증 단계를 새로 만들었다" },
          ],
        },
        doc(),
        SOURCE,
        { allowAdd: true },
      ),
    ).toBeNull();
  });

  it("기술·이름은 JD를 뺀 근거(facts)로만 확인하고, 기술은 낱말로 맞춘다(Go ⊄ google, Java ⊄ JavaScript)", () => {
    const jd = "자격: Kubernetes 우대, 회사 메가코프";
    const s = verifyItemSuggestion(
      {
        kind: "add",
        section: "projects",
        index: -1,
        changes: [
          { field: "name", value: "결제 개선" },
          { field: "company", value: "메가코프" },
          { field: "techs", value: "Go, Kubernetes, Kafka" },
        ],
      },
      doc(),
      `${SOURCE}\n${jd}`,
      { allowAdd: true, facts: SOURCE },
    )!;
    expect(s.item!.techs).toEqual(["Go", "Kafka"]);
    expect(s.item!.company).toBe("[ADD: 이름 확인 — 메가코프]");
    expect(s.flagged).toEqual(expect.arrayContaining(["Kubernetes", "메가코프"]));
    const sub = verifyItemSuggestion(
      { kind: "edit", section: "projects", index: 0, changes: [{ field: "techs", value: "Kotlin, Go, Java, C, Node.js" }] },
      doc(),
      "google 검색 광고, JavaScript, C++, NodeJS",
      { allowAdd: false },
    )!;
    // Kotlin은 지금 값(before)에 있다. Node.js는 표기만 다르다.
    expect(sub.changes[0]!.after).toEqual(["Kotlin", "Node.js"]);
    expect(sub.flagged).toEqual(expect.arrayContaining(["Go", "Java", "C"]));
  });

  it("고치기도 이름·직무는 근거에 없으면 [ADD: … 확인 — …], 역할·팀은 값은 두고 표시한다", () => {
    const p = verifyItemSuggestion(
      {
        kind: "edit",
        section: "projects",
        index: 1,
        changes: [
          { field: "company", value: "완전히 지어낸 회사" },
          { field: "role", value: "팀 리드" },
          { field: "problem", value: "주문 현황을 한눈에 보기 어려웠다" },
        ],
      },
      doc(),
      SOURCE,
      { allowAdd: false },
    )!;
    const after = Object.fromEntries(p.changes.map((c) => [c.field, c.after]));
    expect(after.company).toBe("[ADD: 이름 확인 — 완전히 지어낸 회사]");
    expect(after.role).toBe("팀 리드");
    expect(p.flagged).toEqual(expect.arrayContaining(["완전히 지어낸 회사", "팀 리드"]));
    const e = verifyItemSuggestion({ kind: "edit", section: "experience", index: 0, changes: [{ field: "title", value: "CTO" }] }, doc(), SOURCE, {
      allowAdd: false,
    })!;
    expect(e.changes[0]!.after).toBe("[ADD: 사실 확인 — CTO]");
    // 사용자가 말한(근거에 있는) 값은 그대로.
    const ok = verifyItemSuggestion({ kind: "edit", section: "experience", index: 0, changes: [{ field: "title", value: "백엔드 리드" }] }, doc(), `${SOURCE} 직무는 백엔드 리드`, {
      allowAdd: false,
    })!;
    expect(ok.changes[0]!.after).toBe("백엔드 리드");
  });

  it("이미 있는 항목(같은 이름)·추가를 받지 않는 모드·섹션 상한이면 버린다", () => {
    const add = { kind: "add", section: "projects", index: -1, changes: [{ field: "name", value: "정산 개편" }, { field: "summary", value: "정산" }] };
    expect(verifyItemSuggestion(add, doc(), `${SOURCE} 정산 개편`, { allowAdd: true })).toBeNull();
    const fresh = { ...add, changes: [{ field: "name", value: "결제 개선" }] };
    expect(verifyItemSuggestion(fresh, doc(), SOURCE, { allowAdd: false })).toBeNull();
    const full = doc();
    full.projects = Array.from({ length: polishItemSectionMax("projects") }, (_, i) => ({ ...EMPTY_RESUME_ITEM.project(), name: `p${i}` }));
    expect(verifyItemSuggestion(fresh, full, SOURCE, { allowAdd: true })).toBeNull();
    // 같은 답변 안의 추가도 센다: 19개면 하나만.
    full.projects.pop();
    const many = verifyItemSuggestions(
      [fresh, { ...fresh, changes: [{ field: "name", value: "주문" }, { field: "summary", value: "Kafka" }] }],
      full,
      `${SOURCE} 주문`,
      3,
    );
    expect(many.suggestions.map((s) => s.kind)).toEqual(["item-add"]);
    expect(many.dropped).toBe(1);
  });

  it("경력 추가: 같은 회사라도 직무가 다르면 새 항목이다", () => {
    const s = verifyItemSuggestion(
      { kind: "add", section: "experience", index: 0, changes: [{ field: "company", value: "페이랩" }, { field: "title", value: "프론트엔드 인턴" }] },
      doc(),
      "페이랩 프론트엔드 인턴",
      { allowAdd: true },
    )!;
    expect(s.index).toBe(0);
    expect(s.item).toMatchObject({ company: "페이랩", title: "프론트엔드 인턴", scope: expect.stringMatching(/^\[ADD: 담당 범위/) });
    const dup = verifyItemSuggestion({ kind: "add", section: "experience", index: 0, changes: [{ field: "company", value: "페이랩" }, { field: "title", value: "백엔드" }] }, doc(), "페이랩 백엔드", {
      allowAdd: true,
    });
    expect(dup).toBeNull();
  });
});

describe("적용·상태(순수)", () => {
  const edit = (): PolishItemSuggestion =>
    verifyItemSuggestion(
      { kind: "edit", section: "projects", index: 0, changes: [{ field: "name", value: "결제 개선" }, { field: "action", value: "배치를 나눴다" }] },
      doc(),
      SOURCE,
      { allowAdd: false },
    )!;

  it("고치기: 지금 값이면 live, 바꾼 뒤면 applied, 고칠 칸이 바뀌었으면 stale + 충돌 칸(뺀 칸은 확인하지 않는다)", () => {
    const s = edit();
    const d = doc();
    expect(polishItemState(d, s)).toBe("live");
    const after = withPolishItemEdit(d, s)!;
    expect(after.projects[0]).toMatchObject({ name: "결제 개선", action: "배치를 나눴습니다", problem: "정산이 늦었다" });
    expect(d.projects[0]!.name).toBe("정산 개편");
    expect(polishItemState(after, s)).toBe("applied");
    const partial = withPolishItemEdit(d, s, ["name"])!;
    expect(partial.projects[0]!.name).toBe("정산 개편");
    expect(polishItemEditState(partial.projects[0], s)).toBe("applied");
    const changed = doc();
    changed.projects[0]!.name = "사용자가 바꾼 이름";
    expect(polishItemState(changed, s)).toBe("stale");
    expect(polishItemConflicts(changed, s).map((c) => c.field)).toEqual(["name"]);
    expect(polishItemConflicts(changed, s, ["name"])).toEqual([]);
    // 항목이 사라지면 stale.
    expect(polishItemState({ ...changed, projects: [] }, s)).toBe("stale");
  });

  it("추가: 제안 자리에 넣고(큰 자리부터 — 앞 자리가 밀리지 않게), 넣은 뒤에는 applied, 상한이면 full", () => {
    const d = doc();
    const add = (name: string, index: number) =>
      verifyItemSuggestion({ kind: "add", section: "projects", index, changes: [{ field: "name", value: name }] }, d, `${SOURCE} 가람 나래 다온`, { allowAdd: true })!;
    const [a, b, c] = [add("가람", 0), add("나래", 1), add("다온", -1)];
    const next = withPolishItemAdds(d, [a, b, c]);
    expect(next.projects.map((p) => p.name)).toEqual(["가람", "정산 개편", "나래", "주문 대시보드", "다온"]);
    expect(polishItemState(next, a)).toBe("applied");
    // 추가한 뒤 그 항목을 고쳐도(이름 그대로) 다시 추가하지 않는다.
    next.projects[0]!.summary = "나중에 고침";
    expect(polishItemState(next, a)).toBe("applied");
    const full = { ...d, projects: Array.from({ length: 20 }, (_, i) => ({ ...EMPTY_RESUME_ITEM.project(), name: `p${i}` })) };
    expect(polishItemState(full, c)).toBe("full");
  });

  it("추가: 적용 기록이 있으면 항목을 고친 뒤에도 applied(자리표시 이름을 채워도 다시 추가되지 않는다)", () => {
    const d = doc();
    const s = verifyItemSuggestion(
      { kind: "add", section: "projects", index: -1, changes: [{ field: "company", value: "페이랩" }, { field: "name", value: "지어낸 이름" }] },
      d,
      `${SOURCE} 페이랩`,
      { allowAdd: true },
    )!;
    expect(s.item!.name).toBe("[ADD: 이름 확인 — 지어낸 이름]");
    const next = withPolishItemAdds(d, [s]);
    next.projects[2]!.name = "사용자가 채운 이름";
    next.projects[2]!.company = "페이랩(주)";
    expect(polishItemState(next, s)).toBe("live");
    expect(polishItemState(next, s, true)).toBe("applied");
  });

  it("고치기: 같은 자리에 다른 항목이 오면(순서 바꾸기) 빈 칸 채우기도 stale·충돌이다", () => {
    const d = emptyResumeDocument();
    d.projects = [
      { ...EMPTY_RESUME_ITEM.project(), name: "A 결제" },
      { ...EMPTY_RESUME_ITEM.project(), name: "B 검색" },
    ];
    const s = verifyItemSuggestion(
      { kind: "edit", section: "projects", index: 0, changes: [{ field: "problem", value: "결제 실패가 잦았다" }, { field: "action", value: "재시도를 넣었다" }] },
      d,
      "결제 실패가 잦았다 재시도를 넣었다",
      { allowAdd: false },
    )!;
    expect(s.anchor).toMatchObject({ name: "A 결제" });
    const swapped = { ...d, projects: [d.projects[1]!, d.projects[0]!] };
    expect(polishItemState(swapped, s)).toBe("stale");
    expect(polishItemConflicts(swapped, s).map((c) => c.field)).toEqual(["problem", "action"]);
    expect(polishItemState(d, s)).toBe("live");
    expect(polishItemState(withPolishItemEdit(d, s)!, s)).toBe("applied");
    // 이름·기간이 모두 빈 항목 둘은 고치지 않는 칸 전체로 구별한다.
    const blank = emptyResumeDocument();
    blank.projects = [
      { ...EMPTY_RESUME_ITEM.project(), summary: "첫째" },
      { ...EMPTY_RESUME_ITEM.project(), summary: "둘째" },
    ];
    const b = verifyItemSuggestion({ kind: "edit", section: "projects", index: 0, changes: [{ field: "problem", value: "결제 실패가 잦았다" }] }, blank, "결제 실패가 잦았다", {
      allowAdd: false,
    })!;
    expect(polishItemConflicts({ ...blank, projects: [blank.projects[1]!, blank.projects[0]!] }, b)).toHaveLength(1);
    // anchor가 없는 예전 제안은 확인하지 않는다.
    const { anchor: _old, ...legacy } = s;
    expect(polishItemConflicts(swapped, legacy)).toEqual([]);
  });

  it("칸 모드: 대상이 목록 줄이면 그 목록 칸은 항목 제안에서 받지 않는다(skipFields)", () => {
    const s = verifyItemSuggestion(
      { changes: [{ field: "bullets", value: "a\nb" }, { field: "action", value: "배치를 나눴다" }] },
      doc(),
      SOURCE,
      { fixed: { section: "projects", index: 0 }, skipFields: ["bullets"], allowAdd: false },
    )!;
    expect(s.changes.map((c) => c.field)).toEqual(["action"]);
  });

  it("편집기 항목 key: 추가를 적용한 문서는 새 항목에 새 key를 준다(stable-key 순서 바꾸기와 충돌하지 않는다)", () => {
    const d = doc();
    const before = itemKeys(d.projects);
    const s = verifyItemSuggestion({ kind: "add", section: "projects", index: -1, changes: [{ field: "name", value: "결제 개선" }] }, d, SOURCE, { allowAdd: true })!;
    const next = structuredClone(withPolishItemAdds(d, [s]));
    const after = itemKeys(next.projects);
    expect(after).toHaveLength(3);
    expect(new Set([...before, ...after]).size).toBe(5);
  });
});

describe("출력 스키마·예전 메시지 호환", () => {
  it("예전 출력(항목 필드 없음)도 받아들이고 기본값은 빈 배열", () => {
    expect(ResumePolishOutputSchema.parse({ reply: "r", suggestions: [] })).toMatchObject({ itemChanges: [], itemReason: "" });
    expect(ResumePolishDocOutputSchema.parse({ answer: "a", suggestions: [] }).items).toEqual([]);
    expect(ResumePolishDocOutputSchema.safeParse({ answer: "a", suggestions: [], items: [{ kind: "rename", section: "projects", index: 0, changes: [], reason: "" }] }).success).toBe(false);
  });

  it("polishContinuationStart: 예전 메시지(itemSuggestion 없음)는 그대로, 항목 제안을 적용했으면 대상 칸의 새 값으로 이어진다", () => {
    const old = { role: "assistant", status: "applied", data: { kind: "resume-polish", targetPath: "projects[0].problem", before: "A", suggestions: [{ text: "B" }], appliedIndex: 0 } };
    expect(polishContinuationStart([old], "B")).toBe(0);
    const item = {
      role: "assistant",
      status: "applied",
      data: {
        kind: "resume-polish",
        targetPath: "projects[0].problem",
        before: "A",
        suggestions: [{ text: "B" }],
        appliedItem: true,
        itemSuggestion: { kind: "item-edit", section: "projects", index: 0, changes: [{ field: "problem", before: "A", after: "C" }] },
      },
    };
    expect(polishContinuationStart([item], "C")).toBe(0);
    expect(polishContinuationStart([item], "B")).toBe(1);
  });
});

describe("politeText — ASCII 작은따옴표 인용 보호", () => {
  it("'…했다.' 인용은 그대로 두고 바깥 문장만 경어체로 바꾼다", () => {
    const r = politeText("지금 글 '정산 배치를 줄였다.'는 결과가 모호했다.\n- 요약을 줄였다");
    expect(r.text).toBe("지금 글 '정산 배치를 줄였다.'는 결과가 모호했습니다.\n- 요약을 줄였습니다");
    expect(r.leftovers).toEqual([]);
  });
  it("멱등이고 다른 보호 따옴표가 이미 있어도 되돌림이 섞이지 않는다", () => {
    const once = politeText("「원문」과 '개선했다.'를 비교했다.").text;
    expect(once).toBe("「원문」과 '개선했다.'를 비교했습니다.");
    expect(politeText(once).text).toBe(once);
    expect(politeKey("API를 개선했다.")).toBe("API를 개선했습니다.");
  });
});
