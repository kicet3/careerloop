import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { decodeEncKey, githubConfigured, githubPartialConfigWarning } from "@/lib/config/env-rules";
import { keyIdOf, open, seal, SecretBoxError } from "./secret-box";

const key = randomBytes(32);
const other = randomBytes(32);

describe("secret-box(AES-256-GCM)", () => {
  it("암호화·복호화 왕복, 매번 다른 IV, 형식 v1.<keyId>.<iv>.<ct>.<tag>", () => {
    const a = seal("ghu_secret", "github-token:u1:access", { current: key });
    const b = seal("ghu_secret", "github-token:u1:access", { current: key });
    expect(a).not.toBe(b);
    expect(a).not.toContain("ghu_secret");
    const parts = a.split(".");
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe("v1");
    expect(parts[1]).toBe(keyIdOf(key));
    expect(open(a, "github-token:u1:access", { current: key })).toBe("ghu_secret");
  });

  it("변조·다른 AAD(다른 사용자·칸)·다른 키는 풀리지 않는다", () => {
    const sealed = seal("ghu_secret", "github-token:u1:access", { current: key });
    const parts = sealed.split(".");
    const ct = Buffer.from(parts[3]!, "base64url");
    ct[0] = ct[0]! ^ 1;
    const tampered = [...parts.slice(0, 3), ct.toString("base64url"), parts[4]].join(".");
    expect(() => open(tampered, "github-token:u1:access", { current: key })).toThrow(SecretBoxError);
    expect(() => open(sealed, "github-token:u2:access", { current: key })).toThrow(SecretBoxError);
    expect(() => open(sealed, "github-token:u1:refresh", { current: key })).toThrow(SecretBoxError);
    expect(() => open(sealed, "github-token:u1:access", { current: other })).toThrow(SecretBoxError);
    expect(() => open("garbage", "x", { current: key })).toThrow(SecretBoxError);
  });

  it("예전 키(PREVIOUS)로 만든 암호문도 푼다", () => {
    const old = seal("ghr_old", "aad", { current: other });
    expect(open(old, "aad", { current: key, previous: other })).toBe("ghr_old");
  });

  it("키가 32바이트가 아니면 거부한다", () => {
    expect(() => seal("x", "a", { current: randomBytes(16) })).toThrow(SecretBoxError);
    expect(decodeEncKey(randomBytes(16).toString("base64"))).toBeNull();
    expect(decodeEncKey("not base64!!")).toBeNull();
    expect(decodeEncKey(key.toString("base64"))?.equals(key)).toBe(true);
    expect(decodeEncKey(key.toString("base64url"))?.equals(key)).toBe(true);
  });

  it("githubConfigured: 클라이언트 ID·비밀·올바른 키가 모두 있어야 한다", () => {
    const full = { GITHUB_APP_CLIENT_ID: "id", GITHUB_APP_CLIENT_SECRET: "s", GITHUB_TOKEN_ENC_KEY: key.toString("base64") };
    expect(githubConfigured(full)).toBe(true);
    expect(githubConfigured({ ...full, GITHUB_TOKEN_ENC_KEY: "short" })).toBe(false);
    expect(githubConfigured({ ...full, GITHUB_APP_CLIENT_SECRET: "" })).toBe(false);
    expect(githubConfigured({})).toBe(false);
    expect(githubPartialConfigWarning({})).toBeNull();
    expect(githubPartialConfigWarning(full)).toBeNull();
    expect(githubPartialConfigWarning({ GITHUB_APP_CLIENT_ID: "id" })).toMatch(/일부만/);
    expect(githubPartialConfigWarning({ ...full, GITHUB_TOKEN_ENC_KEY: "short" })).toMatch(/32바이트/);
  });
});
