/** 가입 동의 화면·법적 문서 렌더(정적 마크업): 기본 해제, 필수/선택 표시, 가입 버튼 비활성, 처리방침 필수 목차·강조·확인 필요 표시. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { EMPTY_CONSENT_CHECKS, REQUIRED_CONSENT_TYPES } from "@/lib/legal/consents";
import { ConsentChecklist } from "./ConsentChecklist";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }) }));

describe("ConsentChecklist", () => {
  it("모든 항목이 기본 해제이고 필수·선택을 표시한다", () => {
    const html = renderToStaticMarkup(<ConsentChecklist checks={EMPTY_CONSENT_CHECKS} onChange={() => {}} />);
    expect(html).not.toContain("checked");
    for (const name of ["terms", "privacy", "age14", "marketing"]) expect(html).toContain(`name="${name}"`);
    expect(html).toContain("(필수)");
    expect(html).toContain("(필수 확인)");
    expect(html).toContain("(선택)");
    expect(html).toContain("전체 동의(선택 항목 포함)");
    // 법 제15조② 고지: 거부권과 불이익, 국외 이전 표
    expect(html).toContain("거부해도 서비스 이용에 제한이 없습니다");
    expect(html).toContain("Anthropic, PBC");
    expect(html).toContain("Cloudflare, Inc.");
  });

  it("types로 이미 동의한 선택 항목을 뺄 수 있다", () => {
    const html = renderToStaticMarkup(
      <ConsentChecklist checks={EMPTY_CONSENT_CHECKS} onChange={() => {}} types={REQUIRED_CONSENT_TYPES} />,
    );
    expect(html).not.toContain('name="marketing"');
    expect(html).toContain(">전체 동의<");
  });
});

describe("가입 화면(AuthForm signup)", () => {
  it("필수 동의 전에는 Google 가입 버튼이 비활성이고, 폼은 POST /api/auth/google", async () => {
    const { AuthForm } = await import("@/app/(auth)/AuthForm");
    const html = renderToStaticMarkup(<AuthForm mode="signup" next="/app" googleEnabled />);
    expect(html).toContain('action="/api/auth/google"');
    expect(html).toContain('method="post"');
    expect(html).toMatch(/<button type="submit" disabled=""[^>]*>[\s\S]*Google로 가입하기/);
  });
});

describe("법적 문서", () => {
  it("개인정보 처리방침: 필수 목차, 보호책임자, 확인 필요 표시", async () => {
    const { default: PrivacyPage } = await import("@/app/(legal)/privacy/page");
    const html = renderToStaticMarkup(<PrivacyPage />);
    for (const h of [
      "처리 목적",
      "처리하는 개인정보 항목과 근거",
      "파기 절차와 방법",
      "제3자 제공",
      "처리위탁",
      "국외 이전",
      "생성형 AI 이용 안내",
      "정보주체의 권리와 행사 방법",
      "안전성 확보 조치",
      "자동 수집 장치(쿠키)",
      "개인정보 보호책임자",
      "권익침해 구제 방법",
      "처리방침의 변경",
    ]) {
      expect(html).toContain(h);
    }
    expect(html).toContain("이현대");
    expect(html).toContain("support@snowlink.team");
    expect(html).toContain("010-4953-4821");
    expect(html).toContain("AI 모델 학습에 쓰지 않습니다");
    // 주소가 비어 있는 동안은 '확인 필요'로 눈에 띄게 표시한다.
    const { BUSINESS } = await import("@/lib/brand");
    if (!BUSINESS.address.trim()) expect(html).toContain("[확인 필요]");
  });

  it("이용약관: 승인제·만 14세·공용 공고 조항", async () => {
    const { default: TermsPage } = await import("@/app/(legal)/terms/page");
    const html = renderToStaticMarkup(<TermsPage />);
    expect(html).toContain("승인 대기");
    expect(html).toContain("만 14세 미만은 가입할 수 없습니다");
    expect(html).toContain("공고 찾기");
  });
});
