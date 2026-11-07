import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { RESUME_TEMPLATES } from "@/lib/domain/resumes";
import { NewResumeForm, type PostingPickOption } from "./NewResumeForm";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const P1: PostingPickOption = { id: "p1", company: "토스", roleTitle: "Server Developer", status: "saved", deadline: "", updatedAt: 1 };
const P2: PostingPickOption = { id: "p2", company: "당근", roleTitle: "iOS 개발자", status: "reviewing", deadline: "", updatedAt: 2 };

describe("NewResumeForm", () => {
  it("첫 단계에서는 양식을 고르지 않는다(편집 화면에서 고름)", () => {
    const html = renderToStaticMarkup(<NewResumeForm providers={[]} defaultProvider={null} graphAvailable={false} diagnoses={[]} />);
    expect(html).toContain("지원할 자리");
    expect(html).not.toContain('name="template"');
    expect(html).not.toContain(">양식</legend>");
    for (const t of Object.values(RESUME_TEMPLATES)) expect(html).not.toContain(t.description);
    expect(html).toContain("편집) 위쪽에서 고르고");
  });

  it("회사·직무·JD 입력 칸이 없고, 보관함·링크·공용 이력서 세 가지로 지원 대상을 고른다", () => {
    const html = renderToStaticMarkup(
      <NewResumeForm providers={[]} defaultProvider={null} graphAvailable={false} diagnoses={[]} postings={[P1, P2]} />,
    );
    expect(html).not.toContain('id="company"');
    expect(html).not.toContain('id="roleTitle"');
    expect(html).not.toContain('id="jdText"');
    expect(html).toContain("내 보관함에서");
    expect(html).toContain("공고 링크로");
    expect(html).toContain("공용 이력서");
    // 보관함 모드가 기본이고 공고 목록이 보인다.
    expect(html).toContain("보관함 공고 검색");
    expect(html).toContain("토스");
  });

  it("?postingId로 온 공고는 미리 골라져 있다", () => {
    const html = renderToStaticMarkup(
      <NewResumeForm providers={[]} defaultProvider={null} graphAvailable={false} diagnoses={[]} postings={[P1, P2]} posting={P2} />,
    );
    expect(html).toContain("고른 공고");
    expect(html).toContain("당근 · iOS 개발자");
  });

  it("공용 이력서가 있으면 '공용 이력서 내용으로 시작'을 고를 수 있고, ?from이면 그것이 기본 출처다", () => {
    const html = renderToStaticMarkup(
      <NewResumeForm
        providers={[]}
        defaultProvider={null}
        graphAvailable={false}
        diagnoses={[]}
        postings={[P1]}
        generalResumes={[{ id: "g1", title: "내 마스터 이력서", updatedAt: 1 }]}
        sourceResumeId="g1"
      />,
    );
    expect(html).toContain("공용 이력서 내용으로 시작");
    expect(html).toMatch(/checked="" value="copy"/);
    expect(html).toContain("내 마스터 이력서");
    expect(html).toContain("복사해서 만들기");
  });
});

