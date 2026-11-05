/**
 * URL 가져오기 경로(인터넷에 접속하지 않음 — DNS·연결 함수를 가짜로 주입): 공개 주소 검사, DNS 고정·리다이렉트 재검사,
 * 페이지 본문 추출, LLM 출력 근거 검증. 사례 일부는 CareerLoop(src/server/postingImport/import.test.ts)에서 가져옴.
 */
import { describe, expect, it, vi } from "vitest";
import type { PostingSectionsLlm } from "@/lib/domain/posting-structure";
import type { PostingExtract } from "@/lib/domain/postings";
import type { GenerateResult, LlmClient, LlmRequest } from "@/lib/llm/types";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const { fetchPostingPage, isPublicAddress, publicTarget, PostingFetchError, MAX_PAGE_BYTES } = await import("./fetch");
const { postingPageText, DATA_SCAN_LIMITS } = await import("./page-text");
const { extractPosting, postingFromFacts, PostingExtractError, postingUserPrompt } = await import("./extract");

const html = (body: string) => ({
  status: 200,
  headers: { "content-type": "text/html; charset=utf-8" },
  body: new TextEncoder().encode(body),
});

describe("공개 주소 검사", () => {
  it.each([
    "127.0.0.1",
    "10.2.3.4",
    "169.254.169.254",
    "172.17.0.1",
    "192.168.1.1",
    "100.64.0.1",
    "100.101.102.103",
    "100.127.255.254",
    "::1",
    "::ffff:127.0.0.1",
    "fc00::1",
    "fd12:3456::1",
    "fe80::1",
    "2001:db8::1",
    "0.0.0.0",
    "not-an-ip",
  ])("내부·특수 주소 거절: %s", (ip) => expect(isPublicAddress(ip)).toBe(false));

  it("공개 IPv4·IPv6는 허용한다", () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("100.128.0.1")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("DNS 응답 중 하나라도 내부 주소이면 거절한다", async () => {
    const lookup = async () => [
      { address: "8.8.8.8", family: 4 },
      { address: "127.0.0.1", family: 4 },
    ];
    await expect(publicTarget("https://example.org", lookup)).rejects.toThrow("공개된");
  });

  it("IP 리터럴 주소도 같은 규칙으로 검사한다", async () => {
    await expect(publicTarget("http://169.254.169.254/latest/meta-data", async () => [])).rejects.toBeInstanceOf(PostingFetchError);
    await expect(publicTarget("http://[fd00::1]/", async () => [])).rejects.toBeInstanceOf(PostingFetchError);
  });
});

describe("fetchPostingPage(가짜 연결)", () => {
  const publicLookup = async (host: string) => [{ address: host === "evil.example" ? "10.0.0.5" : "93.184.216.34", family: 4 }];

  it("검사한 주소로만 연결하고(DNS 고정) HTML을 돌려준다", async () => {
    const connect = vi.fn(async () => html("<p>공고</p>"));
    const page = await fetchPostingPage("https://jobs.example/1", { lookup: publicLookup, connect });
    expect(page).toEqual({ url: "https://jobs.example/1", html: "<p>공고</p>" });
    expect(connect).toHaveBeenCalledWith(
      expect.objectContaining({ address: { address: "93.184.216.34", family: 4 } }),
      expect.objectContaining({ maxBytes: MAX_PAGE_BYTES }),
    );
  });

  it("리다이렉트마다 주소를 다시 검사한다(내부 주소로 이동 거절)", async () => {
    const connect = vi.fn(async ({ url }: { url: URL }) =>
      url.hostname === "jobs.example" ? { status: 302, headers: { location: "https://evil.example/admin" }, body: new Uint8Array() } : html("x"),
    );
    await expect(fetchPostingPage("https://jobs.example/1", { lookup: publicLookup, connect })).rejects.toThrow("공개된");
    expect(connect).toHaveBeenCalledTimes(1);
  });

  it("리다이렉트는 3회까지만 따라간다", async () => {
    let n = 0;
    const connect = vi.fn(async () => ({ status: 301, headers: { location: `/r${++n}` }, body: new Uint8Array() }));
    await expect(fetchPostingPage("https://jobs.example/1", { lookup: publicLookup, connect })).rejects.toThrow("이동이 반복");
    expect(connect).toHaveBeenCalledTimes(4);
  });

  it("상대 경로 리다이렉트를 따라가 최종 주소를 돌려준다", async () => {
    const connect = vi.fn(async ({ url }: { url: URL }) =>
      url.pathname === "/old" ? { status: 308, headers: { location: "/new" }, body: new Uint8Array() } : html("ok"),
    );
    expect((await fetchPostingPage("https://jobs.example/old", { lookup: publicLookup, connect })).url).toBe("https://jobs.example/new");
  });

  it("HTML이 아닌 응답·오류 상태는 사용자용 문구로 거절한다", async () => {
    const pdf = async () => ({ status: 200, headers: { "content-type": "application/pdf" }, body: new Uint8Array([1]) });
    await expect(fetchPostingPage("https://jobs.example/a.pdf", { lookup: publicLookup, connect: pdf })).rejects.toThrow("파일·이미지");
    const gone = async () => ({ status: 404, headers: {}, body: new Uint8Array() });
    await expect(fetchPostingPage("https://jobs.example/x", { lookup: publicLookup, connect: gone })).rejects.toThrow("사라졌습니다");
  });

  it("연결 오류의 내부 내용은 드러내지 않는다", async () => {
    const connect = async () => {
      throw new Error("connect ECONNREFUSED INTERNAL_SECRET");
    };
    const err = await fetchPostingPage("https://jobs.example/x", { lookup: publicLookup, connect }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PostingFetchError);
    expect((err as Error).message).not.toContain("INTERNAL_SECRET");
  });

  it("charset이 EUC-KR이면 그대로 디코드하고, 모르는 charset은 UTF-8로 읽는다", async () => {
    const euckr = new Uint8Array([0xc7, 0xd1, 0xb1, 0xdb]); // "한글"
    const a = await fetchPostingPage("https://jobs.example/k", {
      lookup: publicLookup,
      connect: async () => ({ status: 200, headers: { "content-type": "text/html; charset=euc-kr" }, body: euckr }),
    });
    expect(a.html).toBe("한글");
    const b = await fetchPostingPage("https://jobs.example/k", {
      lookup: publicLookup,
      connect: async () => ({ status: 200, headers: { "content-type": "text/html; charset=x-unknown" }, body: new TextEncoder().encode("공고") }),
    });
    expect(b.html).toBe("공고");
  });
});

describe("postingPageText", () => {
  it("스크립트·스타일을 버리고 JobPosting JSON-LD를 읽기 쉬운 줄로 앞에 둔다", () => {
    const text = postingPageText(
      '<script>STEAL_SECRET</script><style>HIDDEN_STYLE</style><nav>메뉴</nav><h1>본문</h1>' +
        '<script type="application/ld+json">{"@graph":[{"@type":"JobPosting","title":"Engineer","hiringOrganization":{"name":"예시금융"},' +
        '"validThrough":"2026-09-14T10:00:00+09:00","description":"<p>Python 개발</p><ul><li>필수: 3년</li></ul>"}]}</script>',
    );
    expect(text.startsWith("직무: Engineer\n회사: 예시금융")).toBe(true);
    expect(text).toContain("마감: 2026-09-14T10:00:00+09:00");
    expect(text).toContain("Python 개발\n필수: 3년");
    expect(text).toContain("본문");
    expect(text).not.toContain("STEAL_SECRET");
    expect(text).not.toContain("HIDDEN_STYLE");
    expect(text).not.toContain("메뉴");
  });

  it("깨진 JSON-LD는 무시하고 블록 경계에서 줄을 나눈다", () => {
    expect(postingPageText('<script type="application/ld+json">{깨짐</script><div>회사: 가</div><div>직무: 나</div>')).toBe("회사: 가\n직무: 나");
  });

  it("JD 상한(30,000자)에서 자른다", () => {
    expect(postingPageText(`<p>${"가".repeat(40_000)}</p>`).length).toBe(30_000);
  });

  it("h3 제목·구역 제목 strong은 따로 한 줄이 된다", () => {
    const text = postingPageText("<div>소개 문장<h3>자격 요건</h3>Python 경험</div><p><strong>우대 사항</strong> AWS 경험</p><p>여기는 <b>강조</b> 문장</p>");
    expect(text).toContain("소개 문장\n자격 요건\nPython 경험");
    expect(text).toContain("우대 사항\nAWS 경험");
    expect(text).toContain("여기는 강조 문장");
  });

  it("__NEXT_DATA__의 화이트리스트 키를 제목 줄로 바꿔 JSON-LD 뒤, 본문 앞에 둔다", () => {
    const data = {
      props: {
        pageProps: {
          job: {
            detail: {
              main_tasks: "• 결제 API 개발\n• 정산 배치 운영",
              requirements: "• Python 3년 이상",
              preferred_points: "• Kafka 경험",
              benefits: "• 식대 지원",
              skill_tags: [{ title: "Python" }, { title: "Kafka" }],
              secret_token: "DO_NOT_LEAK",
            },
          },
        },
      },
    };
    const text = postingPageText(
      '<script type="application/ld+json">{"@type":"JobPosting","title":"Backend"}</script>' +
        `<script id="__NEXT_DATA__" type="application/json">${JSON.stringify(data)}</script><p>본문</p>`,
    );
    expect(text.startsWith("직무: Backend")).toBe(true);
    expect(text).toContain("주요 업무\n• 결제 API 개발\n• 정산 배치 운영");
    expect(text).toContain("자격 요건\n• Python 3년 이상");
    expect(text).toContain("우대 사항\n• Kafka 경험");
    expect(text).toContain("기술 스택\nPython\nKafka");
    expect(text.indexOf("주요 업무")).toBeLessThan(text.indexOf("본문"));
    expect(text).not.toContain("DO_NOT_LEAK");
  });

  it("페이지 데이터: 깨진 JSON은 무시하고, 노드·길이 상한을 지킨다", () => {
    expect(postingPageText('<script id="__NEXT_DATA__" type="application/json">{깨짐</script><p>본문</p>')).toBe("본문");
    const many = { items: Array.from({ length: 5000 }, (_, i) => ({ main_tasks: `업무 ${i}번 항목` })) };
    const text = postingPageText(`<script type="application/json">${JSON.stringify(many)}</script>`);
    expect(text.split("주요 업무").length - 1).toBeLessThan(DATA_SCAN_LIMITS.nodes);
    const long = { main_tasks: "가".repeat(40_000) };
    expect(postingPageText(`<script type="application/json">${JSON.stringify(long)}</script>`).length).toBeLessThanOrEqual(DATA_SCAN_LIMITS.chars);
  });
});

/** 정해진 facts를 돌려주는 가짜 LLM(근거 검증 분기 시험용). */
function stubLlm(facts: PostingExtract): LlmClient & { calls: LlmRequest<unknown>[] } {
  const calls: LlmRequest<unknown>[] = [];
  return {
    name: "stub",
    calls,
    async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
      calls.push(req as LlmRequest<unknown>);
      return { output: req.schema.parse(facts), usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "stub" };
    },
  };
}

