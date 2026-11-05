import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { cliProvidersEnabled } = await import("./cli");

describe("cliProvidersEnabled", () => {
  it("CLI_PROVIDERS=1일 때만 켠다(DEV)", () => {
    expect(cliProvidersEnabled({})).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "0" })).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1" })).toBe(true);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1", APP_ENV: "DEV" })).toBe(true);
  });

  it("PRODUCTION은 CLI_PROVIDERS_IN_PRODUCTION=1까지 있어야 켠다", () => {
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1", APP_ENV: "PRODUCTION" })).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS_IN_PRODUCTION: "1", APP_ENV: "PRODUCTION" })).toBe(false);
    expect(cliProvidersEnabled({ CLI_PROVIDERS: "1", CLI_PROVIDERS_IN_PRODUCTION: "1", APP_ENV: "PRODUCTION" })).toBe(true);
  });
});
