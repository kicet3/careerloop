import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalString, signedHeaders, signRequest, verifySignature } from "./sign";

const vectors = JSON.parse(readFileSync(path.resolve(import.meta.dirname, "../../../worker/tests/fixtures/hmac_vectors.json"), "utf8")) as {
  secret: string;
  vectors: { method: string; path: string; body: string; ts: string; canonical: string; signature: string }[];
  verify: { timestamp: string | null; signature: string | null; nowSec: number; method: string; path: string; body: string; expected: string | null }[];
};

describe("워커 HMAC 서명(공유 벡터 — pytest도 같은 파일을 확인한다)", () => {
  it("서명 벡터를 그대로 만든다", () => {
    for (const v of vectors.vectors) {
      expect(canonicalString(v.ts, v.method, v.path, v.body)).toBe(v.canonical);
      expect(signRequest(vectors.secret, v.ts, v.method, v.path, v.body)).toBe(v.signature);
    }
  });

  it("검증 결과가 벡터와 같다(만료·형식·변조·경로/본문/메서드 바꿔치기)", () => {
    for (const c of vectors.verify) {
      expect(verifySignature(vectors.secret, { timestamp: c.timestamp, signature: c.signature }, c.method, c.path, c.body, c.nowSec)).toBe(c.expected);
    }
    expect(vectors.verify.filter((c) => c.expected === null).length).toBeGreaterThanOrEqual(2);
    expect(vectors.verify.some((c) => c.expected === "mismatch")).toBe(true);
    expect(vectors.verify.some((c) => c.expected === "expired")).toBe(true);
  });

  it("다른 비밀값으로 만든 서명은 통과하지 못한다", () => {
    const h = signedHeaders("x".repeat(32), "POST", "/v1/jobs/resume-draft", "{}", 100);
    expect(
      verifySignature("y".repeat(32), { timestamp: h["X-Worker-Timestamp"], signature: h["X-Worker-Signature"] }, "POST", "/v1/jobs/resume-draft", "{}", 100),
    ).toBe("mismatch");
    expect(
      verifySignature("x".repeat(32), { timestamp: h["X-Worker-Timestamp"], signature: h["X-Worker-Signature"] }, "POST", "/v1/jobs/resume-draft", "{}", 100),
    ).toBeNull();
  });
});
