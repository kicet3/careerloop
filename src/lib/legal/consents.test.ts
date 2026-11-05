import { describe, expect, it, vi } from "vitest";
import {
  allConsentsChecked,
  CONSENT_DOCS,
  ConsentChoicesSchema,
  marketingAgreed,
  missingRequiredConsents,
  OPTIONAL_CONSENT_TYPES,
  REQUIRED_CONSENT_TYPES,
  requiredConsentsChecked,
} from "./consents";

vi.mock("server-only", () => ({}));

const current = (t: keyof typeof CONSENT_DOCS) => ({ version: CONSENT_DOCS[t].version, agreed: true, at: 1 });

describe("동의 항목", () => {
  it("필수는 약관·개인정보 안내·만 14세, 선택은 마케팅뿐", () => {
    expect(REQUIRED_CONSENT_TYPES).toEqual(["terms", "privacy", "age14"]);
    expect(OPTIONAL_CONSENT_TYPES).toEqual(["marketing"]);
    expect(CONSENT_DOCS.privacy.kind).toBe("notice");
  });

  it("필수 체크가 모두 있어야 가입 버튼이 켜지고, 전체 동의는 선택까지 모두", () => {
    expect(requiredConsentsChecked({ terms: true, privacy: true })).toBe(false);
    expect(requiredConsentsChecked({ terms: true, privacy: true, age14: true })).toBe(true);
    expect(allConsentsChecked({ terms: true, privacy: true, age14: true })).toBe(false);
    expect(allConsentsChecked({ terms: true, privacy: true, age14: true, marketing: true })).toBe(true);
  });

  it("선택값 스키마: 필수가 false면 거절, 마케팅 기본값 false", () => {
    expect(ConsentChoicesSchema.safeParse({ terms: true, privacy: true, age14: false }).success).toBe(false);
    expect(ConsentChoicesSchema.parse({ terms: true, privacy: true, age14: true })).toEqual({
      terms: true,
      privacy: true,
      age14: true,
      marketing: false,
    });
  });

  it("기록이 없거나, 철회했거나, 버전이 다르면 다시 받는다", () => {
    expect(missingRequiredConsents({})).toEqual(["terms", "privacy", "age14"]);
    expect(missingRequiredConsents({ terms: current("terms"), privacy: current("privacy"), age14: current("age14") })).toEqual([]);
    expect(
      missingRequiredConsents({ terms: { version: "2000-01-01", agreed: true, at: 1 }, privacy: current("privacy"), age14: current("age14") }),
    ).toEqual(["terms"]);
    expect(missingRequiredConsents({ terms: current("terms"), privacy: { ...current("privacy"), agreed: false }, age14: current("age14") })).toEqual([
      "privacy",
    ]);
  });

  it("마케팅 동의는 최신 기록 기준", () => {
    expect(marketingAgreed({})).toBe(false);
    expect(marketingAgreed({ marketing: { version: "old", agreed: true, at: 1 } })).toBe(true);
    expect(marketingAgreed({ marketing: { version: "old", agreed: false, at: 2 } })).toBe(false);
  });
});
