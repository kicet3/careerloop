/** 그래프 날짜: 직무 기간 복사 막기, GitHub 커밋 기간, 변경안 정리, 프롬프트(오늘 날짜·날짜 규칙). */
import { describe, expect, it, vi } from "vitest";
import type { GraphChatOutput } from "@/lib/domain/chat";
import type { CareerGraph, GraphOp, LlmGraphOp } from "@/lib/domain/graph";
import type { RepoFacts } from "@/lib/github/types";
import { splitUserPrompt } from "@/lib/panel/prompts";
import { applyRepoPeriod, guardInheritedPeriods, repoPeriod } from "./graph-dates-guard";
import { buildRepoImportPrompt } from "./graph-repo-import";
import { buildGraphImportPrompt } from "./graph-import";
import { GRAPH_DATE_RULES } from "./graph-guide";

vi.mock("server-only", () => ({}));
vi.mock("next/server", () => ({ after: () => {} }));

const TODAY = "2026-11-07";
const node = (id: string, label: CareerGraph["nodes"][number]["label"], props: Record<string, unknown>) =>
  ({ id, label, props, createdAt: 0, updatedAt: 0 }) as CareerGraph["nodes"][number];
const graph: CareerGraph = {
  person: { id: "me", name: "테스터" },
  nodes: [
    node("c1", "Company", { name: "망고팩토리" }),
    node("r1", "Role", { title: "백엔드 개발자", startDate: "2025-10", current: true }),
    node("p1", "Project", { name: "MangoFactory 서비스 개발 및 출시" }),
    node("p2", "Project", { name: "SnowCut" }),
  ],
  edges: [
    { id: "AT_COMPANY:r1:c1", type: "AT_COMPANY", from: "r1", to: "c1" },
    { id: "WORKED_ON:r1:p1", type: "WORKED_ON", from: "r1", to: "p1" },
    { id: "WORKED_ON:me:p2", type: "WORKED_ON", from: "me", to: "p2" },
  ],
};
const blank: Omit<LlmGraphOp, "op"> = { ref: "", id: "", label: "", props: [], type: "", from: "", to: "" };

describe("guardInheritedPeriods — 직무 기간을 하위 프로젝트에 그대로 옮기지 않는다", () => {
  const copy: GraphOp[] = [{ op: "updateNode", id: "p1", label: "Project", props: { startDate: "2025-10", current: true, action: "결제 연동" } }];

  it("사용자가 그 기간을 말하지 않았으면 기간만 뺀다", () => {
    const r = guardInheritedPeriods(copy, graph, "결제 연동을 맡았어요", TODAY);
    expect(r.ops).toEqual([{ op: "updateNode", id: "p1", label: "Project", props: { action: "결제 연동" } }]);
    expect(r.dropped[0]).toMatch(/소속 직무 기간을 그대로 옮긴/);
  });

  it("사용자가 기간을 말했거나 '입사 때부터'라고 했으면 둔다", () => {
    expect(guardInheritedPeriods(copy, graph, "2025년 10월부터 지금까지 했어요", TODAY).ops).toEqual(copy);
    expect(guardInheritedPeriods(copy, graph, "입사 때부터 계속 이 프로젝트만 했어요", TODAY).ops).toEqual(copy);
  });

  it("이미 시작이 같은 프로젝트에 진행 중·종료만 고치는 답은 건드리지 않는다", () => {
    const g: CareerGraph = { ...graph, nodes: graph.nodes.map((n) => (n.id === "p1" ? node("p1", "Project", { ...n.props, startDate: "2025-10" }) : n)) };
    const only: GraphOp[] = [{ op: "updateNode", id: "p1", label: "Project", props: { current: true } }];
    expect(guardInheritedPeriods(only, g, "아직 진행 중이에요", TODAY)).toEqual({ ops: only, dropped: [] });
  });

  it("같은 변경안에서 만든 직무·프로젝트도 본다, 기간이 다르면 둔다", () => {
    const ops: GraphOp[] = [
      { op: "addNode", ref: "new:r", label: "Role", props: { title: "PM", startDate: "2023-01", endDate: "2024-06" } },
      { op: "addNode", ref: "new:p", label: "Project", props: { name: "OTA 예약 연동 RPA", startDate: "2023-01", endDate: "2024-06" } },
      { op: "addEdge", type: "WORKED_ON", from: "new:r", to: "new:p" },
      { op: "addNode", ref: "new:q", label: "Project", props: { name: "HD 조선 대시보드", startDate: "2023-03", endDate: "2023-08" } },
      { op: "addEdge", type: "WORKED_ON", from: "new:r", to: "new:q" },
    ];
    const r = guardInheritedPeriods(ops, graph, "PM으로 일했어요", TODAY);
    expect(r.ops[1]).toEqual({ op: "addNode", ref: "new:p", label: "Project", props: { name: "OTA 예약 연동 RPA" } });
    expect(r.ops[3]).toEqual(ops[3]);
    expect(r.ops[0]).toEqual(ops[0]);
  });
});

