import { describe, expect, it } from "vitest";
import { wrapData } from "@/lib/chat/prompt";
import { CHAT_TAGS } from "@/lib/domain/chat";
import {
  estimateSpokenSeconds,
  InterviewFeedbackOutputSchema,
  InterviewQuestionsOutputSchema,
  normalizeFacet,
  type InterviewQuestionsOutput,
} from "@/lib/domain/interview";
import { EMPTY_RESUME_ITEM, emptyResumeDocument } from "@/lib/domain/resumes";
import { FakeLlmClient } from "@/test/fake-llm";
import { normalizeGeneratedQuestions, resumeSourceLines, sourceLinesToPrompt, textSourceLines, verifyCitations } from "./source";

function sampleDoc() {
  const d = emptyResumeDocument();
  d.basics.headline = "5년 차 백엔드 개발자";
  d.summary = "결제 시스템을 운영했습니다.\n장애 대응 경험이 있습니다.";
  d.highlights = [{ title: "결제 API p95 800ms → 320ms", context: "[ADD: 측정 기간]" }];
  d.experience = [{ ...EMPTY_RESUME_ITEM.experience(), company: "페이랩", title: "백엔드", bullets: ["정산 배치를 Kotlin으로 재작성", ""] }];
  d.projects = [{ ...EMPTY_RESUME_ITEM.project(), name: "정산 개편", problem: "배치가 4시간 걸렸다", result: "40분으로 단축" }];
  return d;
}

