/**
 * 외국어 공고 → 한국어 저장(translate.ts): 언어 판정, 번역 검사(개수·숫자·고유명사·길이 → 항목별 원문 유지),
 * extractPosting·extractStructure 연결(근거 검증은 원문 기준, 한국어 공고는 번역 호출 없음, 번역 실패는 원문 그대로).
 */
import { describe, expect, it, vi } from "vitest";
import type { PostingTranslation } from "@/lib/domain/posting-structure";
import type { GenerateResult, LlmClient, LlmRequest } from "@/lib/llm/types";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));

const { detectPostingLanguage, applyTranslation, keepsNumbers, keepsTerms, translatePostingFields, fieldsFromStructure } = await import("./translate");
const { extractPosting, extractStructure } = await import("./extract");

const ENGLISH_PAGE = [
  "Careers | Acme Robotics",
  "Company: Acme Robotics",
  "Role: Senior Backend Engineer",
  "Location: Seoul, South Korea",
  "Full-time. Apply by 2026-12-01.",
  "Responsibilities",
  "- Design and build payment APIs with Kotlin and Spring Boot",
  "- Operate services on Kubernetes and AWS",
  "- Improve observability across 20 microservices",
  "Requirements",
  "- 5+ years of backend engineering experience",
  "- Strong experience with Kotlin or Java",
  "Nice to have",
  "- Experience with Kafka",
  "Benefits",
  "- Flexible working hours and remote days",
].join("\n");

/** 실제 호출을 기록하고, 번역 요청에는 translate(입력)을 돌려주는 LLM(추출은 가짜 LLM). */
function recordingLlm(translate?: (input: PostingTranslation) => unknown): LlmClient & { tasks: string[] } {
  const fake = new FakeLlmClient();
  const tasks: string[] = [];
  return {
    name: "rec",
    tasks,
    async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
      tasks.push(req.task ?? req.stage ?? "");
      if (req.task === "posting-translate" && translate) {
        const json = /<posting_page>\n([\s\S]*)\n<\/posting_page>/.exec(req.user)![1]!;
        const output = translate(JSON.parse(json) as PostingTranslation) as T;
        return { output, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "rec" };
      }
      return fake.generate(req);
    },
  };
}

describe("detectPostingLanguage", () => {
  it("영어 공고는 en, 한국어 공고는 ko", () => {
    expect(detectPostingLanguage(["Design and build payment APIs with Kotlin and Spring Boot", "5+ years of backend engineering experience"])).toBe("en");
    expect(detectPostingLanguage(["대규모 결제 시스템 설계 및 개발", "백엔드 개발 경험 3년 이상", "분산 시스템 운영 경험"])).toBe("ko");
  });

  it("영어 기술 이름이 많은 한국어 공고는 ko(번역하지 않는다)", () => {
    expect(
      detectPostingLanguage([
        "Kotlin, Spring Boot, JPA 기반 결제 API 개발",
        "Kubernetes, AWS EKS, Terraform 환경 운영 경험",
        "Kafka, Redis, MySQL 사용 경험",
        "MSA 환경에서 gRPC 통신 설계 경험 우대",
      ]),
    ).toBe("ko");
  });

  it("짧은 글(외국 문자가 적음)은 판정하지 않고 ko", () => {
    expect(detectPostingLanguage(["Backend Engineer", "서울"])).toBe("ko");
  });

  it("일본어 등 그 밖의 외국어는 other", () => {
    expect(detectPostingLanguage(["決済システムの設計と開発を担当していただきます。", "バックエンド開発経験3年以上", "分散システムの運用経験"])).toBe("other");
  });
});