const facts = (my: Partial<RepoFacts["my"]>, extra: Partial<RepoFacts> = {}) =>
  ({
    owner: "octo",
    createdAt: "2024-01-02T00:00:00Z",
    pushedAt: "2026-11-01T00:00:00Z",
    my: { login: "octo", commitCount: 3, firstCommitAt: null, lastCommitAt: null, commits: [], prs: [], prTotal: null, ...my },
    ...extra,
  }) as RepoFacts;

describe("repoPeriod — 회원님 첫·최근 커밋 달(KST)", () => {
  it("커밋 기록이 있으면 그것, 같은 달이면 시작=종료", () => {
    expect(repoPeriod(facts({ firstCommitAt: "2026-08-01T00:00:00Z", lastCommitAt: "2026-08-20T00:00:00Z" }))).toEqual({
      start: "2026-08",
      end: "2026-08",
      source: "commits",
    });
    expect(repoPeriod(facts({ firstCommitAt: "2025-12-31T16:00:00Z", lastCommitAt: "2026-03-01T00:00:00Z" }))?.start).toBe("2026-01");
  });
  it("커밋 기록이 없으면 내 저장소일 때만 생성·최근 반영, 남의 저장소면 null", () => {
    expect(repoPeriod(facts({}))).toEqual({ start: "2024-01", end: "2026-11", source: "repo" });
    expect(repoPeriod(facts({ login: "me" }))).toBeNull();
  });
});

describe("applyRepoPeriod — LLM 기간 대신 커밋 기간, 사용자 값은 덮어쓰지 않는다", () => {
  const period = { start: "2026-08", end: "2026-10", source: "commits" as const };
  it("비어 있으면 채우고 확인 요청 문구를 준다(진행 중은 추측하지 않는다)", () => {
    const r = applyRepoPeriod([{ op: "updateNode", id: "p2", label: "Project", props: { summary: "s", startDate: "2020-01", current: true } }], graph, "p2", period);
    expect(r.ops).toEqual([{ op: "updateNode", id: "p2", label: "Project", props: { summary: "s", startDate: "2026-08", endDate: "2026-10" } }]);
    expect(r.note).toMatch(/커밋 기록 기준\(2026-08 ~ 2026-10\)/);
  });
  it("사용자가 넣은 기간·진행 중이 있으면 건드리지 않는다", () => {
    const g: CareerGraph = { ...graph, nodes: graph.nodes.map((n) => (n.id === "p2" ? node("p2", "Project", { name: "SnowCut", startDate: "2026-07", current: true }) : n)) };
    const r = applyRepoPeriod([{ op: "updateNode", id: "p2", label: "Project", props: { endDate: "2026-10" } }], g, "p2", period);
    expect(r.ops).toEqual([]);
    expect(r.note).toBeNull();
  });
});

