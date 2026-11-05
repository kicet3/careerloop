/**
 * 실제 CLI 엔진으로 13단계 파이프라인을 끝까지 돌리는 선택 실행 테스트(구독 사용량을 쓴다).
 *   LIVE_CLI=claude-cli|codex-cli CLI_PROVIDERS=1 CLAUDE_CLI_CONFIG_DIR=system CODEX_CLI_HOME=system npx vitest run src/lib/llm/cli.live.test.ts
 * LIVE_CLI가 없으면 건너뛴다.
 */
import { describe, expect, it, vi } from "vitest";
import { STAGE_KEYS, type StageKey } from "@/lib/domain/schemas";
import { runPipeline } from "@/lib/panel/pipeline";
import { SAMPLE_JD, SAMPLE_RESUME } from "@/lib/report/__fixtures__/sample";
import { ClaudeCliLlmClient, CodexCliLlmClient } from "./cli";

vi.mock("server-only", () => ({}));

const target = process.env.LIVE_CLI;

describe.skipIf(target !== "claude-cli" && target !== "codex-cli")(`live ${target}`, () => {
  it(
    "13단계가 모두 스키마를 통과한다",
    async () => {
      const llm = target === "claude-cli" ? new ClaudeCliLlmClient() : new CodexCliLlmClient();
      const done: StageKey[] = [];
      const failed: string[] = [];
      const t0 = Date.now();
      const { ok } = await runPipeline(
        {
          resumeText: SAMPLE_RESUME,
          resumeFileName: "sample.pdf",
          targetRole: "결제 플랫폼 백엔드 엔지니어",
          jdText: SAMPLE_JD,
          situation: "general",
          notes: null,
        },
        {
          llm,
          existing: {},
          async onStageStart(stage) {
            console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] start ${stage}`);
          },
          async onStageDone(stage, _output, usage) {
            done.push(stage);
            console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] done ${stage}`, JSON.stringify(usage));
          },
          async onStageFailed(stage, error) {
            failed.push(`${stage}: ${error.message}`);
            console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] FAILED ${stage}: ${error.message}`);
          },
        },
      );
      console.log(`total ${((Date.now() - t0) / 1000).toFixed(0)}s`);
      expect(failed).toEqual([]);
      expect(ok).toBe(true);
      expect(done.sort()).toEqual([...STAGE_KEYS].sort());
    },
    40 * 60_000,
  );
});
