import { describe, expect, it } from "vitest";
import { CHAT_TAGS, GraphChatOutputSchema, ReviewerChatOutputSchema } from "@/lib/domain/chat";
import { toGraphOps } from "@/lib/domain/graph";
import { ResumeDraftOutputSchema, ResumeDocumentSchema } from "@/lib/domain/resumes";
import { PostingFactsSchema } from "@/lib/domain/postings";
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

  it("posting-extract: 회사·직무가 없는 페이지는 공고가 아니다", async () => {
    const user = wrapData(CHAT_TAGS.postingPage, "로그인이 필요합니다\n채용 공고 목록");
    const { output } = await llm.generate({ ...base, task: "posting-extract", user, schema: PostingFactsSchema });
    expect(output.isJobPosting).toBe(false);
    expect(output.company).toBe("");
  });
});