describe("근거 줄", () => {
  it("이력서 문서를 r1부터 순서대로 펼치고 빈 칸·[ADD]만 있는 칸은 뺀다", () => {
    const lines = resumeSourceLines(sampleDoc());
    expect(lines.map((l) => l.id)).toEqual(["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
    expect(lines.map((l) => l.path)).toEqual([
      "basics.headline",
      "summary.0",
      "summary.1",
      "highlights.0.title",
      "experience.0.bullets.0",
      "projects.0.problem",
      "projects.0.result",
    ]);
    expect(lines[4]!.label).toBe("경력 · 페이랩 백엔드 · 기여 1");
    expect(lines.every((l) => l.doc === "resume")).toBe(true);
  });

  it("긴 글은 짧은 줄을 붙이고 예산을 넘으면 truncated", () => {
    const text = ["짧다", "이 문단은 사십 자를 넘기기 위해 조금 길게 쓴 포트폴리오 문장입니다. 문제와 행동과 결과.", "x".repeat(50)].join("\n");
    const { lines, truncated } = textSourceLines("portfolio", text);
    expect(lines[0]!.id).toBe("p1");
    expect(lines[0]!.text.startsWith("짧다 이 문단은")).toBe(true);
    expect(truncated).toBe(false);
    const cut = textSourceLines("posting", text, { maxChars: 60 });
    expect(cut.lines.map((l) => l.id)).toEqual(["j1"]);
    expect(cut.truncated).toBe(true);
  });

  it("프롬프트 표 형식", () => {
    const lines = resumeSourceLines(sampleDoc()).slice(0, 1);
    expect(sourceLinesToPrompt(lines)).toBe("[r1] (지원 직무) 5년 차 백엔드 개발자");
  });

  it("지원 직무(basics.headline)와 한 줄 소개(basics.tagline)를 따로 근거 줄로 낸다", () => {
    const d = sampleDoc();
    d.basics.headline = "백엔드 개발자";
    d.basics.tagline = "결제 시스템을 5년간 운영해 온 백엔드 개발자";
    const lines = resumeSourceLines(d).slice(0, 3);
    expect(lines.map((l) => [l.path, l.label])).toEqual([
      ["basics.headline", "지원 직무"],
      ["basics.tagline", "한 줄 소개"],
      ["summary.0", "요약 1"],
    ]);
  });
});

describe("인용 검증·질문 정리", () => {
  const lines = resumeSourceLines(sampleDoc());

  it("모르는 ref는 버리고, 공백·문장부호를 무시하고 글자 그대로면 verified", () => {
    const cs = verifyCitations(
      [
        { ref: "[r5]", quote: "정산 배치를  Kotlin으로" },
        { ref: "r5", quote: "중복" },
        { ref: "r4", quote: "p95 900ms" },
        { ref: "r99", quote: "없는 줄" },
      ],
      lines,
    );
    expect(cs).toEqual([
      { ref: "r5", doc: "resume", quote: "정산 배치를 Kotlin으로", verified: true },
      { ref: "r4", doc: "resume", quote: "p95 900ms", verified: false },
    ]);
  });

  it("근거가 필요한 분류는 확인된 인용이 없으면(지어낸 quote만 있어도) 버리고, 중복 질문·facet을 정리한다", () => {
    const output: InterviewQuestionsOutput = {
      questions: [
        { category: "line", facet: "why", question: "왜 재작성했나요?", intent: "필요성", citations: [{ ref: "r5", quote: "정산 배치" }], followUps: ["  누가 정했나요? ", ""] },
        { category: "line", facet: "why", question: "왜  재작성했나요?", intent: "중복", citations: [{ ref: "r5", quote: "정산" }], followUps: [] },
        { category: "pivot", facet: "Z", question: "지표는?", intent: "", citations: [{ ref: "r4", quote: "p95" }], followUps: [] },
        { category: "tough", facet: "number", question: "근거 없는 질문", intent: "", citations: [{ ref: "r99", quote: "x" }], followUps: [] },
        { category: "project", facet: "result", question: "지어낸 인용 질문", intent: "", citations: [{ ref: "r5", quote: "트래픽 10배 대응" }], followUps: [] },
        { category: "line", facet: "why", question: "빈 인용 질문", intent: "", citations: [{ ref: "r4", quote: "x없는말" }, { ref: "r5", quote: "" }], followUps: [] },
        { category: "job", facet: "why", question: "이 직무에서 중요한 것은?", intent: "", citations: [], followUps: [] },
      ],
      notes: [],
    };
    const qs = normalizeGeneratedQuestions(output, lines);
    expect(qs.map((q) => [q.category, q.facet, q.question])).toEqual([
      ["line", "why", "왜 재작성했나요?"],
      ["pivot", null, "지표는?"],
      ["line", "why", "빈 인용 질문"],
      ["job", null, "이 직무에서 중요한 것은?"],
    ]);
    // 확인된 인용이 앞, 확인 안 된 인용은 뒤(보조). 빈 quote는 줄 본문으로 채워 verified.
    expect(qs[2]!.citations.map((c) => [c.ref, c.verified])).toEqual([
      ["r5", true],
      ["r4", false],
    ]);
    expect(qs[0]!.followUps).toEqual(["누가 정했나요?"]);
    expect(normalizeFacet("pivot", "O")).toBe("O");
  });

  it("말하기 시간 추정(초당 5자, 공백 제외)", () => {
    expect(estimateSpokenSeconds("가".repeat(150) + "   ")).toBe(30);
  });
});

describe("가짜 LLM — 면접 task", () => {
  const llm = new FakeLlmClient({ delayMs: 0 });
  const lines = resumeSourceLines(sampleDoc());
  const user = wrapData(CHAT_TAGS.interviewSources, sourceLinesToPrompt(lines));

  it("interview-questions: 근거 줄을 인용한 질문을 스키마대로 낸다", async () => {
    const { output } = await llm.generate({ system: "s", effort: "low", task: "interview-questions", user, schema: InterviewQuestionsOutputSchema });
    const qs = normalizeGeneratedQuestions(output, lines);
    expect(qs.length).toBeGreaterThanOrEqual(4);
    expect(qs.filter((q) => q.category === "line").every((q) => q.citations[0]?.verified)).toBe(true);
  });

  it("interview-feedback: 다섯 기준과 모범 답변 개요", async () => {
    const u = `${user}\n${wrapData(CHAT_TAGS.interviewAnswer, "제가 직접 배치를 나눠 4시간을 40분으로 줄였습니다.")}`;
    const { output } = await llm.generate({ system: "s", effort: "low", task: "interview-feedback", user: u, schema: InterviewFeedbackOutputSchema });
    expect(Object.keys(output.criteria).sort()).toEqual(["evidence", "length", "numbers", "ownership", "structure"]);
    expect(output.modelAnswer.points[0]!.ref).toBe("r1");
    expect(output.criteria.numbers.score).toBe(4);
  });
});