const pageText = [
  "예시금융 Backend Engineer 채용",
  "2026년 신입 채용. 2026-09-14 10:00 KST 마감.",
  "Python 개발 업무 및 검증 가능한 시스템 설계 경험을 모집합니다. 필수자격은 Python 개발 경험입니다.",
  "우대사항은 운영 장애 복구 경험입니다. 서울 근무, 근무 형태 미명시. 신청 방법은 공개 채용 홈페이지를 이용하세요.",
].join("\n");
const noSections: PostingSectionsLlm = {
  companyIndustry: "",
  companySize: "",
  companyIntro: [],
  summary: "",
  duties: [],
  requirements: [],
  preferred: [],
  techStack: [],
  salary: "",
  workHours: "",
  conditionsOther: [],
  benefits: [],
  process: [],
  documents: [],
  applyMethod: [],
  notes: [],
};
const facts: PostingExtract = {
  isJobPosting: true,
  company: "예시금융",
  companyEvidence: "예시금융",
  roleTitle: "Backend Engineer",
  roleEvidence: "Backend Engineer",
  employmentType: "unknown",
  workType: "unknown",
  location: "서울",
  careerLevel: "unknown",
  deadline: "2026-09-14",
  deadlineTime: "10:00",
  deadlineEvidence: "2026-09-14 10:00 KST 마감",
  rolling: false,
  sections: noSections,
};
const page = { url: "https://example.org/job", pageText };