describe("번역 검사(applyTranslation)", () => {
  const base: PostingTranslation = {
    roleTitle: "Senior Backend Engineer",
    location: "Seoul, South Korea",
    summary: "",
    companyIndustry: "",
    companySize: "",
    salary: "$150,000 - $180,000",
    workHours: "",
    companyIntro: [],
    duties: ["Operate services on Kubernetes and AWS", "Improve observability across 20 microservices"],
    requirements: ["5+ years of backend engineering experience"],
    preferred: ["Experience with Kafka"],
    conditionsOther: [],
    benefits: [],
    process: [],
    documents: [],
    applyMethod: [],
    notes: [],
  };
  const terms = ["Kubernetes", "AWS", "Kafka", "Acme Robotics"];

  it("맞는 번역은 그대로 받는다(개수·순서 유지)", () => {
    const tr = {
      ...base,
      roleTitle: "시니어 백엔드 엔지니어",
      location: "대한민국 서울",
      salary: "$150,000 - $180,000",
      duties: ["Kubernetes와 AWS에서 서비스 운영", "20개 마이크로서비스 전반의 관측 가능성 개선"],
      requirements: ["5년 이상의 백엔드 엔지니어링 경험"],
      preferred: ["Kafka 사용 경험"],
    };
    const r = applyTranslation(base, tr, terms);
    expect(r.changed).toBe(true);
    expect(r.rejected).toBe(0);
    expect(r.fields).toMatchObject({ roleTitle: "시니어 백엔드 엔지니어", location: "대한민국 서울", duties: tr.duties, requirements: tr.requirements });
  });

  it("배열 개수가 다르면 그 구역 전체를 원문으로", () => {
    const r = applyTranslation(base, { ...base, duties: ["Kubernetes·AWS 운영 및 20개 서비스 관측성 개선"], preferred: ["Kafka 사용 경험"] }, terms);
    expect(r.fields.duties).toEqual(base.duties);
    expect(r.fields.preferred).toEqual(["Kafka 사용 경험"]);
  });

  it("빈 값·숫자 변경·고유명사 누락·길이 초과 항목만 원문으로", () => {
    const r = applyTranslation(
      base,
      {
        ...base,
        roleTitle: "",
        salary: "연 2억 원",
        duties: ["쿠버네티스와 아마존 클라우드에서 서비스 운영", "30개 마이크로서비스 관측성 개선"],
        requirements: ["가".repeat(301)],
        preferred: ["Kafka 사용 경험"],
      },
      terms,
    );
    expect(r.fields.roleTitle).toBe(base.roleTitle);
    expect(r.fields.salary).toBe(base.salary);
    expect(r.fields.duties).toEqual(base.duties);
    expect(r.fields.requirements).toEqual(base.requirements);
    expect(r.fields.preferred).toEqual(["Kafka 사용 경험"]);
    expect(r.rejected).toBe(5);
  });

  it("모양이 깨진 출력(문자열 아님·배열 아님)도 원문으로", () => {
    const r = applyTranslation(base, { roleTitle: 42, duties: "not an array" } as never, terms);
    expect(r.fields).toEqual(base);
    expect(r.changed).toBe(false);
  });

  it("숫자: 원문 숫자는 모두 남고 새 숫자는 없어야 한다(영어 달 이름은 1~12 허용)", () => {
    expect(keepsNumbers("5+ years", "5년 이상")).toBe(true);
    expect(keepsNumbers("$150,000", "15만 달러")).toBe(false);
    expect(keepsNumbers("Apply by Dec 1, 2026", "2026년 12월 1일까지 지원")).toBe(true);
    expect(keepsNumbers("Apply by 2026", "2026년 12월까지")).toBe(false);
    expect(keepsNumbers("1 December 2026", "2026년 12월 1일")).toBe(true);
    expect(keepsNumbers("Starting May 2026", "2026년 5월부터")).toBe(true);
  });

  it("숫자: 일반 낱말 may·march 등은 달 예외가 아니고, 날짜의 달도 그 달 숫자 하나만 허용", () => {
    expect(keepsNumbers("You may be asked to travel occasionally", "가끔 출장이 있을 수 있으며 주 3회 출근")).toBe(false);
    expect(keepsNumbers("You may work remotely", "주 3일 원격 근무가 가능합니다")).toBe(false);
    expect(keepsNumbers("Apply by Dec 1", "3월 1일까지 지원")).toBe(false);
    expect(keepsNumbers("Apply by Dec 1", "12월 1일까지 지원")).toBe(true);
  });

  it("숫자: 원문에 낱말로 나온 수(one~twelve)는 번역에서 숫자로 써도 되고, 없던 수는 안 된다", () => {
    expect(keepsNumbers("Proficiency in at least one modern backend language", "최소 1개 이상의 최신 백엔드 언어 숙련도")).toBe(true);
    expect(keepsNumbers("Two rounds of interviews", "2차례 면접")).toBe(true);
    expect(keepsNumbers("Proficiency in at least one language", "최소 2개 언어 숙련도")).toBe(false);
    expect(keepsNumbers("Someone who is done", "1명")).toBe(false);
  });

  it("고유명사: 일반 낱말이기도 한 이름(Go·Express·Spring)은 원문 표기 그대로 나올 때만 지킨다", () => {
    expect(keepsTerms("Own go-to-market launches", "시장 출시 주도", ["Go"])).toBe(true);
    expect(keepsTerms("Please express your interest", "관심을 알려 주세요", ["Express"])).toBe(true);
    expect(keepsTerms("Start in spring 2026", "2026년 봄 입사", ["Spring"])).toBe(true);
    expect(keepsTerms("Experience with Go", "고 언어 경험", ["Go"])).toBe(false);
    expect(keepsTerms("Experience with Go", "Go 경험", ["Go"])).toBe(true);
  });

  it("원문보다 크게 길어진 번역(원문에 없는 말을 보탬)은 원문으로", () => {
    const r = applyTranslation(
      base,
      { ...base, preferred: ["Kafka 사용 경험 (필수, 재택 근무 가능, 주말 근무 없음, 정규직 전환 보장, 스톡옵션 제공)"] },
      terms,
    );
    expect(r.fields.preferred).toEqual(base.preferred);
    expect(r.rejected).toBe(1);
  });

  it("고유명사: 원문에 나온 이름은 번역에도 그대로", () => {
    expect(keepsTerms("Operate on Kubernetes", "Kubernetes에서 운영", ["Kubernetes"])).toBe(true);
    expect(keepsTerms("Operate on Kubernetes", "쿠버네티스에서 운영", ["Kubernetes"])).toBe(false);
    // 다른 낱말 안에 든 짧은 이름(예: 'Go' in 'Google')은 원문에 나온 것으로 보지 않는다.
    expect(keepsTerms("Work with Google Cloud", "Google Cloud로 작업", ["Go"])).toBe(true);
  });
});

