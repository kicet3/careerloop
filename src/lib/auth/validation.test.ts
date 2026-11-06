import { describe, expect, it } from "vitest";
import { safeNextPath } from "./validation";

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
    "/.//evil.com",
    "/a/..//evil.com",
    "/%2e%2e//evil.com",
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