describe("extractPosting 근거 검증", () => {
  it("프롬프트: system에 인젝션 규칙, user에 주소 필드와 <posting_page> 태그", async () => {
    const llm = stubLlm(facts);
    await extractPosting(page, llm);
    const req = llm.calls[0]!;
    expect(req.task).toBe("posting-extract");
    expect(req.system).toContain("<posting_page>");
    expect(req.user).toBe(postingUserPrompt(page.url, pageText));
    expect(req.user).toContain("- 공고 주소: https://example.org/job");
  });

  it("프롬프트: 구역 규칙(원문 복사·자격/우대 구분·절차 순서)이 들어 있다", async () => {
    const llm = stubLlm(facts);
    await extractPosting(page, llm);
    const req = llm.calls[0]!;
    expect(req.system).toContain("한 줄에 하나씩 그대로 복사");
    expect(req.system).toContain("자격과 우대를 섞지 않는다");
    expect(req.system).toContain("단계 순서대로");
    expect(req.system).not.toContain("note는");
    expect(req.maxTokens).toBe(24_000);
  });

  it("구조가 얇으면 jdText에 원문을 그대로 두고, sourceText에도 원문을 둔다(메모는 비운다)", async () => {
    const { posting, structure, sourceText } = await extractPosting(page, stubLlm(facts));
    expect(sourceText).toBe(pageText);
    expect(posting.jdText).toBe(pageText);
    expect(posting.note).toBe("");
    expect(structure).toMatchObject({ source: "llm", jdComposed: false });
  });

  it("구조가 충분하면 jdText는 제목 붙은 구역 텍스트, 원문은 sourceText", async () => {
    const text = [
      "회사: 페이랩",
      "주요 업무",
      "- 결제 API 설계와 운영",
      "- 정산 배치 개선",
      "자격 요건",
      "- Python 3년 이상 경험",
      "- SQL 사용 경험",
      "우대 사항",
      "- Kubernetes 운영 경험",
      "복리후생",
      "- 식대 지원",
    ].join("\n");
    const sections: PostingSectionsLlm = {
      ...noSections,
      duties: ["결제 API 설계와 운영", "정산 배치 개선"],
      requirements: ["Python 3년 이상 경험", "SQL 사용 경험", "본문에 없는 지어낸 요건"],
      preferred: ["Kubernetes 운영 경험"],
      benefits: ["식대 지원"],
    };
    const out = postingFromFacts({ ...facts, companyEvidence: "페이랩", company: "페이랩", roleEvidence: "결제 API", roleTitle: "결제 API", deadlineEvidence: "", deadline: "", deadlineTime: "", sections }, { url: page.url, pageText: text });
    expect(out.sourceText).toBe(text);
    expect(out.structure.jdComposed).toBe(true);
    expect(out.structure.requirements).toEqual(["Python 3년 이상 경험", "SQL 사용 경험"]);
    expect(out.posting.jdText).toContain("자격 요건\n- Python 3년 이상 경험");
    expect(out.posting.jdText).toContain("우대 사항\n- Kubernetes 운영 경험");
    expect(out.posting.jdText).not.toContain("회사: 페이랩");
  });

  it("구역 항목이 길이·개수 안내를 넘어도 가져오기는 성공하고, 근거 검증 뒤 상한대로 자른다", async () => {
    const longIntro = `예시금융은 ${"결제와 정산 인프라를 만드는 회사입니다 ".repeat(16).trim()}`;
    const text = `${pageText}\n${longIntro}`;
    expect(longIntro.length).toBeGreaterThan(300);
    const many = Array.from({ length: 30 }, () => "Python 개발 업무");
    const { structure } = await extractPosting(
      { url: page.url, pageText: text },
      stubLlm({ ...facts, sections: { ...noSections, companyIntro: [longIntro], requirements: many } }),
    );
    expect(structure.company.intro).toHaveLength(1);
    expect(structure.company.intro[0]!.length).toBeLessThanOrEqual(300);
    expect(longIntro.startsWith(structure.company.intro[0]!)).toBe(true);
    expect(structure.requirements).toEqual(["Python 개발 업무"]);
  });

  it("근거가 있는 회사·직무·날짜·시각을 저장한다", async () => {
    const { posting } = await extractPosting(page, stubLlm(facts));
    expect(posting).toMatchObject({
      company: "예시금융",
      roleTitle: "Backend Engineer",
      deadline: "2026-09-14",
      deadlineTime: "10:00",
      deadlineKind: "date",
      careerLevel: "unknown",
      workType: "unknown",
      jdText: pageText,
      url: "https://example.org/job",
    });
  });

  it("원문에 없는 회사·직무는 저장하지 않는다", async () => {
    await expect(extractPosting(page, stubLlm({ ...facts, companyEvidence: "없는 회사" }))).rejects.toThrow(PostingExtractError);
    await expect(extractPosting(page, stubLlm({ ...facts, roleEvidence: "Frontend" }))).rejects.toThrow("회사와 모집 직무");
  });

  it("목록·차단 페이지(isJobPosting=false)는 공고로 만들지 않는다", async () => {
    await expect(extractPosting(page, stubLlm({ ...facts, isJobPosting: false }))).rejects.toThrow(PostingExtractError);
  });

  it("마감 근거가 없거나 근거에 그 날짜가 없으면 빈 값, 상시로 추측하지 않는다", () => {
    expect(postingFromFacts({ ...facts, deadlineEvidence: "가짜 마감" }, page).posting).toMatchObject({ deadline: "", deadlineTime: "", deadlineKind: "unspecified" });
    expect(postingFromFacts({ ...facts, deadline: "2026-09-15" }, page).posting).toMatchObject({ deadline: "", deadlineKind: "unspecified" });
    expect(postingFromFacts({ ...facts, deadline: "2026-02-30" }, page).posting.deadline).toBe("");
  });

  it("시각 근거가 없으면 날짜만 쓴다", () => {
    const dateOnly = { ...page, pageText: pageText.replace("2026-09-14 10:00 KST 마감", "2026-09-14 마감") };
    expect(postingFromFacts({ ...facts, deadlineEvidence: "2026-09-14 마감" }, dateOnly).posting).toMatchObject({ deadline: "2026-09-14", deadlineTime: "" });
  });

  it("상시 채용은 본문에 그런 말이 있을 때만 인정한다", () => {
    const noDeadline = { ...facts, deadline: "", deadlineTime: "", deadlineEvidence: "", rolling: true };
    expect(postingFromFacts(noDeadline, page).posting.deadlineKind).toBe("unspecified");
    expect(postingFromFacts(noDeadline, { ...page, pageText: `${pageText}\n상시 채용` }).posting.deadlineKind).toBe("rolling");
  });

  it("본문이 너무 짧으면 LLM을 부르지 않고 실패한다", async () => {
    const llm = stubLlm(facts);
    await expect(extractPosting({ ...page, pageText: "로그인이 필요합니다" }, llm)).rejects.toThrow("공고 본문을 읽지 못했습니다");
    expect(llm.calls).toHaveLength(0);
  });

  it("테스트용 가짜 LLM: 본문의 '회사:'·'모집 직무:'·마감 줄로 추출하고, [가짜:근거없음]이면 근거 검증에 걸린다", async () => {
    const text = `회사: 페이랩\n모집 직무: 백엔드 개발자\n근무지: 서울 강남\n접수 마감: 2026.11.20 18:00\n${"정규직 채용입니다. ".repeat(12)}`;
    const { posting } = await extractPosting({ url: "https://jobs.example/1", pageText: text }, new FakeLlmClient());
    expect(posting).toMatchObject({ company: "페이랩", roleTitle: "백엔드 개발자", deadline: "2026-11-20", deadlineTime: "18:00", location: "서울 강남" });
    await expect(extractPosting({ url: "https://jobs.example/1", pageText: `${text}\n[가짜:근거없음]` }, new FakeLlmClient())).rejects.toThrow(
      PostingExtractError,
    );
  });
});
