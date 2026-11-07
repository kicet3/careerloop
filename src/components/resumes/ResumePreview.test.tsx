import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { emptyResumeDocument, performanceScaffold, RESUME_SECTION_LABELS, RESUME_TEMPLATE_IDS, RESUME_TEMPLATES } from "@/lib/domain/resumes";
import { makeSampleResume } from "@/lib/resumes/__fixtures__/sample";
import { resumeLayout, resumeToText } from "@/lib/resumes/layout";
import { ResumePreview } from "./ResumePreview";

const sectionOrderIn = (html: string) => [...html.matchAll(/data-section="([a-z-]+)"/g)].map((m) => m[1]);

describe("ResumePreview", () => {
  it.each(RESUME_TEMPLATE_IDS.filter((id) => id !== "performance"))("%s 양식: 섹션 순서·강조색·내용", (id) => {
    const t = RESUME_TEMPLATES[id];
    const html = renderToStaticMarkup(<ResumePreview document={makeSampleResume()} templateId={id} />);
    expect(html).toContain(`data-template="${id}"`);
    expect(html).toContain(t.style.accent);
    expect(html).toContain("홍길동");
    expect(html).toContain("결제 API 응답 시간을 40% 줄였습니다.");
    expect(html).toContain("2021.03 – 현재");
    for (const k of t.sectionOrder) expect(html).toContain(`>${RESUME_SECTION_LABELS[k]}<`);
    const order = sectionOrderIn(html);
    if (t.style.layout === "sidebar") {
      expect(html).toContain("<aside");
      expect(order).toEqual(["skills", "education", "certifications", "summary", "highlights", "experience", "projects", "extras", "motivation"]);
    } else {
      expect(html).not.toContain("<aside");
      expect(order).toEqual([...t.sectionOrder]);
    }
    // 기술 칩 양식은 목록(li)으로, 아니면 쉼표로
    if (t.style.skillChips) expect(html).toMatch(/<li[^>]*>Kotlin<\/li>/);
    else expect(html).toContain("Kotlin, Spring, MySQL");
  });

  it("[ADD: ...]는 강조하고, 링크는 a 태그로 만들지 않는다", () => {
    const doc = makeSampleResume();
    doc.basics.links = [{ label: "x", url: "javascript:alert(1)" }];
    doc.summary = '<script>alert(1)</script> [ADD: 수치]';
    const html = renderToStaticMarkup(<ResumePreview document={doc} templateId="classic" />);
    expect(html).toContain("<mark");
    expect(html).toContain("[ADD: 수치]</mark>");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it.each(RESUME_TEMPLATE_IDS.filter((id) => id !== "performance"))("%s 양식: 한 줄 소개는 지원 직무 줄이 아니라 머리글 아래 독립 줄", (id) => {
    const html = renderToStaticMarkup(<ResumePreview document={makeSampleResume()} templateId={id} />);
    const header = html.slice(html.indexOf("<header"), html.indexOf("</header>"));
    expect(header).toContain("백엔드 개발자");
    expect(header).toContain("총 경력 5년 2개월");
    expect(header).not.toContain("결제·정산 지연을 줄여 온");
    const tagline = html.indexOf("data-tagline");
    expect(tagline).toBeGreaterThan(html.indexOf("</header>"));
    expect(html.indexOf("결제·정산 지연을 줄여 온 5년 차 백엔드 개발자")).toBeGreaterThan(tagline);
    expect(tagline).toBeLessThan(html.indexOf(`data-section="${resumeLayout(makeSampleResume(), id).main[0]}"`));
  });

  it("빈 문서는 안내 문구", () => {
    const html = renderToStaticMarkup(<ResumePreview document={emptyResumeDocument()} templateId="modern" />);
    expect(html).toContain("아직 내용이 없습니다");
    expect(sectionOrderIn(html)).toEqual([]);
  });
});

describe("ResumePreview — 성과 중심 양식(PerformanceSheet 읽기 전용)", () => {
  const field = (html: string, path: string) => {
    const m = html.match(new RegExp(`data-field="${path.replace(/\./g, "\\.")}"[^>]*>(.*?)</`));
    return m?.[1];
  };

  it("필드 값이 원본 구조(머리글·핵심 성과·경력·대표 프로젝트·직무 역량·학력·자격) 자리에 나온다", () => {
    const html = renderToStaticMarkup(<ResumePreview document={makeSampleResume()} templateId="performance" />);
    expect(html).toContain('data-template="performance"');
    expect(field(html, "basics.name")).toBe("홍길동");
    expect(field(html, "basics.headline")).toBe("백엔드 개발자");
    expect(field(html, "basics.tagline")).toBe("결제·정산 지연을 줄여 온 5년 차 백엔드 개발자");
    // 한 줄 소개는 지원 직무 줄(pf-role) 밖의 독립 줄
    const role = html.slice(html.indexOf('class="pf-role"'), html.indexOf("</p>", html.indexOf('class="pf-role"')));
    expect(role).not.toContain("basics.tagline");
    expect(html).toMatch(/class="pf-field pf-tagline" data-field="basics\.tagline"/);
    expect(field(html, "basics.totalExperience")).toBe("5년 2개월");
    expect(html).toContain("총 경력");
    expect(field(html, "basics.portfolioUrl")).toBe("https://hong.dev");
    expect(field(html, "highlights.0.title")).toBe("정산 배치 처리 시간 4시간 → 40분 · 83% 단축");
    expect(field(html, "experience.0.department")).toBe("결제플랫폼팀");
    expect(field(html, "experience.0.scope")).toBe("결제 API와 정산 배치의 설계·운영을 맡았습니다.");
    expect(field(html, "projects.0.problem")).toBe("대사 오류 로그로 수기 정산 누락을 확인.");
    expect(field(html, "projects.0.team")).toBe("백엔드 3·기획 1");
    expect(field(html, "certifications.0.name")).toBe("정보처리기사");
    // 섹션 제목은 비어 있으면 원본 기본 제목을 안내 문구로(같은 색) 보인다
    expect(html).toContain('data-empty="대표 프로젝트"');
    expect(html).toContain('data-empty="직무 역량"');
    expect(html).toContain('data-empty="학력·자격"');
    // 기술 설명이 비면 기술 목록을 흐린 안내로
    expect(html).toContain('data-empty="Kotlin, Spring, MySQL"');
    // 읽기 전용은 편집 칸·작성 안내가 없다
    expect(html).not.toMatch(/contenteditable/i);
    expect(html).not.toContain("채울 때 확인하세요");
    expect(html).toContain("[ADD: 대표 성과 한 줄]</mark>");
  });

  it("빈 칸은 원본의 대괄호 안내 문구를 data-empty로 보이고, 값으로 넣지 않는다", () => {
    const html = renderToStaticMarkup(<ResumePreview document={performanceScaffold()} templateId="performance" />);
    expect(html).toContain('data-empty="[이름]"');
    expect(html).toContain('data-empty="[한 줄 소개]"');
    expect(html).toContain('data-empty="[최근 회사명]"');
    expect(html).toContain('data-empty="[이전 회사명 또는 주요 활동]"');
    expect(html).toContain('data-empty="[문제와 변화가 드러나는 프로젝트명]"');
    expect(html).toContain('data-empty="[직접 결정·실행한 일]로 [검증된 변화 또는 성과]에 기여."');
    expect(field(html, "basics.name")).toBe("");
    expect(html.match(/data-item="experience\.\d+"/g)).toHaveLength(2);
    expect(html.match(/data-item="projects\.\d+"/g)).toHaveLength(2);
  });

  it("사용자 값의 HTML은 글자로만 들어간다(주입 불가)", () => {
    const doc = makeSampleResume();
    doc.basics.name = '<img src=x onerror="alert(1)">';
    doc.projects[0]!.result = "<script>alert(1)</script>";
    doc.skills[0]!.category = '"><svg onload=alert(1)>';
    doc.basics.portfolioUrl = "javascript:alert(1)";
    const html = renderToStaticMarkup(<ResumePreview document={doc} templateId="performance" />);
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("<a ");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
  });
});

describe("PerformanceSheet 편집 모드", () => {
  it("칸이 contenteditable=plaintext-only이고, 항목 추가·삭제 버튼과 원본 작성 안내·분량 표시가 있다", async () => {
    const { PerformanceSheet } = await import("./PerformanceSheet");
    const html = renderToStaticMarkup(<PerformanceSheet document={performanceScaffold()} onChange={() => {}} />);
    // React 서버 렌더는 속성 이름을 contentEditable로 쓴다(HTML 속성은 대소문자 무관).
    expect(html).toMatch(/contenteditable="plaintext-only"/i);
    expect(html).toContain('aria-label="최근 회사명"');
    expect(html).toContain("+ 성과");
    expect(html).toContain("+ 경력");
    expect(html).toContain("+ 프로젝트");
    expect(html).toContain("+ 역량");
    expect(html).toContain("+ 학력");
    expect(html).toContain('aria-label="최근 경력에 대표 기여 추가"');
    expect(html).toContain('aria-label="최근 경력 삭제"');
    expect(html).toContain("채울 때 확인하세요");
    expect(html).toContain("A4 1장 기준");
    expect(html).toContain("분량 확인 중");
  });
});

describe("지원 동기 섹션", () => {
  it.each(RESUME_TEMPLATE_IDS)("%s: 내용이 있으면 '지원 동기' 섹션(문단마다 블록), 비면 섹션이 없다", async (id) => {
    const doc = makeSampleResume();
    doc.motivation = "첫 문단 <b>굵게</b>\n같은 문단 둘째 줄\n\n둘째 문단 [ADD: 메모 — 지원 계기]";
    const html = renderToStaticMarkup(<ResumePreview document={doc} templateId={id} />);
    expect(html).toContain('data-section="motivation"');
    expect(html).toContain(">지원 동기<");
    expect(html).toContain("첫 문단 &lt;b&gt;굵게&lt;/b&gt;");
    expect(html).toContain("둘째 문단");
    // [ADD: …] 메모는 자리표시로 강조한다.
    expect(html).toMatch(/<mark[^>]*>\[ADD: 메모 — 지원 계기\]<\/mark>/);

    const none = makeSampleResume();
    none.motivation = "  \n ";
    const empty = renderToStaticMarkup(<ResumePreview document={none} templateId={id} />);
    expect(empty).not.toContain('data-section="motivation"');
    expect(empty).not.toContain(">지원 동기<");
  });

  it("쪽 나눔 블록: 제목은 첫 문단과 함께, 문단마다 따로 움직인다", async () => {
    const { buildModel } = await import("./ResumePreview");
    const doc = makeSampleResume();
    doc.motivation = "가\n\n나\n\n다";
    const atoms = buildModel(doc, "classic").main.filter((a) => a.id.startsWith("motivation"));
    expect(atoms.map((a) => [a.id, a.group, !!a.keepWithNext])).toEqual([
      ["motivation:h", "motivation:h", true],
      ["motivation:0", "motivation:0", false],
      ["motivation:1", "motivation:1", false],
      ["motivation:2", "motivation:2", false],
    ]);
    // 텍스트 변환(진단 입력·복사)에도 들어간다.
    expect(resumeToText(doc, "classic")).toContain("## 지원 동기\n가\n\n나\n\n다");
  });
});
