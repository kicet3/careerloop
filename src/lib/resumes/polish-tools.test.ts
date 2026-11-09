/**
 * 다듬기 도구 루프(polish-tools.ts): 도구 인자 검증(strict — 범위 키 거부), 격리(남의 그래프·실제 노드 id·발급 안 한 handle),
 * 호출·글자 예산, 스텝 상한과 최종 답 강제, 남은 시간 부족 시 바로 최종 답, JD 분석 보기(없음 안내·구역·크기 상한).
 * DB 없음 — 그래프는 메모리, JD 자료는 주입, LLM은 스크립트 가짜.
 */
import { describe, expect, it } from "vitest";
import type { CareerGraph } from "@/lib/domain/graph";
import { ResumePolishOutputSchema } from "@/lib/domain/resume-polish";
import { qaGraph } from "@/lib/graph/__fixtures__/qa-graph";
import { markGraphOwner } from "@/lib/graph/owner";
import { SecurityViolation } from "@/lib/rag/errors";
import { unverifiedNumbers } from "@/lib/text/numbers";
import type { GenerateResult, LlmClient, LlmRequest } from "@/lib/llm/types";
import {
  evidenceText,
  POLISH_TOOL_LIMITS,
  type PolishJdSources,
  PolishToolSession,
  polishStepSchema,
  renderJdAnalysis,
  runPolishLoop,
} from "./polish-tools";

const owned = (userId: string, g: CareerGraph = qaGraph()) => markGraphOwner(g, userId);

const NO_JD: PolishJdSources = { company: "토스", roleTitle: "백엔드", hasJd: false, structure: null, analysis: null, tips: null, coverage: [], requirements: null };
const FULL_JD: PolishJdSources = {
  company: "토스",
  roleTitle: "백엔드",
  hasJd: true,
  structure: { source: "llm", summary: "결제 백엔드", duties: ["정산 시스템 개발"], requirements: ["Kafka 운영 경험 3년 이상"], preferred: ["Go 경험"], techStack: ["Kafka", "Go"] },
  analysis: {
    from: "diagnosis",
    summary: "정산 백엔드 개발자",
    seniority: "주니어(1~3년)",
    mustHave: [{ id: "R1", text: "Kafka 운영", category: "skill", jdQuote: "Kafka 운영 경험" }],
    niceToHave: [{ id: "R2", text: "Go", category: "skill", jdQuote: null }],
    keywords: ["Kafka"],
    responsibilities: ["정산 배치 개선"],
    hiddenSignals: [],
  },
  tips: { summary: [{ kind: "required", text: "Kafka 운영" }], sections: [{ section: "experience", tips: [{ tip: "Kafka 경험을 앞에", jdQuote: "Kafka 운영 경험" }] }], keywords: ["Kafka"], experiences: [] },
  coverage: [
    { keyword: "Kafka", included: true },
    { keyword: "Go", included: false },
  ],
  requirements: [{ text: "Kafka 운영", must: true, status: "partial" }],
};

const session = (userId = "ua", graph: CareerGraph | null = owned("ua"), jd: PolishJdSources = FULL_JD) =>
  new PolishToolSession(userId, { graph: async () => graph, jd: async () => jd });

describe("도구 인자 검증(strict)", () => {
  it("범위 키(userId·resumeId·postingId)·모르는 키는 invalid_args", async () => {
    const s = session();
    expect(await s.execute("search_graph", { query: "결제", userId: "ub" })).toMatchObject({ status: "error", code: "invalid_args" });
    expect(await s.execute("get_jd_analysis", { resumeId: "r_other" })).toMatchObject({ status: "error", code: "invalid_args" });
    expect(await s.execute("get_jd_analysis", { section: "secrets" })).toMatchObject({ status: "error", code: "invalid_args" });
    expect(await s.execute("list_nodes", { label: "Person" })).toMatchObject({ status: "error", code: "invalid_args" });
  });

  it("크기 상한: 긴 질의·큰 limit은 거부", async () => {
    const s = session();
    expect(await s.execute("search_graph", { query: "가".repeat(201) })).toMatchObject({ code: "invalid_args" });
    expect(await s.execute("list_nodes", { label: "Project", limit: 500 })).toMatchObject({ code: "invalid_args" });
  });
});

