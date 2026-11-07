/**
 * 사양 테스트 10(같은 질문의 캐시를 사용자끼리 공유하지 않음)·15(동시 요청 컨텍스트 혼입 없음)·16(LLM 입력에 B 없음).
 * 가짜 LLM은 tests/fake-llm.ts의 결정적 에이전트(첫 스텝 resolve_entity+search_chunks, 다음 스텝 받은 근거로 답)다.
 */
import { readdirSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/db";
import { FakeLlmClient } from "@/test/fake-llm";
import type { GenerateResult, LlmClient, LlmRequest } from "@/lib/llm/types";
import type { AgentOutcome } from "./agent";
import { searchChunksSql } from "./chunks/store";
import { A_ID, A_NODES, B_ID, B_NODES, B_SECRET, expectNoB } from "./__fixtures__/two-users";
import { agentDeps, setupAgentDb } from "./__fixtures__/agent-harness.test-utils";

vi.mock("server-only", () => ({}));

let tdb: TestDb;
let graphs: Awaited<ReturnType<typeof setupAgentDb>>["graphs"];
beforeAll(async () => {
  ({ tdb, graphs } = await setupAgentDb());
});
afterAll(() => tdb.close());

/** 받은 프롬프트를 기록하는 결정적 가짜(호출마다 무작위 지연). */
class Recording implements LlmClient {
  readonly name = "rec";
  readonly prompts: string[] = [];
  private readonly fake = new FakeLlmClient();
  constructor(private readonly jitter = 0) {}
  async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
    this.prompts.push(`${req.system}\n${req.user}`);
    if (this.jitter) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * this.jitter)));
    return this.fake.generate(req);
  }
}

async function ask(userId: string, question: string, client: LlmClient, jitter = 0): Promise<AgentOutcome> {
  const { runAgentQa } = await import("./agent");
  const deps = agentDeps(graphs, {
    searchChunks: async (ctx, q) => {
      if (jitter) await new Promise((r) => setTimeout(r, Math.floor(Math.random() * jitter)));
      return searchChunksSql(ctx, q);
    },
  });
  return runAgentQa({ userId, threadId: `t_${userId}`, question, history: "(이전 대화 없음)", client, deps, startedAt: Date.now() });
}

/** A만 가진 문자열(B 쪽 출력에 나오면 안 된다). */
const A_ONLY = ["정산 시간 6시간에서 40분", A_NODES.achievement, "a/payments", "백엔드 리드"];

describe("사양 10: 같은 질문, 다른 사용자", () => {
  it("A 다음 B가 같은 질문 → 각자 자기 근거만, 두 번째 요청 프롬프트에 첫 요청의 근거 id·텍스트 없음", async () => {
    const q = "결제 시스템 개편 성과와 역할은?";
    const la = new Recording();
    const a = await ask(A_ID, q, la);
    const lb = new Recording();
    const b = await ask(B_ID, q, lb);
    expect(a.kind).toBe("answer");
    expect(b.kind).toBe("answer");
    if (a.kind !== "answer" || b.kind !== "answer") return;
    expect(a.requestId).not.toBe(b.requestId);
    expectNoB([...la.prompts, JSON.stringify(a)]);
    const aIds = a.data.citations.map((c) => c.evidenceId);
    expect(aIds.length).toBeGreaterThan(0);
    for (const p of lb.prompts) {
      for (const id of aIds) expect(p).not.toContain(id);
      for (const s of A_ONLY) expect(p).not.toContain(s);
    }
    expect(JSON.stringify(b)).toContain(B_SECRET); // B는 자기 데이터를 본다(대조군)
    // 같은 사용자가 다시 물어도 이전 요청의 근거 id는 재사용되지 않는다(요청마다 새 레지스트리).
    const la2 = new Recording();
    const a2 = await ask(A_ID, q, la2);
    if (a2.kind !== "answer") throw new Error(a2.kind);
    for (const id of aIds) expect(JSON.stringify(a2)).not.toContain(id);
  });

  it("rag/ 모듈은 요청 뒤에도 공유 가변 상태(Map·Set·WeakMap 등)를 export하지 않는다", async () => {
    const dir = import.meta.dirname;
    const files = [...readdirSync(dir), ...readdirSync(path.join(dir, "chunks")).map((f) => `chunks/${f}`), ...readdirSync(path.join(dir, "graph")).map((f) => `graph/${f}`), ...readdirSync(path.join(dir, "tools")).map((f) => `tools/${f}`)].filter(
      (f) => f.endsWith(".ts") && !f.endsWith(".test.ts"),
    );
    expect(files.length).toBeGreaterThan(15);
    for (const f of files) {
      const mod = (await import(/* @vite-ignore */ `./${f.replace(/\.ts$/, "")}`)) as Record<string, unknown>;
      for (const [k, v] of Object.entries(mod)) {
        const bad = v instanceof Map || v instanceof Set || v instanceof WeakMap || v instanceof WeakSet || (Array.isArray(v) && !Object.isFrozen(v));
        expect(bad, `${f}:${k}`).toBe(false);
      }
    }
  });
});

describe("사양 15: 동시 요청", () => {
  it("A와 B 요청을 20회 교차(무작위 지연) → 각 요청의 프롬프트·결과는 자기 사용자 것만, requestId 교차 없음", async () => {
    const runs = Array.from({ length: 20 }, (_, i) => {
      const user = i % 2 === 0 ? A_ID : B_ID;
      const llm = new Recording(15);
      return ask(user, "결제 시스템 개편에서 한 일은?", llm, 15).then((out) => ({ user, llm, out }));
    });
    const results = await Promise.all(runs);
    const reqIds = new Set<string>();
    for (const { user, llm, out } of results) {
      expect(out.kind).toBe("answer");
      if (out.kind !== "answer") continue;
      expect(reqIds.has(out.requestId)).toBe(false);
      reqIds.add(out.requestId);
      if (user === A_ID) {
        expectNoB([...llm.prompts, JSON.stringify(out)]);
        expect(llm.prompts.join("\n")).toContain("결제 시스템 개편");
      } else {
        for (const p of [...llm.prompts, JSON.stringify(out)]) for (const s of A_ONLY) expect(p).not.toContain(s);
        expect(JSON.stringify(out)).not.toContain(A_NODES.project);
        expect(llm.prompts.join("\n")).toContain(B_NODES.project === "nb_project" ? "결제 시스템 개편" : "");
      }
    }
    expect(reqIds.size).toBe(20);
  });
});
