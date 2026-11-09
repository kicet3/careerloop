/**
 * Python 워커 계약 파일이 최신인지 확인한다. TS 쪽(스키마·단가·서명·그래프 텍스트)을 고쳤으면
 * `UPDATE_WORKER_FIXTURES=1 npx vitest run src/lib/worker/fixtures.test.ts`(또는 `npx tsx scripts/export-worker-schemas.ts`)로 다시 만들고
 * `cd worker && uv run pytest -q`로 Python 쪽도 맞는지 본다.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildWorkerFixtures } from "./fixtures";

const ROOT = path.resolve(import.meta.dirname, "../../..");
const files = buildWorkerFixtures();
const update = process.env.UPDATE_WORKER_FIXTURES === "1";

describe("워커 계약 파일", () => {
  for (const [rel, content] of Object.entries(files)) {
    it(`${rel}이 최신이다`, () => {
      const abs = path.join(ROOT, rel);
      if (update) {
        mkdirSync(path.dirname(abs), { recursive: true });
        writeFileSync(abs, content);
      }
      let current = "";
      try {
        current = readFileSync(abs, "utf8");
      } catch {
        // 없으면 아래 비교에서 실패한다.
      }
      expect(current, `${rel}이 오래됐습니다. UPDATE_WORKER_FIXTURES=1 npx vitest run src/lib/worker/fixtures.test.ts`).toBe(content);
    });
  }
});
