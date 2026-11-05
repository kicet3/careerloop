/**
 * 그래프 채팅 → 실제 Neo4j 적용 통합 테스트. NEO4J_URI가 있을 때만 돈다(set -a; . ./.env.local; set +a; npx vitest run src/lib/chat).
 * LLM은 가짜(FakeLlmClient), DB는 임시 SQLite. 테스트 사용자 그래프는 끝에 지운다.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { nanoid } from "nanoid";
import { afterAll, describe, expect, it, vi } from "vitest";
import { FakeLlmClient } from "@/test/fake-llm";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));

const enabled = Boolean(process.env.NEO4J_URI);
const userId = `test_${nanoid(8)}`;

describe.skipIf(!enabled)("graph chat + Neo4j", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "rp-graph-chat-int-"));
  process.env.DATABASE_URL = `file:${path.join(dir, "test.db")}`;
  let close = () => {};

  afterAll(async () => {
    const { deleteUserGraph } = await import("@/lib/graph/service");
    const { closeDriver } = await import("@/lib/graph/client");
    await deleteUserGraph(userId);
    await closeDriver();
    close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("대화 변경안을 적용하면 그래프에 반영되고, 같은 내용을 다시 말해도 노드가 중복되지 않는다", async () => {
    const { ensureDatabase } = await import("@/lib/db/migrate");
    await ensureDatabase();
    const { db, schema } = await import("@/lib/db/client");
    close = () => db.$client.close();
    await db.insert(schema.users).values({ id: userId, email: `${userId}@x.com`, passwordHash: "x" });
    const gc = await import("./graph-chat");
    const { getCareerGraph } = await import("@/lib/graph/service");
    const deps = { ...gc.defaultGraphChatDeps, createClient: () => new FakeLlmClient({ delayMs: 0 }) };

    const t = await gc.createGraphThread(userId);
    await gc.startGraphChatMessage(userId, t.id, "스터디에서 Kotlin으로 일정 공유 앱을 만들었어요", deps);
    const first = await gc.runGraphChatReply(userId, t.id, "anthropic", "테스터", deps);
    expect(first!.status).toBe("proposed");
    const applied = await gc.applyGraphProposal(userId, first!.id, deps);
    expect(applied.message.status).toBe("applied");

    let graph = await getCareerGraph(userId);
    const kotlin = graph.nodes.filter((n) => n.label === "Skill");
    expect(kotlin).toHaveLength(1);
    expect(graph.edges.some((e) => e.type === "HAS_EXPERIENCE" && e.from === "me")).toBe(true);

    await gc.startGraphChatMessage(userId, t.id, "Kotlin으로 사이드 프로젝트도 했어요", deps);
    const second = await gc.runGraphChatReply(userId, t.id, "anthropic", "테스터", deps);
    await gc.applyGraphProposal(userId, second!.id, deps);
    graph = await getCareerGraph(userId);
    expect(graph.nodes.filter((n) => n.label === "Skill")).toHaveLength(1);
    expect(graph.nodes.filter((n) => n.label === "Experience")).toHaveLength(2);
    // 두 경험 모두 같은 Kotlin 노드에 연결된다
    expect(graph.edges.filter((e) => e.type === "USED_SKILL" && e.to === kotlin[0]!.id)).toHaveLength(2);
  });
});
