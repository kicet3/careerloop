/**
 * Python 워커 계약 파일(출력 JSON Schema·그래프 도메인 표·pytest fixture)을 다시 만든다(docs/PYTHON-WORKER.md §4).
 *   npx tsx scripts/export-worker-schemas.ts
 * 내용은 src/lib/worker/fixtures.ts가 정하고, src/lib/worker/fixtures.test.ts가 최신인지 확인한다.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { buildWorkerFixtures } from "../src/lib/worker/fixtures";

const root = path.resolve(import.meta.dirname, "..");
for (const [rel, content] of Object.entries(buildWorkerFixtures())) {
  const abs = path.join(root, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, content);
  console.log(`wrote ${rel}`);
}
