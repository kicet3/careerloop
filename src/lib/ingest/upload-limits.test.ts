import { describe, expect, it } from "vitest";
import {
  formatMb,
  SELF_HOSTED_UPLOAD_LIMITS,
  totalUploadError,
  uploadLimitMessage,
  uploadLimitsFor,
  VERCEL_UPLOAD_LIMITS,
} from "./upload-limits";

const MB = 1024 * 1024;

describe("업로드 상한", () => {
  it("Vercel이면 요청 본문 4.5MB 안에 들도록 묶는다", () => {
    expect(uploadLimitsFor({ VERCEL: "1" })).toBe(VERCEL_UPLOAD_LIMITS);
    expect(uploadLimitsFor({})).toBe(SELF_HOSTED_UPLOAD_LIMITS);
    expect(VERCEL_UPLOAD_LIMITS.maxBodyBytes).toBeLessThanOrEqual(4.5 * MB);
    // 파일 합계 + 텍스트 필드(이력서 4만 자·JD 3만 자·메모·포트폴리오 설명, 한글 3바이트) + multipart 여유가 4.5MB 안
    expect(VERCEL_UPLOAD_LIMITS.totalFileBytes + (40_000 + 30_000 + 10_000) * 3 + 16 * 1024).toBeLessThan(4.5 * MB);
    expect(SELF_HOSTED_UPLOAD_LIMITS.perFileBytes).toBe(10 * MB);
  });

  it("안내 문구", () => {
    expect(formatMb(4 * MB)).toBe("4MB");
    expect(formatMb(4.5 * MB)).toBe("4.5MB");
    expect(uploadLimitMessage(VERCEL_UPLOAD_LIMITS)).toBe("파일은 각각 4MB 이하, 모두 합쳐 4MB 이하로 올려 주세요.");
    expect(uploadLimitMessage(SELF_HOSTED_UPLOAD_LIMITS)).toBe("파일은 각각 10MB 이하로 올려 주세요.");
  });

  it("파일 합계 검사", () => {
    expect(totalUploadError([{ size: 2 * MB }, null, { size: 2 * MB }], VERCEL_UPLOAD_LIMITS)).toBeNull();
    expect(totalUploadError([{ size: 3 * MB }, { size: 2 * MB }], VERCEL_UPLOAD_LIMITS)).toMatch(/합계\(5MB\)가 4MB를 넘습니다/);
  });
});
