import { describe, expect, it } from "vitest";
import { LoginInputSchema, SignupInputSchema, safeNextPath, toFieldErrors } from "./validation";

describe("safeNextPath", () => {
  it.each([
    ["/app", "/app"],
    ["/app/d/abc?tab=plan#fit", "/app/d/abc?tab=plan#fit"],
    ["/app/new", "/app/new"],
  ])("허용: %s", (input, expected) => expect(safeNextPath(input)).toBe(expected));

  it.each([
    undefined,
    null,
    "",
    ["/app"],
    "app",
    "https://evil.com",
    "//evil.com",
    "//evil.com/app",
    "/\\evil.com",
    "/\tevil",
    "/app\n",
    "javascript:alert(1)",
    "/login",
    "/signup?next=/app",
    "/" + "a".repeat(3000),
  ])("거부: %j", (input) => expect(safeNextPath(input)).toBe("/app"));

  it("fallback 지정", () => expect(safeNextPath("//x", "/")).toBe("/"));
});

describe("SignupInputSchema", () => {
  it("이메일을 소문자·공백 제거로 정규화하고 빈 이름은 null", () => {
    const r = SignupInputSchema.parse({ email: "  Foo@Example.COM ", password: "12345678", name: "  " });
    expect(r).toEqual({ email: "foo@example.com", password: "12345678", name: null });
  });

  it("이름은 50자까지", () => {
    expect(SignupInputSchema.safeParse({ email: "a@b.co", password: "12345678", name: "가".repeat(50) }).success).toBe(true);
    const r = SignupInputSchema.safeParse({ email: "a@b.co", password: "12345678", name: "가".repeat(51) });
    expect(r.success).toBe(false);
    if (!r.success) expect(toFieldErrors(r.error).name).toBeDefined();
  });

  it("비밀번호 8~128자", () => {
    const ok = (password: string) => SignupInputSchema.safeParse({ email: "a@b.co", password }).success;
    expect(ok("1234567")).toBe(false);
    expect(ok("12345678")).toBe(true);
    expect(ok("x".repeat(128))).toBe(true);
    expect(ok("x".repeat(129))).toBe(false);
  });

  it("필드별 오류 메시지", () => {
    const r = SignupInputSchema.safeParse({ email: "nope", password: "1" });
    expect(r.success).toBe(false);
    if (!r.success) {
      const fe = toFieldErrors(r.error);
      expect(fe.email).toBe("올바른 이메일 형식이 아닙니다.");
      expect(fe.password).toBe("비밀번호는 8자 이상이어야 합니다.");
    }
  });
});

describe("LoginInputSchema", () => {
  it("비밀번호 길이 규칙을 강요하지 않는다", () => {
    expect(LoginInputSchema.safeParse({ email: "A@B.co", password: "x" }).success).toBe(true);
    expect(LoginInputSchema.safeParse({ email: "A@B.co", password: "" }).success).toBe(false);
  });
});
