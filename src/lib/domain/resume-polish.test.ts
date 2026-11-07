import { describe, expect, it } from "vitest";
import { emptyResumeDocument, type ResumeDocument } from "./resumes";
import {
  ApplyPolishDocSchema,
  isPolishPath,
  isPolishTargetPath,
  polishFieldFromPath,
  polishSectionLabel,
  polishContinuationStart,
  polishMaxChars,
  polishPathFromField,
  polishTargets,
  polishTargetText,
  withPolishTarget,
} from "./resume-polish";

function doc(): ResumeDocument {
  const d = emptyResumeDocument();
  d.basics.tagline = "결제 지연을 줄여 온 백엔드 개발자";
  d.summary = "정산 배치를 다시 설계했다.";
  d.experience = [
    { company: "페이랩", department: "", title: "백엔드", startDate: "2022.01", endDate: "현재", location: "", scope: "정산 시스템 담당", bullets: ["정산 배치 개편", ""] },
  ];
  d.skills = [{ category: "백엔드", detail: "Go로 배치 운영", items: ["Go"] }];
  d.extras = [{ title: "수상", items: ["사내 해커톤 1위"] }];
  return d;
}

describe("다듬기 대상 경로", () => {
  it("다듬을 수 있는 칸만 허용한다(이름·연락처·날짜는 제외)", () => {
    for (const p of ["summary", "basics.tagline", "experience[0].bullets[1]", "projects[2].result", "skills[0].detail", "extras[0].items[0]", "highlights[1].context"]) {
      expect(isPolishPath(p)).toBe(true);
    }
    for (const p of ["basics.name", "basics.email", "experience[0].startDate", "experience[0].company", "__proto__", "summary.x", "experience[0].bullets", "motivation", "basics.motivation"]) {
      expect(isPolishPath(p)).toBe(false);
    }
  });

  it("시트 칸의 data-field를 대상 경로로 바꾼다", () => {
    expect(polishPathFromField("experience.0.bullets.1")).toBe("experience[0].bullets[1]");
    expect(polishPathFromField("basics.tagline")).toBe("basics.tagline");
    expect(polishPathFromField("projects.3.problem")).toBe("projects[3].problem");
    expect(polishPathFromField("basics.email")).toBeNull();
    expect(polishPathFromField("headings.experience")).toBeNull();
  });

  it("칸 읽기·쓰기: 없는 칸은 null, 원본 문서는 바꾸지 않는다", () => {
    const d = doc();
    expect(polishTargetText(d, "experience[0].bullets[0]")).toBe("정산 배치 개편");
    expect(polishTargetText(d, "experience[3].bullets[0]")).toBeNull();
    const next = withPolishTarget(d, "experience[0].bullets[0]", "정산 배치를 스트리밍으로 개편");
    expect(next?.experience[0]!.bullets[0]).toBe("정산 배치를 스트리밍으로 개편");
    expect(d.experience[0]!.bullets[0]).toBe("정산 배치 개편");
    expect(withPolishTarget(d, "projects[0].summary", "x")).toBeNull();
  });

  it("지원 동기는 다듬기 대상이 아니다(AI는 쓸 거리만 추천하고 문장은 쓰지 않는다)", () => {
    const d = doc();
    d.motivation = "결제 신뢰성을 높이는 일에 끌렸습니다.";
    expect(polishTargets(d).map((t) => t.path)).not.toContain("motivation");
    expect(polishTargetText(d, "motivation")).toBeNull();
    expect(withPolishTarget(d, "motivation", "x")).toBeNull();
  });

  it("대상 목록은 글이 있는 칸만, 이름은 항목을 알아볼 수 있게", () => {
    const targets = polishTargets(doc());
    expect(targets.map((t) => t.path)).toEqual(["basics.tagline", "summary", "experience[0].scope", "experience[0].bullets[0]", "skills[0].detail", "extras[0].items[0]"]);
    expect(targets.find((t) => t.path === "experience[0].bullets[0]")!.label).toBe("경력 1 · 페이랩 · 기여 1");
  });

  it("글자 상한은 문서 스키마에서 읽는다", () => {
    expect(polishMaxChars("summary")).toBe(1500);
    expect(polishMaxChars("basics.tagline")).toBe(200);
    expect(polishMaxChars("experience[0].bullets[2]")).toBe(500);
    expect(polishMaxChars("skills[0].detail")).toBe(300);
    expect(polishMaxChars("extras[0].items[0]")).toBe(300);
  });
});

describe("이전 글에 대한 대화", () => {
  const reply = (before: string, texts: string[], applied?: number) => ({
    role: "assistant",
    status: applied === undefined ? "proposed" : "applied",
    data: { kind: "resume-polish", before, suggestions: texts.map((text) => ({ text, reason: "", flagged: [] })), ...(applied === undefined ? {} : { appliedIndex: applied }) },
  });
  const user = { role: "user", data: null, status: null };

  it("모두 지금 글에 대한 것이면 0", () => {
    expect(polishContinuationStart([user, reply("A", ["A1", "A2"])], "A")).toBe(0);
  });

  it("적용 → 이어서 다듬기는 한 줄기로 본다", () => {
    expect(polishContinuationStart([user, reply("A", ["A1", "A2"], 1), user, reply("A2", ["B1"])], "A2")).toBe(0);
  });

  it("칸 위치가 바뀌어 다른 문장이 되면(또는 직접 고치면) 그 앞을 끊는다", () => {
    const msgs = [user, reply("옛 문장", ["X1"]), user, reply("지금 문장", ["Y1"])];
    expect(polishContinuationStart(msgs, "지금 문장")).toBe(2);
    expect(polishContinuationStart(msgs, "직접 고친 문장")).toBe(4);
  });
});

describe("전체 이력서 모드 계약", () => {
  it("대상은 'document' 또는 다듬을 수 있는 칸, 지원 동기·연락처는 아니다", () => {
    expect(isPolishTargetPath("document")).toBe(true);
    expect(isPolishTargetPath("summary")).toBe(true);
    for (const p of ["motivation", "basics.email", "Document", "document.summary"]) expect(isPolishTargetPath(p)).toBe(false);
  });

  it("경로 ↔ 시트 칸, 구역 이름", () => {
    expect(polishFieldFromPath("experience[0].bullets[1]")).toBe("experience.0.bullets.1");
    expect(polishPathFromField(polishFieldFromPath("projects[2].result"))).toBe("projects[2].result");
    expect(polishSectionLabel("basics.tagline")).toBe("소개");
    expect(polishSectionLabel("summary")).toBe("소개");
    expect(polishSectionLabel("experience[0].scope")).toBe("경력");
    expect(polishSectionLabel("extras[1].items[0]")).toBe("기타");
  });

  it("includeEmpty면 빈 칸도 넣는다", () => {
    const d = doc();
    expect(polishTargets(d).some((t) => t.path === "experience[0].bullets[1]")).toBe(false);
    expect(polishTargets(d, { includeEmpty: true }).some((t) => t.path === "experience[0].bullets[1]")).toBe(true);
  });

  it("적용 본문: 1~6개, 중복 없이", () => {
    expect(ApplyPolishDocSchema.safeParse({ messageId: "m", indices: [0, 2] }).success).toBe(true);
    expect(ApplyPolishDocSchema.safeParse({ messageId: "m", indices: [] }).success).toBe(false);
    expect(ApplyPolishDocSchema.safeParse({ messageId: "m", indices: [1, 1] }).success).toBe(false);
    expect(ApplyPolishDocSchema.safeParse({ messageId: "m", indices: [6] }).success).toBe(false);
  });
});