describe("extractPosting + 번역", () => {
  const page = { url: "https://jobs.example/acme/1", pageText: ENGLISH_PAGE };

  it("영문 공고: 원문 기준 근거 검증 → 번역 1회 → 한국어 저장(개수·고유명사·숫자 유지, 원문은 sourceText)", async () => {
    const llm = recordingLlm();
    const r = await extractPosting(page, llm);
    expect(llm.tasks).toEqual(["posting-extract", "posting-translate"]);
    expect(r.posting.company).toBe("Acme Robotics");
    expect(r.posting.roleTitle).toBe("시니어 백엔드 엔지니어");
    expect(r.posting.location).toMatch(/서울/);
    expect(r.structure.translatedFrom).toBe("en");
    expect(r.structure.duties).toHaveLength(3);
    expect(r.structure.requirements).toHaveLength(2);
    expect(r.structure.preferred).toHaveLength(1);
    expect(r.structure.duties[0]).toContain("Kotlin");
    expect(r.structure.duties[0]).toContain("Spring Boot");
    expect(r.structure.duties[2]).toContain("20");
    expect(r.structure.techStack).toEqual(expect.arrayContaining(["Kotlin", "Kubernetes", "AWS"]));
    expect(r.posting.deadline).toBe("2026-12-01");
    // jdText는 한국어 구역으로 다시 조합, 원문은 sourceText 그대로.
    expect(r.structure.jdComposed).toBe(true);
    expect(r.posting.jdText).toContain("주요 업무");
    expect(r.posting.jdText).toContain(r.structure.duties[0]);
    expect(r.posting.jdText).not.toContain("- Design and build payment APIs with Kotlin and Spring Boot\n");
    expect(r.sourceText).toBe(ENGLISH_PAGE);
  });

  it("한국어 공고는 번역을 부르지 않는다", async () => {
    const llm = recordingLlm();
    const ko = [
      "회사: 페이랩",
      "모집 직무: 백엔드 개발자",
      "주요 업무",
      "- 결제 API 설계 및 개발",
      "- 정산 배치 운영",
      "자격 요건",
      "- 백엔드 개발 경험 3년 이상",
      "우대 사항",
      "- 대용량 트래픽 처리 경험",
      "근무지: 서울 강남",
    ].join("\n");
    const r = await extractPosting({ url: "https://jobs.example/k", pageText: `${ko}\n${"정규직 채용입니다. ".repeat(10)}` }, llm);
    expect(llm.tasks).toEqual(["posting-extract"]);
    expect(r.structure.translatedFrom).toBeUndefined();
  });

  it("영어 기술 이름이 섞인 한국어 공고도 번역하지 않는다", async () => {
    const llm = recordingLlm();
    const mixed = [
      "회사: 페이랩",
      "모집 직무: Backend Engineer",
      "주요 업무",
      "- Kotlin, Spring Boot 기반 결제 API 개발",
      "- Kubernetes, AWS EKS 환경 운영",
      "자격 요건",
      "- JVM 기반 백엔드 개발 경험 3년 이상",
      "- MySQL, Redis 사용 경험",
      "우대 사항",
      "- Kafka 기반 이벤트 처리 경험",
    ].join("\n");
    const r = await extractPosting({ url: "https://jobs.example/m", pageText: mixed }, llm);
    expect(llm.tasks).toEqual(["posting-extract"]);
    expect(r.posting.roleTitle).toBe("Backend Engineer");
  });

  it("번역 출력이 틀리면 항목별로 원문 유지(맞는 항목만 반영)", async () => {
    const llm = recordingLlm((input) => ({
      ...input,
      roleTitle: "시니어 백엔드 엔지니어",
      // 개수가 다름 → 주요 업무 전체 원문
      duties: ["하나로 합친 업무"],
      // 숫자를 바꿈 → 그 항목만 원문, 다른 항목은 번역
      requirements: ["7년 이상의 백엔드 경험", "Kotlin 또는 Java 사용 경험이 많음"],
    }));
    const r = await extractPosting(page, llm);
    expect(r.posting.roleTitle).toBe("시니어 백엔드 엔지니어");
    expect(r.structure.duties).toEqual([
      "Design and build payment APIs with Kotlin and Spring Boot",
      "Operate services on Kubernetes and AWS",
      "Improve observability across 20 microservices",
    ]);
    expect(r.structure.requirements).toEqual(["5+ years of backend engineering experience", "Kotlin 또는 Java 사용 경험이 많음"]);
    expect(r.structure.translatedFrom).toBe("en");
  });

  it("번역 호출이 실패하면 원문 그대로 저장하고 경고만 남긴다", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fake = new FakeLlmClient();
    const llm: LlmClient = {
      name: "x",
      generate: (req) => (req.task === "posting-translate" ? Promise.reject(new Error("engine down")) : fake.generate(req)),
    };
    const r = await extractPosting(page, llm);
    expect(r.posting.roleTitle).toBe("Senior Backend Engineer");
    expect(r.structure.translatedFrom).toBeUndefined();
    expect(r.structure.duties[0]).toBe("Design and build payment APIs with Kotlin and Spring Boot");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("posting-translate"), "engine down");
    warn.mockRestore();
  });

  it("취소(signal)는 번역 실패로 삼키지 않고 던진다", async () => {
    const ac = new AbortController();
    const fake = new FakeLlmClient();
    const llm: LlmClient = {
      name: "x",
      generate: (req) => {
        if (req.task !== "posting-translate") return fake.generate(req);
        ac.abort(new Error("timeout"));
        return Promise.reject(new Error("aborted"));
      },
    };
    await expect(extractPosting(page, llm, { signal: ac.signal })).rejects.toThrow("aborted");
  });

  it("번역이 자체 시간 상한에 걸리면 원문 그대로(호출자 signal은 살아 있음)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const fields = fieldsFromStructure((await extractPosting(page, new FakeLlmClient(), { translate: false })).structure, {
      roleTitle: "Senior Backend Engineer",
    });
    const hang: LlmClient = {
      name: "hang",
      generate: (req) =>
        new Promise((_, reject) => req.signal?.addEventListener("abort", () => reject(new Error("aborted by own timer")))),
    };
    const caller = new AbortController();
    const r = await translatePostingFields(fields, hang, { signal: caller.signal, timeoutMs: 30 });
    expect(r.translatedFrom).toBeNull();
    expect(r.fields).toEqual(fields);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("translation failed"), "timed out after 30ms");
    warn.mockRestore();
  });

  it("전체 상한까지 남은 시간이 적으면 번역을 부르지 않고 원문 그대로", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const llm = recordingLlm();
    const r = await extractPosting(page, llm, { deadlineAt: Date.now() + 5_000 });
    expect(llm.tasks).toEqual(["posting-extract"]);
    expect(r.posting.roleTitle).toBe("Senior Backend Engineer");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("not enough time"));
    warn.mockRestore();
  });

  it("translate:false면 번역하지 않는다", async () => {
    const llm = recordingLlm();
    await extractPosting(page, llm, { translate: false });
    expect(llm.tasks).toEqual(["posting-extract"]);
  });
});

describe("extractStructure(다시 정리) + 번역", () => {
  it("영문 본문의 구역도 한국어로 옮긴다(근거 해시는 원문 기준)", async () => {
    const llm = recordingLlm();
    const { structure } = await extractStructure(ENGLISH_PAGE, llm, { company: "Acme Robotics" });
    expect(llm.tasks).toEqual(["posting-extract", "posting-translate"]);
    expect(structure.translatedFrom).toBe("en");
    expect(structure.duties).toHaveLength(3);
    expect(structure.duties.every((d) => /[가-힣]/.test(d))).toBe(true);
    const { sourceHash } = await import("./structure");
    expect(structure.sourceHash).toBe(sourceHash(ENGLISH_PAGE));
  });
});