describe("searchPostingOptions", () => {
  it("회사·직무 부분 일치(대소문자 무시), 빈 검색은 전체", async () => {
    const { searchPostingOptions } = await import("./NewResumeForm");
    expect(searchPostingOptions([P1, P2], "").map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(searchPostingOptions([P1, P2], "ios").map((p) => p.id)).toEqual(["p2"]);
    expect(searchPostingOptions([P1, P2], "server").map((p) => p.id)).toEqual(["p1"]);
    expect(searchPostingOptions([P1, P2], "카카오")).toEqual([]);
  });
});

describe("createResumeRequestBody", () => {
  it("공고 대상: 회사·직무·JD는 비워 보내고 postingId로 서버가 채운다(기본 양식은 성과 중심)", async () => {
    const { CreateResumeInputSchema } = await import("@/lib/resumes/types");
    const { DEFAULT_RESUME_TEMPLATE } = await import("@/lib/domain/resumes");
    const { withResumePostingDefaults } = await import("@/lib/postings/defaults");
    const { createResumeRequestBody } = await import("./NewResumeForm");
    const body = createResumeRequestBody({
      target: { kind: "posting", postingId: "p1" },
      source: "diagnosis",
      diagnosisId: "d1",
      provider: null,
      sourceResumeId: null,
    });
    expect(DEFAULT_RESUME_TEMPLATE).toBe("performance");
    expect(body).toMatchObject({ kind: "company", company: "", roleTitle: "", postingId: "p1", templateId: "performance", sourceResumeId: null });
    expect(body.source).toEqual({ kind: "diagnosis", diagnosisId: "d1" });
    // 서버가 공고 값으로 채운 뒤 검증을 통과한다.
    const filled = withResumePostingDefaults(body, { id: "p1", company: "토스", roleTitle: "Server", jdText: "JD" });
    expect(CreateResumeInputSchema.parse(filled)).toMatchObject({ company: "토스", roleTitle: "Server", jdText: "JD", postingId: "p1" });
    // 채우지 않으면(공고 없음) 회사 필수로 거절된다.
    expect(CreateResumeInputSchema.safeParse(body).success).toBe(false);
  });

  it("공용 이력서: kind general, postingId 없음, 회사 없이 통과", async () => {
    const { CreateResumeInputSchema } = await import("@/lib/resumes/types");
    const { createResumeRequestBody } = await import("./NewResumeForm");
    const body = createResumeRequestBody({ target: { kind: "general" }, source: "blank", diagnosisId: "", provider: "anthropic", sourceResumeId: null });
    expect(body).toMatchObject({ kind: "general", postingId: null, source: { kind: "blank" } });
    expect(CreateResumeInputSchema.parse(body).kind).toBe("general");
  });

  it("공용 이력서 내용으로 시작: sourceResumeId를 싣고 AI 엔진은 보내지 않는다", async () => {
    const { createResumeRequestBody } = await import("./NewResumeForm");
    const body = createResumeRequestBody({
      target: { kind: "posting", postingId: "p1" },
      source: "copy",
      diagnosisId: "",
      provider: "anthropic",
      sourceResumeId: "g1",
    });
    expect(body).toMatchObject({ sourceResumeId: "g1", provider: null, source: { kind: "blank" } });
  });
});

describe("작성 방식(그래프 이력서 에이전트)", () => {
  it("그래프를 쓸 수 있고 에이전트가 켜져 있으면 'AI 에이전트로 작성'이 기본 선택, 꺼져 있으면 선택지를 숨긴다", () => {
    const on = renderToStaticMarkup(<NewResumeForm providers={[]} defaultProvider={null} graphAvailable agentAvailable diagnoses={[]} />);
    expect(on).toContain("AI 에이전트로 작성 (권장)");
    expect(on).toContain(`name="writeMode" checked="" value="agent"`);
    expect(on).toContain("하루 5회");
    const off = renderToStaticMarkup(<NewResumeForm providers={[]} defaultProvider={null} graphAvailable diagnoses={[]} />);
    expect(off).not.toContain("AI 에이전트로 작성");
  });

  it("요청 본문: 그래프 출처일 때만 mode를 싣는다", async () => {
    const { createResumeRequestBody } = await import("./NewResumeForm");
    const graph = createResumeRequestBody({ target: { kind: "general" }, source: "graph", diagnosisId: "", provider: "anthropic", sourceResumeId: null, writeMode: "agent" });
    expect(graph.mode).toBe("agent");
    const diag = createResumeRequestBody({ target: { kind: "general" }, source: "diagnosis", diagnosisId: "d1", provider: "anthropic", sourceResumeId: null, writeMode: "agent" });
    expect(diag).not.toHaveProperty("mode");
  });
});
