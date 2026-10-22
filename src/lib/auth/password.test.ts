import { describe, expect, it } from "vitest";
import { hashPassword, verifyAgainstDummy, verifyPassword } from "./password";

describe("password", () => {
  it("해시와 검증이 왕복한다", async () => {
    const hash = await hashPassword("correct horse battery", 4);
    expect(hash).toMatch(/^\$2[aby]\$04\$/);
    expect(await verifyPassword("correct horse battery", hash)).toBe(true);
    expect(await verifyPassword("correct horse batterY", hash)).toBe(false);
  });

  it("기본 cost는 12", async () => {
    const hash = await hashPassword("password1234");
    expect(hash.slice(4, 6)).toBe("12");
  }, 20_000);

  it("72바이트를 넘는 긴 한글 비밀번호도 끝까지 반영한다", async () => {
    const base = "가".repeat(60); // 180바이트
    const hash = await hashPassword(base + "A", 4);
    expect(await verifyPassword(base + "A", hash)).toBe(true);
    expect(await verifyPassword(base + "B", hash)).toBe(false);
  });

  it("같은 비밀번호도 솔트가 달라 해시가 다르다", async () => {
    expect(await hashPassword("abcdefgh", 4)).not.toBe(await hashPassword("abcdefgh", 4));
  });

  it("잘못된 해시 문자열이면 false", async () => {
    expect(await verifyPassword("abcdefgh", "not-a-hash")).toBe(false);
    expect(await verifyAgainstDummy("x")).toBe(false);
  }, 20_000);
});