describe("proposalFromOutput — 날짜", () => {
  it("저장소 가져오기: LLM 기간 대신 커밋 기간을 넣고 답변에 확인을 부탁한다", async () => {
    const { proposalFromOutput } = await import("./graph-chat");
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "요약",
      ops: [{ ...blank, op: "updateNode", id: "p2", label: "Project", props: [{ key: "startDate", value: "2026-10" }, { key: "endDate", value: "2026-10" }] }],
      followUpQuestions: [],
    };
    const r = proposalFromOutput(output, graph, {
      maxOps: 40,
      sourceText: "저장소: octo/snowcut",
      focusNodeId: "p2",
      sourceKind: "repo-import",
      today: TODAY,
      repoPeriod: { start: "2026-08", end: "2026-10", source: "commits" },
    });
    expect(r.data.ops).toEqual([{ op: "updateNode", id: "p2", label: "Project", props: { startDate: "2026-08", endDate: "2026-10" } }]);
    expect(r.content).toContain("커밋 기록 기준");
  });

  it("그래프 채팅: 직무 기간 복사는 빼고, 진행 중을 이번 달 종료로 적은 값은 current로 남긴다", async () => {
    const { proposalFromOutput } = await import("./graph-chat");
    const output: GraphChatOutput = {
      reply: "정리했어요",
      summary: "요약",
      ops: [
        { ...blank, op: "updateNode", id: "p1", label: "Project", props: [{ key: "startDate", value: "2025-10" }, { key: "endDate", value: "현재" }, { key: "myRole", value: "백엔드" }] },
        { ...blank, op: "updateNode", id: "p2", label: "Project", props: [{ key: "startDate", value: "2026.08" }, { key: "endDate", value: "2026-11" }, { key: "current", value: "true" }] },
        { ...blank, op: "updateNode", id: "r1", label: "Role", props: [{ key: "endDate", value: "2027-03" }] },
      ],
      followUpQuestions: [],
    };
    const r = proposalFromOutput(output, graph, { today: TODAY, evidenceText: "MangoFactory에서는 백엔드를 맡았고 SnowCut은 2026년 8월부터 하고 있어요" });
    expect(r.data.ops).toEqual([
      { op: "updateNode", id: "p1", label: "Project", props: { myRole: "백엔드" } },
      { op: "updateNode", id: "p2", label: "Project", props: { startDate: "2026-08", current: true } },
    ]);
    expect(r.data.droppedOps?.join("\n")).toMatch(/소속 직무 기간/);
    expect(r.data.droppedOps?.join("\n")).toMatch(/오늘 이후/);
    // 미래 날짜로 뺀 값은 후속 질문 후보가 된다
    expect(r.followups.some((f) => /오늘 이후/.test(f.text))).toBe(true);
  });
});

describe("프롬프트: 오늘 날짜(KST)와 날짜 규칙", () => {
  it("그래프 채팅·문서 가져오기·저장소 가져오기 모두 오늘 날짜와 D 규칙을 넣는다", async () => {
    const { buildGraphChatPrompt } = await import("./graph-chat");
    const today = new Date(Date.UTC(2026, 10, 6, 20, 0)); // KST 2026-11-07 05:00
    const chat = buildGraphChatPrompt({ graph, messages: [], latestMessage: "작년 3월부터 했어요", today });
    const doc = buildGraphImportPrompt({ graph, doc: { docKind: "resume", fileName: null, text: "이력서" }, today });
    const repo = buildRepoImportPrompt({ graph, focusProjectId: "p2", brief: "저장소", today });
    for (const p of [chat, doc, repo]) {
      expect(splitUserPrompt(p.user)[1]).toContain("- 오늘 날짜: 2026-11-07 (한국 시간 · 이번 달 2026-11 · 올해 2026 · 작년 2025)");
      expect(p.system).toContain(GRAPH_DATE_RULES);
    }
    expect(GRAPH_DATE_RULES).toMatch(/작년 3월/);
    expect(GRAPH_DATE_RULES).toMatch(/current="true"/);
    expect(GRAPH_DATE_RULES).toMatch(/직무\(Role\)·회사·다른 프로젝트의 기간으로 채우지 않는다/);
    expect(repo.system).toMatch(/기간\(startDate·endDate·current\)은 넣지 않는다/);
  });

  it("취득 연월이 없는 자격증은 체크리스트 블록에 보강 줄로 넣는다", async () => {
    const { buildGraphChatPrompt } = await import("./graph-chat");
    const g: CareerGraph = { ...graph, nodes: [...graph.nodes, node("ct1", "Certification", { name: "정보처리기사" })] };
    const { user } = buildGraphChatPrompt({ graph: g, messages: [], latestMessage: "x", today: new Date() });
    expect(user).toContain("취득 연월(Certification.date, YYYY-MM)이 없는 자격증: [ct1] 정보처리기사");
  });
});