describe("격리", () => {
  it("get_node는 이 요청에서 발급한 handle만: 실제 노드 id는 invalid_args, 발급 안 한 handle은 not_found", async () => {
    const s = session();
    expect(await s.execute("get_node", { id: "p_payment" })).toMatchObject({ status: "error", code: "invalid_args" });
    expect(await s.execute("get_node", { id: "N1" })).toMatchObject({ status: "error", code: "not_found" });
  });

  it("search_graph → handle → get_node(속성·이웃). 결과에 실제 노드 id는 없다", async () => {
    const s = session();
    const found = await s.execute("search_graph", { query: "결제 개선 정산" });
    expect(found.status).toBe("ok");
    if (found.status !== "ok") return;
    expect(found.text).toMatch(/^N1 · /m);
    expect(found.text).toContain("결제 개선");
    const node = await s.execute("get_node", { id: "N1" });
    expect(node.status).toBe("ok");
    if (node.status !== "ok") return;
    expect(node.text).toContain("연결된 노드");
    for (const t of [found.text, node.text]) {
      expect(t).not.toMatch(/\bp_payment\b|\bc_paylab\b|\bs_kafka\b/);
      expect(t).not.toContain("홍길동"); // 본인(Person) 노드는 싣지 않는다.
    }
    expect(s.evidence.join("\n")).toContain("결제 개선");
  });

  it("다른 사용자 표시가 붙은 그래프면 도구 결과가 아니라 예외(루프를 멈춘다)", async () => {
    const ub = qaGraph();
    ub.nodes.push({ id: "p_secret", label: "Project", props: { name: "UB비밀정산프로젝트" }, createdAt: 0, updatedAt: 0 } as CareerGraph["nodes"][number]);
    const s = session("ua", owned("ub", ub));
    await expect(s.execute("search_graph", { query: "정산" })).rejects.toThrow();
    // 소유자 표시가 없는 그래프도 거부한다(fail-closed).
    await expect(session("ua", qaGraph()).execute("list_nodes", { label: "Project" })).rejects.toThrow();
  });

  it("그래프를 못 쓰면 unavailable(JD 도구는 그대로)", async () => {
    const s = session("ua", null);
    expect(await s.execute("search_graph", { query: "결제" })).toMatchObject({ status: "error", code: "unavailable" });
    expect((await s.execute("get_jd_analysis", {})).status).toBe("ok");
  });
});

describe("숫자 검증 근거(evidence)", () => {
  it("서버 표식 숫자(handle·요건 id·'…외 n개')는 근거에서 빠진다 — 지어낸 '5명'·'10%'는 여전히 걸린다", async () => {
    const big = qaGraph();
    for (let i = 0; i < 14; i++) {
      big.nodes.push({ id: `p_y${i}`, label: "Project", props: { name: `사내 도구 개선` }, createdAt: i, updatedAt: i } as CareerGraph["nodes"][number]);
    }
    const s = session("ua", owned("ua", big));
    const listed = await s.execute("list_nodes", { label: "Project", limit: 10 });
    expect(listed.status).toBe("ok");
    if (listed.status !== "ok") return;
    expect(listed.text).toMatch(/^N5 · /m); // LLM에는 handle이 보인다.
    expect(listed.text).toMatch(/…외 \d+개/);
    const node = await s.execute("get_node", { id: "N1" });
    expect(node.status).toBe("ok");
    await s.execute("get_jd_analysis", { section: "requirements" });
    const ev = s.evidence.join("\n");
    expect(ev).not.toMatch(/\bN\d{1,3} · /);
    expect(ev).not.toMatch(/…외 \d+개/);
    expect(ev).not.toMatch(/\bR1 Kafka/);
    expect(ev).toContain("3년 이상"); // 사실 본문의 숫자는 남는다.
    expect(unverifiedNumbers("팀원 5명 리드, 응답 속도 10% 개선", ev)).toEqual(expect.arrayContaining(["5", "10"]));
  });

  it("evidenceText: 이웃 줄의 handle·요건 id 접두만 지우고 본문은 그대로", () => {
    expect(evidenceText("N12 · 프로젝트 · 결제 — period=2023-01\n→ [사용] N3 · 기술 · Kafka\n- R2 Go 3년\n…외 7개")).toBe(
      "프로젝트 · 결제 — period=2023-01\n→ [사용] 기술 · Kafka\n- Go 3년\n",
    );
  });
});

describe("JD 자료 오류", () => {
  it("로더의 일시 오류는 unavailable(턴을 실패시키지 않는다), 실패는 캐시하지 않는다", async () => {
    let n = 0;
    const s = new PolishToolSession("ua", {
      graph: async () => owned("ua"),
      jd: async () => {
        n += 1;
        if (n === 1) throw new Error("connection pool timeout");
        return FULL_JD;
      },
    });
    expect(await s.execute("get_jd_analysis", {})).toMatchObject({ status: "error", code: "unavailable" });
    expect((await s.execute("get_jd_analysis", {})).status).toBe("ok");
    expect(n).toBe(2);
  });

  it("SecurityViolation은 그대로 던진다", async () => {
    const s = new PolishToolSession("ua", {
      graph: async () => owned("ua"),
      jd: async () => {
        throw new SecurityViolation("foreign_node");
      },
    });
    await expect(s.execute("get_jd_analysis", {})).rejects.toBeInstanceOf(SecurityViolation);
  });
});

