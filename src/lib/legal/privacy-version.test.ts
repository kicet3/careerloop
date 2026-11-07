/** 개인정보 처리방침 2026-11-09판: 버전, 이전 판(2026-11-08·2026-11-07) 보관, 포트폴리오 공개 링크·방문자 챗봇 항목(+ 2026-11-08판의 원본·사진 항목 유지). */
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import * as archived07 from "./archive/privacy-data-2026-11-07";
import * as archived08 from "./archive/privacy-data-2026-11-08";
import { CONSENT_DOCS, missingRequiredConsents, PRIVACY_VERSION } from "./consents";
import { CONTRACT_PROCESSING, OVERSEAS_TRANSFERS } from "./privacy-data";

vi.mock("server-only", () => ({}));

const appDir = path.resolve(import.meta.dirname, "../../app/(legal)/privacy");

describe("처리방침 2026-11-09", () => {
  it("버전을 올렸고, 2026-11-08판 동의는 다시 받는다", () => {
    expect(PRIVACY_VERSION).toBe("2026-11-09");
    expect(CONSENT_DOCS.privacy.version).toBe("2026-11-09");
    const prev = { version: "2026-11-08", agreed: true, at: 1 };
    const ok = (t: "terms" | "age14") => ({ version: CONSENT_DOCS[t].version, agreed: true, at: 1 });
    expect(missingRequiredConsents({ terms: ok("terms"), privacy: prev, age14: ok("age14") })).toEqual(["privacy"]);
  });

  it("이전 판(2026-11-08·2026-11-07) 원문을 보관하고 현재 판에서 링크한다", () => {
    const current = readFileSync(path.join(appDir, "page.tsx"), "utf8");
    for (const v of ["2026-11-08", "2026-11-07"]) {
      const page = path.join(appDir, v, "page.tsx");
      expect(existsSync(page)).toBe(true);
      const src = readFileSync(page, "utf8");
      expect(src).toContain(`const PRIVACY_VERSION = "${v}"`);
      expect(src).toContain(`archive/privacy-data-${v}`);
      expect(src).not.toContain("@/lib/legal/consents");
      expect(src).not.toContain("공개 링크");
      expect(current).toContain(`href="/privacy/${v}"`);
    }
    // 보관 판에는 새 항목이 없다
    expect(JSON.stringify(archived08.CONTRACT_PROCESSING)).not.toContain("공개 링크");
    expect(JSON.stringify(archived08.OVERSEAS_TRANSFERS)).not.toContain("방문자");
    expect(JSON.stringify(archived08.CONTRACT_PROCESSING)).toContain("포트폴리오 원본 파일");
    expect(JSON.stringify(archived07.CONTRACT_PROCESSING)).not.toContain("포트폴리오 원본 파일");
  });

  it("포트폴리오 공개 링크(선택)·방문자 챗봇 항목: 공개 범위, 질문 미저장, IP 해시, AI 국외 이전", () => {
    const rows = JSON.stringify(CONTRACT_PROCESSING);
    expect(rows).toContain("(선택) 포트폴리오 공개 링크");
    expect(rows).toContain("이메일과 다른 자료(경험 그래프·이력서 등)는 공개하지 않음");
    expect(rows).toContain("공개 포트폴리오 방문자 챗봇");
    expect(rows).toContain("저장하지 않음");
    expect(rows).toContain("IP의 해시값");
    const anthropic = OVERSEAS_TRANSFERS.find((t) => t.recipient.startsWith("Anthropic"))!;
    expect(anthropic.items).toContain("공개 포트폴리오 방문자가 입력한 질문과 그 포트폴리오의 공개본");
    const page = readFileSync(path.join(appDir, "page.tsx"), "utf8");
    expect(page).toContain("공개 중지");
    expect(page).toContain("noindex");
    expect(page).toContain("공개 포트폴리오 챗봇");
  });

  it("2026-11-08판의 프로필 사진·포트폴리오 원본 보관 항목은 그대로 둔다", () => {
    const rows = JSON.stringify(CONTRACT_PROCESSING);
    expect(rows).toContain("(선택) 이력서 머리글에 프로필 사진");
    expect(rows).toContain("포트폴리오 원본 파일");
    const anthropic = OVERSEAS_TRANSFERS.find((t) => t.recipient.startsWith("Anthropic"))!;
    expect(anthropic.items).toContain("프로필 사진과 포트폴리오 원본 파일 자체");
    const r2 = OVERSEAS_TRANSFERS.find((t) => t.recipient.startsWith("Cloudflare"))!;
    expect(r2.items).toContain("포트폴리오 원본 파일");
    expect(r2.items).toContain("프로필 사진");
  });
});
