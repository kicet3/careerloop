import { describe, expect, it } from "vitest";
import type { ApplicationStage } from "@/lib/domain/applications";
import {
  buildSuggestions,
  companyRollup,
  resumePerformance,
  responseRate,
  stageFunnel,
  type InsightApplication,
  type InsightEvent,
  type InsightPosting,
} from "./insights";

// CareerLoop(src/lib/analytics.test.ts)의 사례를 이 제품의 정의(이벤트 기준 응답률, KST 마감)에 맞춰 옮겼다.

const T0 = Date.parse("2026-10-01T00:00:00Z");

function app(id: string, stage: ApplicationStage, extra: Partial<InsightApplication> = {}): InsightApplication {
  return {
    id,
    postingId: null,
    company: "제논",
    roleTitle: "백엔드",
    stage,
    appliedAt: "2026-10-01",
    nextStep: "",
    nextDate: null,
    resumeId: null,
    resumeVersionId: null,
    resumeLabel: null,
    createdAt: T0,
    updatedAt: T0,
    ...extra,
  };
}

/** 단계 경로를 이벤트로 만든다(첫 단계는 생성 이벤트). */
function path(id: string, ...stages: ApplicationStage[]): InsightEvent[] {
  return stages.map((toStage, i) => ({ applicationId: id, toStage, at: T0 + i * 1000 }));
}

function posting(id: string, extra: Partial<InsightPosting> = {}): InsightPosting {
  return { id, company: "누아", roleTitle: "프론트엔드", status: "saved", deadline: "", deadlineTime: "", deadlineKind: "unspecified", ...extra };
}

describe("응답률(R-12: 이벤트 기준 한 정의)", () => {
  const apps = [
    app("a", "applied"),
    app("b", "rejected"), // 면접까지 갔다가 불합격 → 응답으로 센다
    app("c", "rejected"), // 서류 불합격 → 응답 아님
    app("d", "interested"), // 지원 전 → 분모 아님
    app("e", "withdrawn"), // 지원 후 취소 → 분모
    app("f", "withdrawn"), // 지원 전 취소 → 분모 아님
  ];
  const events = [
    ...path("a", "applied"),
    ...path("b", "applied", "interview", "rejected"),
    ...path("c", "applied", "rejected"),
    ...path("d", "interested"),
    ...path("e", "applied", "withdrawn"),
    ...path("f", "interested", "withdrawn"),
  ];

  it("분모는 지원 완료 이후 도달, 분자는 과제·면접·합격에 한 번이라도 도달", () => {
    expect(responseRate(apps, events)).toEqual({ submitted: 4, responded: 1, rate: 0.25 });
  });

  it("지원이 없으면 rate는 null", () => {
    expect(responseRate([], [])).toEqual({ submitted: 0, responded: 0, rate: null });
  });

  it("이벤트가 없는 예전 행도 지금 단계로는 센다", () => {
    expect(responseRate([app("x", "interview")], [])).toEqual({ submitted: 1, responded: 1, rate: 1 });
  });

  it("단계 도달 수: 지원 완료는 지원서를 낸 모든 지원, 나머지는 이벤트 기준", () => {
    const funnel = Object.fromEntries(stageFunnel(apps, events).map((r) => [r.stage, r]));
    expect(funnel.applied).toEqual({ stage: "applied", reached: 4, current: 1 });
    expect(funnel.interview).toEqual({ stage: "interview", reached: 1, current: 0 });
    expect(funnel.rejected).toEqual({ stage: "rejected", reached: 2, current: 2 });
    expect(funnel.interested.reached).toBe(2);
    // 처음부터 면접으로 기록한 지원도 지원 완료로 센다.
    const direct = stageFunnel([app("y", "interview")], path("y", "interview"));
    expect(direct.find((r) => r.stage === "applied")?.reached).toBe(1);
  });
});

