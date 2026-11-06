/**
 * withGuardedPage: 마감이 브라우저 실행 도중에 나도 늦게 뜬 Chromium을 닫고, 닫은 뒤에야 동시 실행 차례를 돌려준다.
 * 브라우저 실행은 주입한 가짜(실행을 직접 끝내는 지연 약속).
 */
import type { Browser } from "puppeteer-core";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type FakeBrowser = { close: ReturnType<typeof vi.fn> };
const launches: { resolve: (b: FakeBrowser) => void }[] = [];
const launch = () => new Promise<FakeBrowser>((resolve) => launches.push({ resolve })) as unknown as Promise<Browser>;

const { withGuardedPage, MAX_CONCURRENT_BROWSERS } = await import("./browser");

class TestError extends Error {}
const lookup = async () => [{ address: "93.184.216.34", family: 4 }];
const opts = (totalTimeoutMs: number) => ({
  lookup,
  executablePath: "/fake/chrome",
  totalTimeoutMs,
  maxTransferBytes: 1024,
  blockedResourceTypes: new Set<never>(),
  error: (m: string) => new TestError(m),
  isOwnError: (e: unknown): e is TestError => e instanceof TestError,
  messages: { noBrowser: "no-browser", timeout: "timeout", generic: "generic" },
  logTag: "test",
  launch,
});
const flush = () => new Promise((r) => setTimeout(r, 20));

describe("withGuardedPage: 실행 도중 마감", () => {
  it("늦게 뜬 브라우저를 닫고, 닫힌 뒤에야 차례를 돌려준다", async () => {
    const run = vi.fn(async () => "ok");
    // 차례를 모두 채운 채 실행 도중 마감.
    const first = await Promise.all(
      Array.from({ length: MAX_CONCURRENT_BROWSERS }, () => withGuardedPage("https://example.com/job", opts(50), run).catch((e) => e)),
    );
    for (const e of first) expect(e).toBeInstanceOf(TestError);
    expect(launches).toHaveLength(MAX_CONCURRENT_BROWSERS);
    expect(run).not.toHaveBeenCalled();

    // 아직 뜨는 중인 Chromium이 차례를 쥐고 있다 — 새 요청은 차례를 못 받고 마감된다(브라우저를 더 띄우지 않는다).
    await expect(withGuardedPage("https://example.com/job", opts(80), run)).rejects.toThrow("timeout");
    expect(launches).toHaveLength(MAX_CONCURRENT_BROWSERS);

    // 늦게 뜨면 바로 닫고 차례를 돌려준다.
    const browsers = launches.map(() => ({ close: vi.fn(async () => {}) }));
    launches.forEach((l, i) => l.resolve(browsers[i]));
    await flush();
    for (const b of browsers) expect(b.close).toHaveBeenCalledTimes(1);

    // 이제 새 요청은 차례를 받아 브라우저를 띄운다.
    const third = withGuardedPage("https://example.com/job", opts(50), run).catch((e) => e);
    await flush();
    expect(launches).toHaveLength(MAX_CONCURRENT_BROWSERS + 1);
    expect(await third).toBeInstanceOf(TestError);
    const late = { close: vi.fn(async () => {}) };
    launches.at(-1)!.resolve(late);
    await flush();
    expect(late.close).toHaveBeenCalledTimes(1);
  });
});
