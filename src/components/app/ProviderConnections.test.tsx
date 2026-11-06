/** AI 연결 카드(정적 마크업): 관리자만 로그인·해제·새로고침 버튼과 진행 중인 로그인 링크·코드를 본다. */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { ProviderConnection } from "@/lib/domain/providers";
import { ProviderConnections } from "./ProviderConnections";

const conn = (over: Partial<ProviderConnection> = {}): ProviderConnection => ({
  id: "codex-cli",
  enabled: true,
  systemLogin: false,
  status: { installed: true, loggedIn: false, account: null, error: null },
  login: null,
  ...over,
});

const waiting = conn({
  login: {
    phase: "waiting",
    url: "https://auth.openai.com/codex/device",
    userCode: "ABCD-1234",
    needsCode: false,
    codeSubmitted: false,
    message: null,
    expiresAt: Date.now() + 60_000,
  },
});

describe("ProviderConnections", () => {
  it("관리자: 로그인·상태 새로고침 버튼과 진행 중인 로그인 링크·코드를 보인다", () => {
    const idle = renderToStaticMarkup(<ProviderConnections initial={[conn()]} canManage />);
    expect(idle).toContain("<button");
    expect(idle).toContain("상태 새로고침");
    const html = renderToStaticMarkup(<ProviderConnections initial={[waiting]} canManage />);
    expect(html).toContain("ABCD-1234");
    expect(html).toContain("https://auth.openai.com/codex/device");
    expect(html).toContain("취소");
  });

  it("일반 사용자: 상태 배지만 보이고 조작 버튼·로그인 링크·코드는 그리지 않는다", () => {
    const html = renderToStaticMarkup(
      <ProviderConnections
        initial={[waiting, conn({ id: "claude-cli", status: { installed: true, loggedIn: true, account: "a@x.com", error: null } })]}
        canManage={false}
      />,
    );
    expect(html).toContain("연결 안 됨");
    expect(html).toContain("연결됨");
    expect(html).not.toContain("<button");
    expect(html).not.toContain("ABCD-1234");
    expect(html).not.toContain("auth.openai.com");
  });
});