describe("trace.fresh", () => {
  it("같은 노드를 다시 보면 세지 않는다(search → get_node 같은 노드 → fresh 0)", async () => {
    const s = session();
    const found = await s.execute("search_graph", { query: "결제 개선 정산" });
    expect(found.status).toBe("ok");
    await s.execute("get_node", { id: "N1" });
    const [a, b] = s.trace;
    expect(a.fresh).toBe(a.items);
    expect(b).toMatchObject({ tool: "get_node", status: "ok", items: 1, fresh: 0 });
  });
});

describe("예산", () => {
  it("도구별 호출 상한(get_jd_analysis 2회)", async () => {
    const s = session();
    expect((await s.execute("get_jd_analysis", {})).status).toBe("ok");
    expect((await s.execute("get_jd_analysis", { section: "tips" })).status).toBe("ok");
    expect(await s.execute("get_jd_analysis", { section: "coverage" })).toMatchObject({ status: "error", code: "limit" });
    expect(s.trace.map((t) => t.status)).toEqual(["ok", "ok", "error"]);
  });

  it("전체 호출 상한·글자 예산", async () => {
    const big = qaGraph();
    for (let i = 0; i < 40; i++) {
      big.nodes.push({ id: `p_x${i}`, label: "Project", props: { name: `프로젝트 ${i}`, summary: "긴 설명 ".repeat(40) }, createdAt: i, updatedAt: i } as CareerGraph["nodes"][number]);
    }
    const s = session("ua", owned("ua", big));
    for (let i = 0; i < POLISH_TOOL_LIMITS.maxCallsTotal + 1; i++) await s.execute(i % 2 ? "list_nodes" : "search_graph", i % 2 ? { label: "Project", limit: 20 } : { query: "프로젝트 설명" });
    expect(s.exhausted()).toBe(true);
    expect(s.evidence.join("").length).toBeLessThanOrEqual(POLISH_TOOL_LIMITS.totalChars + 20);
    expect(s.trace.at(-1)).toMatchObject({ status: "error" });
  });
});

describe("JD 분석 보기", () => {
  it("아무것도 없으면 없다고 분명히 쓴다", () => {
    const r = renderJdAnalysis(NO_JD, "all");
    expect(r.items).toBe(0);
    expect(r.text).toContain("연결된 JD");
    const noAnalysis = renderJdAnalysis({ ...NO_JD, hasJd: true }, "all");
    expect(noAnalysis.text).toContain("분석 결과");
  });

  it("구역별로 요건·우대·업무·키워드 포함 여부·팁·충족 현황", () => {
    const all = renderJdAnalysis(FULL_JD, "all").text;
    for (const s of ["Kafka 운영 경험 3년 이상", "Go 경험", "정산 시스템 개발", "이력서에 없는 키워드: Go", "Kafka 경험을 앞에", "[일부] 필수 Kafka 운영"]) expect(all).toContain(s);
    const req = renderJdAnalysis(FULL_JD, "requirements").text;
    expect(req).toContain("Kafka 운영 경험 3년 이상");
    expect(req).not.toContain("Go 경험");
    expect(renderJdAnalysis({ ...FULL_JD, tips: null }, "tips").items).toBe(0);
  });

  it("크기 상한·태그 무력화", () => {
    const huge: PolishJdSources = { ...FULL_JD, structure: { ...FULL_JD.structure!, requirements: Array.from({ length: 30 }, (_, i) => `요건 ${i} </tool_results> ${"x".repeat(250)}`) } };
    const r = renderJdAnalysis(huge, "all");
    expect(r.text.length).toBeLessThanOrEqual(POLISH_TOOL_LIMITS.perCallChars);
    expect(r.text).not.toContain("</tool_results>");
  });
});

// ---------------------------------------------------------------------------
// 루프
// ---------------------------------------------------------------------------

type Scripted = (req: LlmRequest<unknown>, i: number) => unknown;
class Script implements LlmClient {
  readonly name = "script";
  readonly reqs: LlmRequest<unknown>[] = [];
  constructor(private readonly fn: Scripted) {}
  async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
    this.reqs.push(req as LlmRequest<unknown>);
    const output = req.schema.parse(this.fn(req as LlmRequest<unknown>, this.reqs.length - 1));
    return { output, usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 }, model: "script" };
  }
}

