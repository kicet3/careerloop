import { describe, expect, it } from "vitest";
import { z } from "zod";
import { looksLikeRefusal, parseClaudeResult, parseCodexEvents, validateOutput } from "./cli-output";

describe("parseClaudeResult", () => {
  it("structured_output·usage·실제 모델을 읽는다", () => {
    const r = parseClaudeResult(
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "{}",
        structured_output: { verdict: "FAIL" },
        usage: { input_tokens: 2, output_tokens: 663, cache_read_input_tokens: 10, cache_creation_input_tokens: 1164 },
        modelUsage: { "claude-opus-5-5": {} },
      }),
    );
    expect(r).toEqual({
      value: { verdict: "FAIL" },
      cliError: null,
      modelText: null,
      toolItems: [],
      usage: { inputTokens: 2, outputTokens: 663, cacheReadTokens: 10, cacheWriteTokens: 1164 },
      model: "claude-opus-5-5",
    });
  });

  it("is_error면 결과 문구를 오류로 돌려준다", () => {
    const r = parseClaudeResult(
      JSON.stringify({ type: "result", subtype: "success", is_error: true, result: "Not logged in · Please run /login" }),
    );
    expect(r.value).toBeNull();
    expect(r.cliError).toContain("Not logged in");
  });

  it("JSON이 아니면 원문 끝부분을 CLI 오류로", () => {
    expect(parseClaudeResult("boom").cliError).toBe("boom");
  });

  it("모델이 JSON 대신 글을 쓰면 CLI 오류가 아니라 modelText(로그인·한도 판정에 쓰지 않음)", () => {
    const r = parseClaudeResult(
      JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "API 401 오류 대응, 월 사용량 한도 관리 경험" }),
    );
    expect(r.value).toBeNull();
    expect(r.cliError).toBeNull();
    expect(r.modelText).toContain("401");
  });
});

describe("parseCodexEvents", () => {
  const ok = [
    '{"type":"thread.started","thread_id":"t"}',
    '{"type":"turn.started"}',
    '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"{\\"verdict\\":\\"FAIL\\"}"}}',
    '{"type":"turn.completed","usage":{"input_tokens":20218,"cached_input_tokens":218,"output_tokens":172,"reasoning_output_tokens":104}}',
  ].join("\n");

  it("마지막 agent_message를 JSON으로, usage는 캐시분을 나눠서", () => {
    expect(parseCodexEvents(ok)).toEqual({
      value: { verdict: "FAIL" },
      cliError: null,
      modelText: null,
      toolItems: [],
      usage: { inputTokens: 20000, outputTokens: 172, cacheReadTokens: 218, cacheWriteTokens: 0 },
      model: null,
    });
  });

  it("turn.failed면 그 메시지를 오류로", () => {
    const failed = [
      '{"type":"error","message":"Reconnecting... 1/5 (unexpected status 401 Unauthorized)"}',
      '{"type":"turn.failed","error":{"message":"unexpected status 401 Unauthorized: Missing bearer"}}',
    ].join("\n");
    const r = parseCodexEvents(failed);
    expect(r.value).toBeNull();
    expect(r.cliError).toContain("401");
  });

  it("셸·MCP 같은 도구 사용 항목을 기록한다", () => {
    const withTool = [
      '{"type":"item.started","item":{"id":"i1","type":"command_execution","command":"cat .env"}}',
      '{"type":"item.completed","item":{"id":"i1","type":"command_execution","command":"cat .env"}}',
      '{"type":"item.completed","item":{"id":"i0","type":"reasoning","text":"..."}}',
      '{"type":"item.completed","item":{"id":"i2","type":"agent_message","text":"{\\"verdict\\":\\"PASS\\"}"}}',
    ].join("\n");
    expect(parseCodexEvents(withTool).toolItems).toEqual(["command_execution"]);
  });
});

describe("looksLikeRefusal", () => {
  it("짧은 거절 문장만", () => {
    expect(looksLikeRefusal("I can't help with that request.")).toBe(true);
    expect(looksLikeRefusal("죄송하지만 이 요청은 도와드릴 수 없습니다.")).toBe(true);
    expect(looksLikeRefusal('{"verdict": "PASS"')).toBe(false);
  });
});

describe("validateOutput", () => {
  const schema = z.object({ verdict: z.enum(["PASS", "FAIL"]) });
  it("통과·실패", () => {
    expect(validateOutput({ verdict: "PASS" }, schema)).toEqual({ ok: true, value: { verdict: "PASS" } });
    const bad = validateOutput({ verdict: "MAYBE" }, schema);
    expect(bad.ok).toBe(false);
  });
});