describe("이력서 버전별 성과", () => {
  it("버전 단위로 묶고 응답률은 전체와 같은 정의", () => {
    const apps = [
      app("1", "rejected", { resumeId: "r1", resumeVersionId: "v1", resumeLabel: "토스 백엔드 · v1" }),
      app("2", "applied", { resumeId: "r1", resumeVersionId: "v1", resumeLabel: "토스 백엔드 · v1" }),
      app("3", "applied", { resumeId: "r1", resumeVersionId: "v2", resumeLabel: "토스 백엔드 · v2" }),
      app("4", "applied"),
      app("5", "interested", { resumeId: "r1", resumeVersionId: "v2", resumeLabel: "토스 백엔드 · v2" }),
    ];
    const events = [...path("1", "applied", "interview", "rejected"), ...path("2", "applied"), ...path("3", "applied"), ...path("4", "applied")];
    const rows = resumePerformance(apps, events);
    expect(rows[0]).toMatchObject({ resumeVersionId: "v1", label: "토스 백엔드 · v1", submitted: 2, responded: 1, rate: 0.5 });
    expect(rows.find((r) => r.resumeVersionId === "v2")).toMatchObject({ submitted: 1, responded: 0, rate: 0 });
    expect(rows.find((r) => r.label === "이력서 기록 없음")).toMatchObject({ resumeId: null, submitted: 1 });
    // 관심 단계(5)는 세지 않는다.
    expect(rows.reduce((n, r) => n + r.submitted, 0)).toBe(4);
  });

  it("이력서를 지워도(resumeId null) 버전 id로 계속 묶인다", () => {
    const rows = resumePerformance(
      [app("1", "applied", { resumeVersionId: "v9", resumeLabel: "지운 이력서 · v3" }), app("2", "interview", { resumeVersionId: "v9", resumeLabel: "지운 이력서 · v3" })],
      [],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ resumeId: null, resumeVersionId: "v9", submitted: 2, responded: 1 });
  });
});

describe("회사별 묶음", () => {
  it("회사 이름(대소문자·공백 무시)으로 묶고 가장 앞선 단계와 최고 적합도 점수를 고른다", () => {
    const rows = companyRollup(
      [
        app("1", "applied", { company: "제논" }),
        app("2", "interview", { company: " 제논 " }),
        app("3", "rejected", { company: "누아" }),
        app("4", "applied", { company: "Acme" }),
        app("5", "applied", { company: "acme" }),
        app("6", "offer", { company: "ACME" }),
      ],
      new Map([
        ["1", 62],
        ["2", 78],
        ["3", 40],
      ]),
    );
    expect(rows.map((r) => r.company)).toEqual(["Acme", "제논", "누아"]);
    expect(rows[0]).toMatchObject({ applications: 3, bestStage: "offer", matchScore: null });
    expect(rows[1]).toMatchObject({ applications: 2, bestStage: "interview", matchScore: 78 });
    expect(rows[2]).toMatchObject({ bestStage: "rejected", matchScore: 40 });
  });

  it("불합격·취소보다 진행 중 단계가 앞선다", () => {
    const [row] = companyRollup([app("1", "rejected"), app("2", "applied")], new Map());
    expect(row?.bestStage).toBe("applied");
  });
});

