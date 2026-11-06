/**
 * 사용자 간 경험 그래프 격리 — MCP 경로(POST /api/mcp). 토큰 A로는 A의 그래프만 나온다.
 * A·B가 같은 노드 id(p1)를 쓰고 B의 이름·속성에만 표지(B_MARK)가 있다. 모든 도구·리소스를 토큰 A로 불러 B 표지가 없는지,
 * B에만 있는 노드 id는 찾지 못하는지, 그래프 로더가 잘못 B의 그래프를 돌려줘도(소유자 표시가 다름) 도구 오류로 막는지 본다.
 * 토큰 저장소·동의·레이트 리밋·그래프 저장소만 가짜로 바꾸고 인증(src/lib/mcp/auth.ts)과 SDK 서버는 진짜다.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CareerGraph, GraphNode, NodeLabel } from "@/lib/domain/graph";
import type { McpTokenRecord } from "@/lib/mcp/tokens";

vi.mock("server-only", () => ({}));

const B_MARK = "ZQXBMARK";
const A_MARK = "ALPHAMARK";
const TOKEN_A = `clp_${"a".repeat(43)}`;
const TOKEN_B = `clp_${"b".repeat(43)}`;

const state = vi.hoisted(() => ({
  graphs: new Map<string, unknown>(),
  /** 버그 흉내: 지정하면 요청 사용자와 상관없이 이 사용자의 그래프를 돌려준다. */
  leakFrom: null as string | null,
}));

const record = (userId: string, name: string): McpTokenRecord => ({
  id: `mcp_${userId}`,
  prefix: `clp_${userId}`,
  scopes: ["graph:read"],
  expiresAt: null,
  revokedAt: null,
  lastUsedAt: null,
  user: { id: userId, name, status: "approved" },
});

vi.mock("@/lib/mcp/tokens", () => ({
  findMcpToken: vi.fn(async (t: string) => (t === TOKEN_A ? record("ua", "에이") : t === TOKEN_B ? record("ub", "비") : null)),
  touchMcpToken: vi.fn(async () => {}),
}));
vi.mock("@/lib/legal/service", () => ({ getMissingConsents: vi.fn(async () => []) }));
vi.mock("@/lib/auth/db-rate-limit", () => ({
  MCP_REQUEST_LIMIT: { bucket: "mcp", limit: 300, windowMs: 600_000 },
  hitDbLimit: vi.fn(async () => ({ ok: true, retryAfterSec: 0 })),
}));
vi.mock("@/lib/graph/service", async () => {
  const { markGraphOwner } = await import("@/lib/graph/owner");
  return {
    graphEnabled: () => true,
    getCareerGraph: async (userId: string, opts: { personName?: string | null } = {}): Promise<CareerGraph> => {
      const owner = state.leakFrom ?? userId;
      const g = structuredClone(state.graphs.get(owner)) as Omit<CareerGraph, "person">;
      return markGraphOwner<CareerGraph>({ person: { id: "me", name: opts.personName ?? null }, ...g }, owner);
    },
  };
});

function graphOf(mark: string, extra: GraphNode[] = []): Omit<CareerGraph, "person"> {
  const n = (id: string, label: NodeLabel, props: Record<string, unknown>) => ({ id, label, props, createdAt: 1, updatedAt: 1 }) as GraphNode;
  return {
    nodes: [
      n("c1", "Company", { name: `${mark}회사` }),
      n("r1", "Role", { title: `${mark}백엔드`, current: true }),
      n("p1", "Project", { name: `${mark}결제개선`, summary: `${mark} 정산 배치` }),
      n("s1", "Skill", { name: `${mark}Kotlin` }),
      n("a1", "Achievement", { summary: `${mark} 정산 시간 단축`, value: "40분" }),
      ...extra,
    ],
    edges: [
      { id: "WORKED_AT:me:c1", type: "WORKED_AT", from: "me", to: "c1" },
      { id: "HAD_ROLE:me:r1", type: "HAD_ROLE", from: "me", to: "r1" },
      { id: "AT_COMPANY:r1:c1", type: "AT_COMPANY", from: "r1", to: "c1" },
      { id: "WORKED_ON:r1:p1", type: "WORKED_ON", from: "r1", to: "p1" },
      { id: "USED_SKILL:p1:s1", type: "USED_SKILL", from: "p1", to: "s1" },
      { id: "ACHIEVED:p1:a1", type: "ACHIEVED", from: "p1", to: "a1" },
    ],
  };
}

const route = await import("@/app/api/mcp/route");

let rpcId = 0;
async function rpc(method: string, params: Record<string, unknown>, token = TOKEN_A): Promise<{ status: number; text: string }> {
  const res = await route.POST(
    new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        Authorization: `Bearer ${token}`,
        "Mcp-Protocol-Version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: ++rpcId, method, params }),
    }),
  );
  return { status: res.status, text: await res.text() };
}
const call = (name: string, args: Record<string, unknown> = {}, token = TOKEN_A) => rpc("tools/call", { name, arguments: args }, token);

const TOOL_CALLS: [string, Record<string, unknown>][] = [
  ["get_profile_summary", {}],
  ["list_nodes", { includeProps: true, limit: 100 }],
  ["get_node", { id: "me", neighborLimit: 200 }],
  ["get_node", { id: "p1", neighborLimit: 200 }],
  ["search_graph", { query: "결제 개선 성과 Kotlin", limit: 20 }],
  ["get_graph_text", { maxChars: 30_000 }],
  ["get_experience_checklist", {}],
];

beforeEach(() => {
  state.graphs.clear();
  state.graphs.set("ua", graphOf(A_MARK));
  state.graphs.set("ub", graphOf(B_MARK, [{ id: "pb_only", label: "Project", props: { name: `${B_MARK}비밀` }, createdAt: 1, updatedAt: 1 } as GraphNode]));
  state.leakFrom = null;
  vi.spyOn(console, "info").mockImplementation(() => {});
});

describe("MCP: 토큰 주인의 그래프만", () => {
  it("모든 도구·리소스: 토큰 A 응답에 B 표지가 없고 A 데이터는 있다", async () => {
    let sawA = false;
    for (const [name, args] of TOOL_CALLS) {
      const r = await call(name, args);
      expect(r.status, name).toBe(200);
      expect(r.text, name).not.toContain(B_MARK);
      expect(r.text, name).not.toContain('"isError":true');
      sawA ||= r.text.includes(A_MARK);
    }
    const res = await rpc("resources/read", { uri: "careerloop://graph/text" });
    expect(res.text).not.toContain(B_MARK);
    expect(res.text).toContain(A_MARK);
    expect(sawA).toBe(true);
    // 대조: 토큰 B로는 B 데이터가 나온다(표지가 실제로 그래프에 있다).
    expect((await call("get_graph_text", {}, TOKEN_B)).text).toContain(B_MARK);
  });

  it("B에만 있는 노드 id는 토큰 A로 찾지 못한다", async () => {
    const r = await call("get_node", { id: "pb_only" });
    expect(r.text).toContain('"isError":true');
    expect(r.text).not.toContain(B_MARK);
  });

  it("그래프 로더가 B의 그래프를 돌려주면(소유자 표시가 다름) 도구 오류이고 B 데이터는 나가지 않는다", async () => {
    state.leakFrom = "ub";
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const [name, args] of TOOL_CALLS) {
      const r = await call(name, args);
      expect(r.text, name).not.toContain(B_MARK);
      expect(r.text, name).toContain('"isError":true');
    }
    const res = await rpc("resources/read", { uri: "careerloop://graph/text" });
    expect(res.text).not.toContain(B_MARK);
  });
});
