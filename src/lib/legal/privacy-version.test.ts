/** 개인정보 처리방침 2026-11-08판: 버전, 이전 판(2026-11-07) 보관, 프로필 사진·포트폴리오 원본 항목. */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as archived from "./archive/privacy-data-2026-11-07";
import { CONSENT_DOCS, missingRequiredConsents, PRIVACY_VERSION } from "./consents";
import { CONTRACT_PROCESSING, OVERSEAS_TRANSFERS } from "./privacy-data";

vi.mock("server-only", () => ({}));

const appDir = path.resolve(import.meta.dirname, "../../app/(legal)/privacy");

describe("처리방침 2026-11-08", () => {
  it("버전을 올렸고, 2026-11-07판 동의는 다시 받는다", () => {
    expect(PRIVACY_VERSION).toBe("2026-11-08");
    expect(CONSENT_DOCS.privacy.version).toBe("2026-11-08");
    const prev = { version: "2026-11-07", agreed: true, at: 1 };
    const ok = (t: "terms" | "age14") => ({ version: CONSENT_DOCS[t].version, agreed: true, at: 1 });
    expect(missingRequiredConsents({ terms: ok("terms"), privacy: prev, age14: ok("age14") })).toEqual(["privacy"]);
  });

  it("이전 판(2026-11-07) 원문을 보관하고 현재 판에서 링크한다", () => {
    const page = path.join(appDir, "2026-11-07", "page.tsx");
    expect(existsSync(page)).toBe(true);
    const src = readFileSync(page, "utf8");
    expect(src).toContain('const PRIVACY_VERSION = "2026-11-07"');
    expect(src).toContain("archive/privacy-data-2026-11-07");
    expect(src).not.toContain("@/lib/legal/consents");
    expect(readFileSync(path.join(appDir, "page.tsx"), "utf8")).toContain('href="/privacy/2026-11-07"');
    // 보관 판에는 새 항목이 없다
    expect(JSON.stringify(archived.CONTRACT_PROCESSING)).not.toContain("이력서 머리글에 프로필 사진");
    expect(JSON.stringify(archived.CONTRACT_PROCESSING)).not.toContain("포트폴리오 원본 파일");
  });

  it("프로필 사진(선택)·포트폴리오 원본 보관 항목과 AI에 보내지 않는 범위를 적었다", () => {
    const rows = JSON.stringify(CONTRACT_PROCESSING);
    expect(rows).toContain("프로필 사진");
    expect(rows).toContain("(선택) 이력서 머리글에 프로필 사진");
    expect(rows).toContain("포트폴리오 원본 파일");
    const anthropic = OVERSEAS_TRANSFERS.find((t) => t.recipient.startsWith("Anthropic"))!;
    expect(anthropic.items).toContain("프로필 사진과 포트폴리오 원본 파일 자체");
    const r2 = OVERSEAS_TRANSFERS.find((t) => t.recipient.startsWith("Cloudflare"))!;
    expect(r2.items).toContain("포트폴리오 원본 파일");
    expect(r2.items).toContain("프로필 사진");
  });
});
