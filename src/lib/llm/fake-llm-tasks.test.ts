import { describe, expect, it } from "vitest";
import {
  CHAT_TAGS,
  GraphChatOutputSchema,
  GraphImportOutputSchema,
  GraphQaOutputSchema,
  GraphQaRerankSchema,
  ReviewerChatOutputSchema,
} from "@/lib/domain/chat";
import { toGraphOps } from "@/lib/domain/graph";
import { ResumeDraftOutputSchema, ResumeDocumentSchema } from "@/lib/domain/resumes";
import { PostingSectionsOnlySchema } from "@/lib/domain/posting-structure";
import { PostingExtractSchema, PostingFactsSchema } from "@/lib/domain/postings";
import { field, wrapData } from "@/lib/chat/prompt";
import { FakeLlmClient } from "@/test/fake-llm";

const llm = new FakeLlmClient({ delayMs: 0 });
const base = { system: "s", effort: "low" as const };

describe("가짜 LLM — 파이프라인 밖 task", () => {
  it("graph-chat: 메시지에서 경험·기술 변경안을 만든다", async () => {
    const user = wrapData(CHAT_TAGS.latestMessage, "페이랩에서 Kotlin으로 정산 배치를 개편했어요");
    const { output } = await llm.generate({ ...base, task: "graph-chat", user, schema: GraphChatOutputSchema });
    const { ops, errors } = toGraphOps(output.ops);
    expect(errors).toEqual([]);
    expect(ops.map((o) => o.op)).toEqual(["addNode", "addEdge", "addNode", "addEdge"]);
    expect(output.followUpQuestions.length).toBeGreaterThan(0);
  });

  it("reviewer-chat: 이력서 줄을 인용한 수정 제안", async () => {
    const resume = "홍길동\n결제 API를 Kotlin으로 개발했다\n정산 배치 처리 시간을 단축했다";
    const user = [field("심사위원", "팀장"), wrapData(CHAT_TAGS.resume, resume)].join("\n");
    const { output } = await llm.generate({ ...base, task: "reviewer-chat", user, schema: ReviewerChatOutputSchema });
    expect(resume).toContain(output.suggestedEdits[0]!.before!);
    expect(output.reply).toContain("팀장");
  });

  it("resume-draft: 스키마에 맞는 문서", async () => {
    const user = [field("지원 회사", "토스"), field("지원 직무", "백엔드"), wrapData(CHAT_TAGS.resume, "홍길동\n결제 API 개발")].join("\n");
    const { output } = await llm.generate({ ...base, task: "resume-draft", user, schema: ResumeDraftOutputSchema });
    expect(ResumeDocumentSchema.parse(output.document).basics.name).toBe("홍길동");
    expect(output.document.summary).toContain("토스");
  });

  it("posting-extract: 본문 줄을 근거로 회사·직무·마감을 뽑는다", async () => {
    const page = "회사: 페이랩\n모집 직무: 백엔드 개발자\n근무지: 서울 강남구\n정규직 · 경력 3년 이상\n접수 마감: 2026.11.20 18:00까지";
    const user = [field("공고 주소", "https://example.com/jobs/1"), wrapData(CHAT_TAGS.postingPage, page)].join("\n");
    const { output } = await llm.generate({ ...base, task: "posting-extract", user, schema: PostingFactsSchema });
    expect(output).toMatchObject({
      isJobPosting: true,
      company: "페이랩",
      roleTitle: "백엔드 개발자",
      employmentType: "full_time",
      careerLevel: "experienced",
      location: "서울 강남구",
      deadline: "2026-11-20",
      deadlineTime: "18:00",
    });
    for (const quote of [output.companyEvidence, output.roleEvidence, output.deadlineEvidence]) expect(page).toContain(quote);
  });

  it("posting-extract: 구역 제목 아래 줄을 그대로 복사한다(사실+구역, 구역만 둘 다)", async () => {
    const page = "회사: 페이랩\n모집 직무: 백엔드 개발자\n주요 업무\n- 결제 API 개발\n자격 요건\n- Python 3년 이상\n우대 사항\n- Kafka 경험\n연봉: 회사 내규";
    const user = wrapData(CHAT_TAGS.postingPage, page);
    const { output } = await llm.generate({ ...base, task: "posting-extract", user, schema: PostingExtractSchema });
    expect(output.sections).toMatchObject({ duties: ["결제 API 개발"], requirements: ["Python 3년 이상"], preferred: ["Kafka 경험"], salary: "회사 내규" });
    const only = await llm.generate({ ...base, task: "posting-extract", user, schema: PostingSectionsOnlySchema });
    expect(only.output.sections.requirements).toEqual(["Python 3년 이상"]);
    expect(only.output).not.toHaveProperty("company");
  });

  it("posting-extract: 회사·직무가 없는 페이지는 공고가 아니다", async () => {
    const user = wrapData(CHAT_TAGS.postingPage, "로그인이 필요합니다\n채용 공고 목록");
    const { output } = await llm.generate({ ...base, task: "posting-extract", user, schema: PostingFactsSchema });
    expect(output.isJobPosting).toBe(false);
    expect(output.company).toBe("");
  });

  it("graph-import: 문서의 회사·직무·프로젝트·성과·기술 줄로 변경안", async () => {
    const user = wrapData(CHAT_TAGS.resume, "회사: 페이랩\n직무: 백엔드 개발자\n프로젝트: 결제 개선\n성과: 6시간→40분\nGo, Kafka");
    const { output } = await llm.generate({ ...base, task: "graph-import", user, schema: GraphImportOutputSchema });
    const { ops, errors } = toGraphOps(output.ops, { max: 150 });
    expect(errors).toEqual([]);
    expect(ops.filter((o) => o.op === "addNode").map((o) => (o as { label: string }).label)).toEqual([
      "Company",
      "Role",
      "Project",
      "Achievement",
      "Skill",
      "Skill",
    ]);
  });

  it("graph-qa: 출처 [1]·[2]를 인용하고, 출처가 없으면 insufficient", async () => {
    const user = [wrapData(CHAT_TAGS.graphSources, "[1] 성과 · 6시간→40분\n경로: 나\n\n[2] 프로젝트 · 결제 개선"), wrapData(CHAT_TAGS.latestMessage, "성과?")].join("\n");
    const { output } = await llm.generate({ ...base, task: "graph-qa", user, schema: GraphQaOutputSchema });
    expect(output).toMatchObject({ usedSources: [1, 2], insufficient: false });
    expect(output.answer).toContain("[1]");
    const none = await llm.generate({ ...base, task: "graph-qa", user: wrapData(CHAT_TAGS.graphSources, "그래프 개요: 회사 0"), schema: GraphQaOutputSchema });
    expect(none.output.insufficient).toBe(true);
  });

  it("graph-qa-rerank: 후보 순서를 관련도로", async () => {
    const user = wrapData(CHAT_TAGS.graphSources, Array.from({ length: 8 }, (_, i) => `[c${i + 1}] 후보 ${i + 1}`).join("\n"));
    const { output } = await llm.generate({ ...base, task: "graph-qa-rerank", user, schema: GraphQaRerankSchema });
    expect(output.ratings.map((r) => r.relevance)).toEqual([3, 3, 3, 2, 2, 2, 1, 1]);
  });
});
