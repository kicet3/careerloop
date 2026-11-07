/**
 * 경험 질문하기(graph-qa.ts) 연결: GRAPH_RAG 기본 켬, 저장 형태, 조회 시 인용 재검증(사양 14③), 이전 대화 정리(삭제된 근거의 fact 제외),
 * 결과 종류별 저장(사양 17 — 답·실패·차단의 data 종류가 다름), 보안 실패는 기존 경로로 넘어가지 않음, 보안과 무관한 실패는 기존 경로로.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { TestDb } from "@/test/db";
import type { GraphAgentAnswerData } from "@/lib/domain/chat";
import { GraphUnavailableError } from "@/lib/graph/errors";
import type { LlmClient } from "@/lib/llm/types";
import { getChunksByIds, searchChunksSql } from "./chunks/store";
import { A_ID, A_NODES, B_ID, callTools, evidenceIn, expectNoB, finalAnswer, ScriptedLlm } from "./__fixtures__/two-users";
import { setupAgentDb } from "./__fixtures__/agent-harness.test-utils";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));
process.env.NEO4J_URI ??= "bolt://unused";

let tdb: TestDb;
let graphs: Awaited<ReturnType<typeof setupAgentDb>>["graphs"];
let qa: typeof import("@/lib/chat/graph-qa");
beforeAll(async () => {
  ({ tdb, graphs } = await setupAgentDb());
  qa = await import("@/lib/chat/graph-qa");
});
afterAll(() => tdb.close());
beforeEach(() => {
  delete process.env.GRAPH_RAG;
});

const deps = (client: LlmClient, agent: Record<string, unknown> = {}) => ({
  getGraph: (u: string) => graphs.load(u),
  createClient: () => client,
  now: () => Date.now(),
  agent,
});

/** 성과 노드를 찾아 그대로 인용하는 스크립트. */
const achievementScript = () =>
  new ScriptedLlm((i, call) => {
    if (i === 0) return callTools({ tool: "resolve_entity", args: { text: "정산 시간", labels: ["Achievement"] } });
    const a = evidenceIn(call.user)[0];
    return a
      ? finalAnswer([
          { text: "정산 시간 6시간에서 40분으로 단축했습니다.", kind: "fact", evidenceIds: [a.id] },
          { text: "수치의 기준을 함께 말하면 좋아요.", kind: "advice", evidenceIds: [] },
        ])
      : finalAnswer([{ text: "그래프에 아직 없습니다.", kind: "gap", evidenceIds: [] }], true);
  });

async function askA(question: string, client: LlmClient, agent: Record<string, unknown> = {}) {
  const t = await qa.createQaThread(A_ID);
  await qa.startQaMessage(A_ID, t.id, question);
  const reply = await qa.runQaReply(A_ID, t.id, "anthropic", null, deps(client, agent));
  return { threadId: t.id, reply };
}