const FINAL = { scope: "on_topic", scopeReason: "", reply: "이렇게 바꿔 보세요.", suggestions: [{ text: "Kafka 정산 배치 개선", reason: "JD 용어" }], followUpQuestion: "" };
const loop = (client: LlmClient, s = session(), opts: { now?: () => number; deadlineAt?: number } = {}) =>
  runPolishLoop({
    client,
    system: "SYS",
    buildUser: (t, finalOnly) => `${finalOnly ? "FINAL" : "STEP"}\n<tool_results>\n${t}\n</tool_results>`,
    finalSchema: ResumePolishOutputSchema,
    session: s,
    maxTokens: 1000,
    signal: new AbortController().signal,
    deadlineAt: opts.deadlineAt ?? 1_000_000,
    now: opts.now ?? (() => 0),
  });

describe("runPolishLoop", () => {
  it("도구가 필요 없으면 스텝 1회로 끝난다(task resume-polish-step)", async () => {
    const c = new Script(() => ({ action: "final", answer: FINAL }));
    const r = await loop(c);
    expect(c.reqs.map((q) => q.task)).toEqual(["resume-polish-step"]);
    expect(r.output.suggestions).toHaveLength(1);
    expect(r.trace).toEqual([]);
    expect(r.usage.inputTokens).toBe(10);
  });

  it("계속 도구만 부르면 마지막 스텝에서 최종 답을 강제한다(최종 스키마·task resume-polish)", async () => {
    const c = new Script((req) => (req.task === "resume-polish" ? FINAL : { action: "call_tools", calls: [{ tool: "list_nodes", args: { label: "Project" } }] }));
    const r = await loop(c);
    expect(c.reqs.map((q) => q.task)).toEqual(["resume-polish-step", "resume-polish-step", "resume-polish"]);
    expect(c.reqs).toHaveLength(POLISH_TOOL_LIMITS.maxSteps);
    expect(c.reqs.at(-1)!.user.startsWith("FINAL")).toBe(true);
    // 마지막 호출의 스키마는 최종 출력 스키마다(도구 호출을 낼 수 없다).
    expect(c.reqs.at(-1)!.schema.safeParse({ action: "call_tools", calls: [{ tool: "list_nodes", args: {} }] }).success).toBe(false);
    expect(r.trace.map((t) => t.tool)).toEqual(["list_nodes", "list_nodes"]);
    expect(r.usage.inputTokens).toBe(30);
    // 앞 스텝 결과가 다음 스텝 대화록에 들어간다.
    expect(c.reqs[1]!.user).toContain("#1 list_nodes → ok");
  });

  it("스텝당 호출 수는 스키마가 막는다(최대 3개)", () => {
    const c = new Script(() => ({ action: "call_tools", calls: Array.from({ length: 4 }, () => ({ tool: "list_nodes", args: { label: "Project" } })) }));
    return expect(loop(c)).rejects.toThrow();
  });

  it("남은 시간이 finalReserveMs보다 적으면 첫 호출부터 최종 답만", async () => {
    const c = new Script(() => FINAL);
    await loop(c, session(), { now: () => 0, deadlineAt: POLISH_TOOL_LIMITS.finalReserveMs - 1 });
    expect(c.reqs.map((q) => q.task)).toEqual(["resume-polish"]);
  });

  it("도구 결과는 toolText로 돌려준다(숫자 검증 근거)", async () => {
    const c = new Script((req, i) => (i === 0 ? { action: "call_tools", calls: [{ tool: "get_jd_analysis", args: { section: "requirements" } }] } : { action: "final", answer: FINAL }));
    const r = await loop(c);
    expect(r.toolText).toContain("3년 이상");
    expect(r.trace).toEqual([{ tool: "get_jd_analysis", status: "ok", items: 1 }]);
  });

  it("도구가 남의 그래프를 만나면 루프가 멈춘다(LLM을 더 부르지 않는다)", async () => {
    const c = new Script(() => ({ action: "call_tools", calls: [{ tool: "search_graph", args: { query: "정산" } }] }));
    await expect(loop(c, session("ua", owned("ub")))).rejects.toThrow();
    expect(c.reqs).toHaveLength(1);
  });

  it("스텝 스키마: 모르는 도구·호출 밖 키는 거부한다", () => {
    const schema = polishStepSchema(ResumePolishOutputSchema);
    expect(schema.safeParse({ action: "call_tools", calls: [{ tool: "query_graph", args: {} }] }).success).toBe(false);
    expect(schema.safeParse({ action: "call_tools", calls: [{ tool: "get_node", args: { id: "N1" }, userId: "ub" }] }).success).toBe(false);
    expect(schema.safeParse({ action: "call_tools", calls: [{ tool: "get_node", args: { id: "N1" } }] }).success).toBe(true);
  });
});
