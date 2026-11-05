import { describe, expect, it } from "vitest";
import { accessDecision, accessRedirectPath } from "./access";
import { adminEmails, isAdminEmail } from "./admin-emails";
import { allowedAdminActions } from "@/lib/domain/users";

describe("accessDecision", () => {
  it("거절·정지 → 동의 없음 → 대기 → 통과 순서", () => {
    expect(accessDecision("suspended", ["terms"])).toBe("suspended");
    expect(accessDecision("rejected", [])).toBe("rejected");
    expect(accessDecision("pending", ["terms"])).toBe("consent");
    expect(accessDecision("approved", ["privacy"])).toBe("consent");
    expect(accessDecision("pending", [])).toBe("pending");
    expect(accessDecision("approved", [])).toBe("ok");
  });

  it("이동할 화면", () => {
    expect(accessRedirectPath("ok")).toBeNull();
    expect(accessRedirectPath("consent", "/app/resumes")).toBe("/consent?next=%2Fapp%2Fresumes");
    expect(accessRedirectPath("pending", "/app")).toBe("/pending");
    expect(accessRedirectPath("suspended")).toBe("/pending");
  });
});

describe("ADMIN_EMAILS", () => {
  it("쉼표·공백 구분, 대소문자 무시", () => {
    const env = { ADMIN_EMAILS: " Kicet3@gmail.com, b@x.com ;c@y.com  not-an-email" };
    expect([...adminEmails(env)]).toEqual(["kicet3@gmail.com", "b@x.com", "c@y.com"]);
    expect(isAdminEmail("KICET3@GMAIL.COM", env)).toBe(true);
    expect(isAdminEmail("d@x.com", env)).toBe(false);
    expect(isAdminEmail("a@x.com", {})).toBe(false);
  });
});

describe("allowedAdminActions", () => {
  it("상태별 허용 동작", () => {
    expect(allowedAdminActions("pending")).toEqual(["approve", "reject"]);
    expect(allowedAdminActions("approved")).toEqual(["suspend"]);
    expect(allowedAdminActions("rejected")).toEqual(["approve"]);
    expect(allowedAdminActions("suspended")).toEqual(["unsuspend"]);
  });
});