describe("graph-qa ↔ 에이전트", () => {
  it("답 저장 → 조회 시 서버 전용 필드 제거, 노드 삭제 뒤 exists:false·snippet 비움(사양 14③), 다음 질문 이력에서 그 fact 제외", async () => {
    const llm = achievementScript();
    const { threadId, reply } = await askA("정산 성과가 뭐였어?", llm);
    expect(reply).toMatchObject({ status: null, data: { kind: "graph-agent-answer", grounded: true } });
    const data = reply!.data as GraphAgentAnswerData;
    expect(data.citations[0]).toMatchObject({ kind: "node", sourceKey: A_NODES.achievement });
    expect(data.suggestions).toBeInstanceOf(Array);

    const view = await qa.getQaThreadView(A_ID, threadId, null, deps(llm));
    const shown = view.messages.at(-1)!.data as GraphAgentAnswerData;
    expect(shown.citations[0]).toMatchObject({ exists: true, nodeId: A_NODES.achievement });
    expect(shown.citations[0]).not.toHaveProperty("sourceKey");
    expect(shown.citations[0]).not.toHaveProperty("version");

    graphs.deleteNode(A_ID, A_NODES.achievement);
    const after = (await qa.getQaThreadView(A_ID, threadId, null, deps(llm))).messages.at(-1)!.data as GraphAgentAnswerData;
    expect(after.citations[0]).toMatchObject({ exists: false, snippet: "" });
    expect(after.citations[0]!.pathText).toBeUndefined();

    // 다음 질문: 이전 답의 fact(삭제된 근거)는 이력에 없고, advice는 남는다.
    const next = new ScriptedLlm(() => finalAnswer([{ text: "확인했어요.", kind: "advice", evidenceIds: [] }]));
    await qa.startQaMessage(A_ID, threadId, "그 성과 다시 정리해 줘");
    await qa.runQaReply(A_ID, threadId, "anthropic", null, deps(next));
    const history = next.calls[0]!.user.slice(0, next.calls[0]!.user.indexOf("질문:"));
    expect(history).not.toContain("6시간에서 40분");
    expect(history).toContain("수치의 기준을 함께 말하면 좋아요.");
    expect(history).not.toMatch(/ev_[A-Za-z0-9_-]{22}/);
    graphs.graphs.set(A_ID, (await import("./__fixtures__/two-users")).graphA());
  });

  it("사양 17·8: 답·실패·차단은 저장 data 종류가 다르고, 보안 실패는 기존 경로로 넘어가지 않는다", async () => {
    const ok = await askA("정산 성과가 뭐였어?", achievementScript());
    expect(ok.reply).toMatchObject({ status: null, data: { kind: "graph-agent-answer" } });

    const unavailable = await askA("정산 성과가 뭐였어?", achievementScript(), { loadGraph: async () => Promise.reject(new GraphUnavailableError()) });
    expect(unavailable.reply).toMatchObject({ status: "failed", data: null });
    expect(unavailable.reply!.content).toContain("답변을 만들지 못했습니다");

    const bRows = await tdb.pglite.query<{ id: string }>(`SELECT id FROM experience_chunks WHERE user_id = $1`, [B_ID]);
    const bChunk = (await getChunksByIds(B_ID, [bRows.rows[0]!.id]))[0]!;
    const blockedLlm = new ScriptedLlm((i) => (i === 0 ? callTools({ tool: "search_chunks", args: { query: "결제 개편 역할" } }) : finalAnswer([{ text: "x", kind: "advice", evidenceIds: [] }])));
    const blocked = await askA("결제 개편 때 맡은 역할은?", blockedLlm, {
      searchChunks: async (ctx: { principalUserId: string }, q: Parameters<typeof searchChunksSql>[1]) => [...(await searchChunksSql(ctx, q)), bChunk],
    });
    expect(blocked.reply).toMatchObject({ status: "failed", data: { kind: "graph-agent-blocked", code: "security_blocked" }, content: qa.AGENT_BLOCKED_TEXT });
    expect(blockedLlm.calls.map((c) => c.task)).toEqual(["graph-agent-step"]); // 기존 graph-qa 호출(대체 경로) 없음
    const view = await qa.getQaThreadView(A_ID, blocked.threadId, null, deps(blockedLlm));
    expect(view.canRetry).toBe(true);
    expectNoB([JSON.stringify(view), ...blockedLlm.texts()]);
    expect(new Set([ok.reply!.data?.kind ?? "null", unavailable.reply!.data?.kind ?? "null", blocked.reply!.data?.kind ?? "null"]).size).toBe(3);
  });

  it("보안과 무관한 실패(출력 형식 오류)는 기존 경로로 대체하고, GRAPH_RAG=0이면 기존 경로만", async () => {
    const calls: string[] = [];
    const { FakeLlmClient } = await import("@/test/fake-llm");
    const fake = new FakeLlmClient();
    const broken: LlmClient = {
      name: "broken",
      generate: async (req) => {
        calls.push(req.task ?? "");
        if (req.task === "graph-agent-step" || req.task === "graph-agent-final") return { output: { nonsense: true } as never, usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "x" };
        return fake.generate(req);
      },
    };
    // 스키마가 맞지 않는 출력을 낸 클라이언트 흉내 → LlmPermanentError(invalid_output)
    const strict: LlmClient = {
      name: "strict",
      generate: async (req) => {
        const r = await broken.generate(req);
        const p = req.schema.safeParse(r.output);
        if (!p.success) throw new (await import("@/lib/llm/types")).LlmPermanentError("x", "invalid_output");
        return { ...r, output: p.data };
      },
    };
    const fb = await askA("결제 시스템 개편 성과는?", strict);
    expect(calls).toEqual(["graph-agent-step", "graph-qa"]);
    expect(fb.reply).toMatchObject({ status: null, data: { kind: "graph-answer" } });

    process.env.GRAPH_RAG = "0";
    calls.length = 0;
    const legacy = await askA("결제 시스템 개편 성과는?", strict);
    expect(calls).toEqual(["graph-qa"]);
    expect(legacy.reply!.data?.kind).toBe("graph-answer");
  });

  it("폴백·GRAPH_RAG=0 경로의 이전 대화도 재검증한다: 근거가 사라진 에이전트 fact는 기존 파이프라인 프롬프트에 없다(§9)", async () => {
    const { threadId } = await askA("정산 성과가 뭐였어?", achievementScript());
    graphs.deleteNode(A_ID, A_NODES.achievement);
    try {
      const seen: { task: string; user: string }[] = [];
      const { FakeLlmClient } = await import("@/test/fake-llm");
      const { LlmPermanentError } = await import("@/lib/llm/types");
      const fake = new FakeLlmClient();
      const client: LlmClient = {
        name: "fb",
        generate: async (req) => {
          seen.push({ task: req.task ?? "", user: req.user });
          if (req.task === "graph-agent-step" || req.task === "graph-agent-final") throw new LlmPermanentError("x", "invalid_output");
          return fake.generate(req);
        },
      };
      await qa.startQaMessage(A_ID, threadId, "그 성과 다시 정리해 줘");
      await qa.runQaReply(A_ID, threadId, "anthropic", null, deps(client));
      expect(seen.map((x) => x.task)).toEqual(["graph-agent-step", "graph-qa"]);
      for (const x of seen) {
        expect(x.user).not.toContain("6시간에서 40분");
        expect(x.user).toContain("수치의 기준을 함께 말하면 좋아요.");
      }
      process.env.GRAPH_RAG = "0";
      seen.length = 0;
      await qa.startQaMessage(A_ID, threadId, "한 번 더 정리해 줘");
      await qa.runQaReply(A_ID, threadId, "anthropic", null, deps(client));
      expect(seen.map((x) => x.task)).toEqual(["graph-qa"]);
      expect(seen[0]!.user).not.toContain("6시간에서 40분");
    } finally {
      graphs.graphs.set(A_ID, (await import("./__fixtures__/two-users")).graphA());
    }
  });

  it("이전 대화를 만들 때 그래프를 못 읽으면 그래프 근거 fact는 뺀다(미정 = 무효, fail-closed)", async () => {
    const { threadId } = await askA("정산 성과가 뭐였어?", achievementScript());
    let n = 0;
    const flaky = {
      ...deps(new ScriptedLlm(() => finalAnswer([{ text: "확인했어요.", kind: "advice", evidenceIds: [] }]))),
      getGraph: (u: string) => (n++ === 0 ? Promise.reject(new Error("neo4j blip")) : graphs.load(u)),
    };
    const next = flaky.createClient() as ScriptedLlm;
    await qa.startQaMessage(A_ID, threadId, "그 성과 다시 정리해 줘");
    await qa.runQaReply(A_ID, threadId, "anthropic", null, flaky);
    const history = next.calls[0]!.user.slice(0, next.calls[0]!.user.indexOf("질문:"));
    expect(history).not.toContain("6시간에서 40분");
    expect(history).toContain("수치의 기준을 함께 말하면 좋아요.");
  });

  it("경로 인용: 경로의 관계를 지우면 조회 때 exists:false이고 다음 질문 이력에서 그 fact가 빠진다(사양 14)", async () => {
    const llm = new ScriptedLlm((i, call) => {
      if (i === 0) return callTools({ tool: "resolve_entity", args: { text: "결제 시스템 개편", labels: ["Project"] } });
      if (i === 1) {
        const p = evidenceIn(call.user).find((e) => e.handle?.startsWith("N"))!;
        return callTools({
          tool: "query_graph",
          args: { plan: { start: { var: "p", label: "Project", handles: [p.handle] }, hops: [{ rel: "USED_SKILL", dir: "out", to: { var: "s", label: "Skill" } }], return: { kind: "paths" } } },
        });
      }
      const path = evidenceIn(call.user).find((e) => e.kind === "경로")!;
      return finalAnswer([{ text: "결제 시스템 개편에서 Kotlin을 사용했습니다.", kind: "fact", evidenceIds: [path.id] }]);
    });
    const { threadId, reply } = await askA("결제 개편에서 쓴 기술은?", llm);
    expect((reply!.data as GraphAgentAnswerData).citations[0]).toMatchObject({ kind: "path" });
    const before = (await qa.getQaThreadView(A_ID, threadId, null, deps(llm))).messages.at(-1)!.data as GraphAgentAnswerData;
    expect(before.citations[0]!.exists).toBe(true);
    const g = graphs.graphs.get(A_ID)!;
    g.edges = g.edges.filter((e) => e.type !== "USED_SKILL");
    try {
      const after = (await qa.getQaThreadView(A_ID, threadId, null, deps(llm))).messages.at(-1)!.data as GraphAgentAnswerData;
      expect(after.citations[0]).toMatchObject({ exists: false, snippet: "" });
      const next = new ScriptedLlm(() => finalAnswer([{ text: "확인했어요.", kind: "advice", evidenceIds: [] }]));
      await qa.startQaMessage(A_ID, threadId, "그 기술 다시 알려줘");
      await qa.runQaReply(A_ID, threadId, "anthropic", null, deps(next));
      expect(next.calls[0]!.user.slice(0, next.calls[0]!.user.indexOf("질문:"))).not.toContain("Kotlin을 사용했습니다");
    } finally {
      graphs.graphs.set(A_ID, (await import("./__fixtures__/two-users")).graphA());
    }
  });

  it("집계 인용: 입력 노드가 바뀌어 다시 계산한 값이 다르면 exists:false", async () => {
    const llm = new ScriptedLlm((i, call) => {
      if (i === 0) return callTools({ tool: "query_graph", args: { plan: { start: { var: "p", label: "Project" }, return: { kind: "aggregate", fn: "count", var: "p" } } } });
      const agg = evidenceIn(call.user).find((e) => e.kind === "집계")!;
      return finalAnswer([{ text: "프로젝트는 1개입니다.", kind: "fact", evidenceIds: [agg.id] }]);
    });
    const { threadId, reply } = await askA("프로젝트 몇 개 했어?", llm);
    expect((reply!.data as GraphAgentAnswerData).citations[0]).toMatchObject({ kind: "aggregate" });
    expect(((await qa.getQaThreadView(A_ID, threadId, null, deps(llm))).messages.at(-1)!.data as GraphAgentAnswerData).citations[0]!.exists).toBe(true);
    graphs.graphs.get(A_ID)!.nodes.push({ id: "na_p2", label: "Project", props: { name: "새 프로젝트" }, createdAt: 2, updatedAt: 2 } as never);
    try {
      const after = (await qa.getQaThreadView(A_ID, threadId, null, deps(llm))).messages.at(-1)!.data as GraphAgentAnswerData;
      expect(after.citations[0]!.exists).toBe(false);
      expect(after.citations[0]).not.toHaveProperty("aggregatePlan");
    } finally {
      graphs.graphs.set(A_ID, (await import("./__fixtures__/two-users")).graphA());
    }
  });

  it("색인 안내는 저장하지 않고 조회 때 지금 상태로 마지막 에이전트 답에만 붙인다", async () => {
    const { bumpSourceVersion, markIndexed, readRagState } = await import("./versions");
    const { threadId } = await askA("정산 성과가 뭐였어?", achievementScript());
    await qa.startQaMessage(A_ID, threadId, "한 번 더");
    const second = await qa.runQaReply(A_ID, threadId, "anthropic", null, deps(achievementScript()));
    expect(second!.data).not.toHaveProperty("indexStale");
    await bumpSourceVersion(A_ID);
    const view = await qa.getQaThreadView(A_ID, threadId, null, deps(achievementScript()));
    const agentMsgs = view.messages.filter((m) => m.data?.kind === "graph-agent-answer");
    expect(agentMsgs.map((m) => (m.data as GraphAgentAnswerData).indexStale ?? false)).toEqual([false, true]);
    await markIndexed(A_ID, (await readRagState(A_ID)).sourceVersion);
    const fresh = await qa.getQaThreadView(A_ID, threadId, null, deps(achievementScript()));
    expect(fresh.messages.some((m) => m.data?.kind === "graph-agent-answer" && (m.data as GraphAgentAnswerData).indexStale)).toBe(false);
  });
});