describe("행동 제안", () => {
  const kst = (iso: string) => Date.parse(`${iso}+09:00`);

  it("마감 시각을 KST로 비교한다(R-13): 18:00 마감은 17:59에 임박, 18:01에 지남", () => {
    const p = posting("p1", { deadline: "2026-11-05", deadlineTime: "18:00", deadlineKind: "date" });
    const before = buildSuggestions({ applications: [], postings: [p], now: kst("2026-11-05T17:59:00") });
    expect(before[0]).toMatchObject({ kind: "deadline", postingId: "p1", href: "/app/postings/p1" });
    expect(before[0]?.message).toContain("1분 남음");
    const after = buildSuggestions({ applications: [], postings: [p], now: kst("2026-11-05T18:01:00") });
    expect(after).toHaveLength(1);
    expect(after[0]?.message).toContain("마감이 지난 공고 1건");
  });

  it("시각 없는 마감일은 KST 자정까지 유효(UTC 서버에서도 하루 어긋나지 않음)", () => {
    const p = posting("p1", { deadline: "2026-11-05", deadlineKind: "date" });
    // UTC로는 11-05 14:59지만 KST로는 11-05 23:59 → 오늘 마감.
    const late = buildSuggestions({ applications: [], postings: [p], now: Date.parse("2026-11-05T14:59:00Z") });
    expect(late[0]?.message).toContain("오늘 마감");
    // KST 11-06 00:00 → 지남.
    const next = buildSuggestions({ applications: [], postings: [p], now: Date.parse("2026-11-05T15:00:00Z") });
    expect(next[0]?.message).toContain("마감이 지난");
  });

  it("이미 지원했거나 마감·보류로 정리한 공고, 7일 넘게 남은 공고는 알리지 않는다", () => {
    const now = kst("2026-11-01T09:00:00");
    const postings = [
      posting("applied", { status: "applied", deadline: "2026-11-02", deadlineKind: "date" }),
      posting("hold", { status: "on_hold", deadline: "2026-11-02", deadlineKind: "date" }),
      posting("linked", { deadline: "2026-11-02", deadlineKind: "date" }),
      posting("far", { deadline: "2026-11-20", deadlineKind: "date" }),
      posting("rolling", { deadlineKind: "rolling" }),
    ];
    const out = buildSuggestions({ applications: [app("a", "applied", { postingId: "linked", appliedAt: "2026-11-01" })], postings, now });
    expect(out.filter((s) => s.kind === "deadline")).toEqual([]);
  });

  it("다음 일정: KST 날짜 경계로 오늘/내일을 가른다", () => {
    const a = app("a", "interview", { nextStep: "2차 면접", nextDate: "2026-11-06", appliedAt: "2026-11-01" });
    const eve = buildSuggestions({ applications: [a], postings: [], now: Date.parse("2026-11-05T14:59:00Z") });
    expect(eve.find((s) => s.kind === "next_step")?.message).toBe("내일 제논의 '2차 면접' 일정이 있습니다.");
    const day = buildSuggestions({ applications: [a], postings: [], now: Date.parse("2026-11-05T15:00:00Z") });
    expect(day.find((s) => s.kind === "next_step")).toMatchObject({ applicationId: "a", href: "/app/applications?open=a" });
    expect(day.find((s) => s.kind === "next_step")?.message).toContain("오늘");
    // 끝난 지원은 일정이 있어도 알리지 않는다.
    const done = buildSuggestions({ applications: [{ ...a, stage: "rejected" }], postings: [], now: Date.parse("2026-11-05T15:00:00Z") });
    expect(done.some((s) => s.kind === "next_step")).toBe(false);
  });

  it("지원 완료 10일째부터 팔로업을 제안한다", () => {
    const a = app("a", "applied", { appliedAt: "2026-10-26", resumeId: "r" });
    expect(buildSuggestions({ applications: [a], postings: [], now: kst("2026-11-04T23:00:00") }).some((s) => s.kind === "follow_up")).toBe(false);
    const out = buildSuggestions({ applications: [a], postings: [], now: kst("2026-11-05T00:30:00") });
    expect(out.find((s) => s.kind === "follow_up")).toMatchObject({ applicationId: "a" });
  });

  it("이력서 기록 없음·지원 예정·낮은 응답률", () => {
    const apps = [1, 2, 3, 4, 5].map((n) => app(`a${n}`, "applied", { appliedAt: "2026-11-04" }));
    const out = buildSuggestions({
      applications: apps,
      postings: [posting("p", { status: "planned" })],
      events: apps.flatMap((a) => path(a.id, "applied")),
      now: kst("2026-11-05T10:00:00"),
    });
    expect(out.map((s) => s.kind)).toEqual(["pipeline", "resume", "pipeline"]);
    expect(out[1]?.message).toContain("5건");
    expect(out[2]).toMatchObject({ href: "/app/new" });
    expect(out.map((s) => s.message).join(" ")).not.toMatch(/확률/);
  });

  it("할 일이 없으면 빈 배열", () => {
    expect(buildSuggestions({ applications: [], postings: [], now: T0 })).toEqual([]);
  });
});
