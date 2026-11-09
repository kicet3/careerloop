/**
 * Python 워커와 공유하는 계약 파일 만들기(docs/PYTHON-WORKER.md §4). 순수 — 파일 경로(저장소 루트 기준) → 내용을 돌려준다.
 * - worker/app/schemas/generated/*.json: 워커가 런타임에 읽는 출력 JSON Schema(z.toJSONSchema)와 그래프 도메인 표.
 * - worker/tests/fixtures/*.json: pytest가 Python 구현이 TS와 같은지 확인하는 고정 입력·기대 출력.
 * 쓰기는 fixtures.test.ts(UPDATE_WORKER_FIXTURES=1)와 scripts/export-worker-schemas.ts가 한다. 테스트는 파일이 최신인지 확인한다.
 */
import { z } from "zod";
import {
  addUsage,
  addUsageByModel,
  DEFAULT_MODEL,
  schemaInstruction,
  toStrictJsonSchema,
  userContent,
} from "@/lib/llm/anthropic";
import { estimateCostByModel, estimateCostMicroUsd, MODEL_PRICES, priceFor } from "@/lib/llm/pricing";
import type { LlmUsage } from "@/lib/llm/types";
import { STAGE_TASK_DELIMITER } from "@/lib/panel/prompts";
import { ResumeDraftOutputSchema } from "@/lib/domain/resumes";
import { GraphPortfolioOutputSchema } from "@/lib/domain/graph-portfolio";
import { InterviewFeedbackOutputSchema, InterviewQuestionsOutputSchema } from "@/lib/domain/interview";
import {
  allowedPropKeys,
  type CareerGraph,
  NODE_LABEL_META,
  NODE_LABELS,
  NODE_TITLE_KEY,
  PERSON_ID,
  REL_RULES,
  REL_TYPES,
} from "@/lib/domain/graph";
import { normalizeStoredDates, parseGraphDate } from "@/lib/domain/graph-dates";
import { graphToText } from "@/lib/graph/text";
import { toGraphNode } from "@/lib/graph/node";
import { isJobEnabled, parseWorkerJobs } from "./config";
import { canonicalString, signRequest, verifySignature } from "./sign";

/** 워커 출력 스키마(파일 이름 → zod 스키마). 워커는 worker/app/schemas/generated/<이름>.json으로 읽는다. */
export const WORKER_OUTPUT_SCHEMAS: Record<string, z.ZodType> = {
  resume_draft_output: ResumeDraftOutputSchema,
  graph_portfolio_output: GraphPortfolioOutputSchema,
  interview_questions_output: InterviewQuestionsOutputSchema,
  interview_feedback_output: InterviewFeedbackOutputSchema,
};

const GENERATED_DIR = "worker/app/schemas/generated";
const FIXTURE_DIR = "worker/tests/fixtures";

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** toStrictJsonSchema가 변환하기 전의 원본(z.toJSONSchema, $schema 제외). 워커는 이것으로 검증하고 같은 규칙으로 strict 변환한다. */
export function rawJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const raw = z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" }) as Record<string, unknown>;
  delete raw.$schema;
  return raw;
}

const u = (inputTokens: number, outputTokens: number, cacheReadTokens = 0, cacheWriteTokens = 0): LlmUsage => ({
  inputTokens,
  outputTokens,
  cacheReadTokens,
  cacheWriteTokens,
});

function llmContract() {
  const strict: Record<string, unknown> = {};
  const instruction: Record<string, string> = {};
  for (const [name, schema] of Object.entries(WORKER_OUTPUT_SCHEMAS)) {
    strict[name] = toStrictJsonSchema(schema);
    instruction[name] = schemaInstruction(schema);
  }
  // strict 변환의 경계 사례(설명으로 내리는 제약, minItems 0·1만 유지, format 화이트리스트, 안전 정수 범위 생략).
  const edge = z.object({
    a: z.string().min(2).max(10).describe("설명"),
    b: z.array(z.number().int()).min(1).max(5),
    c: z.array(z.string()).min(3),
    d: z.string().email(),
    e: z.string().regex(/^x+$/),
    f: z.union([z.literal("A"), z.literal("B")]),
    g: z.number().min(0).max(1),
    h: z.object({ x: z.string().optional() }).optional(),
    i: z.enum(["P", "Q"]).nullable(),
  });
  const users = [
    "자료만 있는 user",
    `공유 자료${STAGE_TASK_DELIMITER}단계 지시`,
    `앞${STAGE_TASK_DELIMITER}뒤${STAGE_TASK_DELIMITER}더 뒤`,
  ];
  const usageMessages = [
    { model: "claude-opus-5-5", usage: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 3, cache_creation_input_tokens: 4 } },
    {
      model: "claude-sonnet-5-5",
      usage: {
        input_tokens: 5,
        output_tokens: 6,
        iterations: [
          { type: "message", input_tokens: 100, output_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 50 },
          { type: "fallback_message", model: "claude-sonnet-5-5", input_tokens: 5, output_tokens: 6 },
        ],
      },
    },
    { model: "claude-opus-5-5", usage: { input_tokens: 1, output_tokens: 2, iterations: [] } },
  ];
  let acc = u(0, 0);
  let byModel: ReturnType<typeof addUsageByModel> = [];
  const usageSteps = usageMessages.map((msg) => {
    acc = addUsage(acc, msg as never);
    byModel = addUsageByModel(byModel, msg as never, "claude-opus-5-5");
    return { message: msg, usage: acc, usageByModel: byModel };
  });
  return {
    defaultModel: DEFAULT_MODEL,
    stageTaskDelimiter: STAGE_TASK_DELIMITER,
    strict,
    schemaInstruction: instruction,
    strictEdge: { raw: rawJsonSchema(edge), strict: toStrictJsonSchema(edge) },
    userContent: users.flatMap((user) => [true, false].map((cache) => ({ user, cache, blocks: userContent(user, cache) }))),
    usage: { requestedModel: "claude-opus-5-5", steps: usageSteps },
  };
}

function pricingFixture() {
  const models = [
    "claude-opus-5-5",
    "claude-opus-5-5-20261001",
    "claude-opus-5-5[1m]",
    "claude-opus-5-5@vertex",
    "CLAUDE-SONNET-5-5",
    " claude-haiku-5-5 ",
    "claude-opus-5",
    "claude-opus-5-1",
    "claude-fable-5-1",
    "claude-fable-5",
    "claude-opus-55",
    "gpt-5",
    "fake",
  ];
  const usage = u(123_457, 9_876, 54_321, 1_234);
  return {
    prices: MODEL_PRICES,
    cases: models.map((model) => ({ model, price: priceFor(model), usage, cost: estimateCostMicroUsd(model, usage) })),
    byModel: [
      { parts: [{ model: "claude-opus-5-5", usage }, { model: "claude-sonnet-5-5", usage: u(10, 10, 10, 10) }] },
      { parts: [{ model: "claude-opus-5-5", usage }, { model: "unknown-model", usage: u(0, 0) }] },
      { parts: [{ model: "claude-opus-5-5", usage }, { model: "unknown-model", usage: u(1, 0) }] },
      { parts: [] },
    ].map((c) => ({ ...c, cost: estimateCostByModel(c.parts) })),
  };
}

function hmacFixture() {
  const secret = "0123456789abcdef0123456789abcdef-test-secret";
  const now = 1_790_000_000;
  const bodies = ['{"id":"job_1","runId":"run_1"}', "", '{"id":"이력서","runId":"r"}'];
  const vectors = [
    { method: "POST", path: "/v1/jobs/resume-draft", body: bodies[0]!, ts: String(now) },
    { method: "get", path: "/readyz", body: bodies[1]!, ts: String(now) },
    { method: "POST", path: "/v1/jobs/interview-questions", body: bodies[2]!, ts: String(now - 30) },
  ].map((v) => ({ ...v, canonical: canonicalString(v.ts, v.method, v.path, v.body), signature: signRequest(secret, v.ts, v.method, v.path, v.body) }));
  const good = vectors[0]!;
  const verify = [
    { name: "ok", timestamp: good.ts, signature: good.signature, nowSec: now },
    { name: "ok-skew-60", timestamp: good.ts, signature: good.signature, nowSec: now + 60 },
    { name: "expired-61", timestamp: good.ts, signature: good.signature, nowSec: now + 61 },
    { name: "future-61", timestamp: good.ts, signature: good.signature, nowSec: now - 61 },
    { name: "missing-ts", timestamp: null, signature: good.signature, nowSec: now },
    { name: "missing-sig", timestamp: good.ts, signature: null, nowSec: now },
    { name: "no-prefix", timestamp: good.ts, signature: good.signature.slice(3), nowSec: now },
    { name: "upper-hex", timestamp: good.ts, signature: `v1=${good.signature.slice(3).toUpperCase()}`, nowSec: now },
    { name: "bad-ts", timestamp: `${good.ts}.5`, signature: good.signature, nowSec: now },
    { name: "tampered", timestamp: good.ts, signature: `v1=${"0".repeat(64)}`, nowSec: now },
  ].map((c) => ({
    ...c,
    method: good.method,
    path: good.path,
    body: good.body,
    expected: verifySignature(secret, { timestamp: c.timestamp, signature: c.signature }, good.method, good.path, good.body, c.nowSec),
  }));
  // 다른 경로·본문·메서드로 같은 서명을 쓰면 실패해야 한다.
  const crossed = [
    { method: "POST", path: "/v1/jobs/portfolio-graph", body: good.body },
    { method: "POST", path: good.path, body: '{"id":"job_2","runId":"run_1"}' },
    { method: "PUT", path: good.path, body: good.body },
  ].map((c) => ({
    ...c,
    timestamp: good.ts,
    signature: good.signature,
    nowSec: now,
    expected: verifySignature(secret, { timestamp: good.ts, signature: good.signature }, c.method, c.path, c.body, now),
  }));
  return { secret, vectors, verify: [...verify, ...crossed] };
}

function graphDomain() {
  return {
    personId: PERSON_ID,
    nodeLabels: NODE_LABELS,
    labelMeta: NODE_LABEL_META,
    titleKey: NODE_TITLE_KEY,
    relTypes: REL_TYPES,
    relNames: Object.fromEntries(REL_TYPES.map((t) => [t, REL_RULES[t].name])),
    propKeys: Object.fromEntries(NODE_LABELS.map((l) => [l, allowedPropKeys(l)])),
  };
}

/** graphToText 고정 입력: 라벨·속성 종류(배열·숫자·불리언·이모지)·관계·누락 노드를 고루 담는다. */
function sampleGraph(): CareerGraph {
  const long = (s: string, n: number) => s.repeat(n);
  return {
    person: { id: PERSON_ID, name: "홍길동" },
    nodes: [
      { id: "c1", label: "Company", props: { name: "카카오", industry: "IT", description: long("플랫폼 서비스 회사 ", 20) }, createdAt: 1, updatedAt: 1 },
      { id: "c2", label: "Company", props: { name: "", location: "판교" } as never, createdAt: 2, updatedAt: 2 },
      { id: "r1", label: "Role", props: { title: "백엔드 개발자", startDate: "2021-03", current: true, summary: "결제 🚀 시스템 담당 😀".repeat(15) }, createdAt: 3, updatedAt: 3 },
      {
        id: "p1",
        label: "Project",
        props: { name: "결제 개편", teamSize: 5, startDate: "2022-01", endDate: "2022-12", categories: ["problem-solving", "collaboration"], result: "응답 시간\n  40% 단축" },
        createdAt: 4,
        updatedAt: 4,
      },
      { id: "s1", label: "Skill", props: { name: "Kotlin", category: "language" }, createdAt: 5, updatedAt: 5 },
      { id: "s2", label: "Skill", props: { name: "Spring" }, createdAt: 6, updatedAt: 6 },
      { id: "a1", label: "Achievement", props: { summary: "장애 0건", value: "99.99%" }, createdAt: 7, updatedAt: 7 },
      { id: "e1", label: "Education", props: { school: "서울대", major: "컴퓨터공학", endDate: "2020-02" }, createdAt: 8, updatedAt: 8 },
      { id: "x1", label: "Experience", props: { title: "오픈소스 기여", description: long("메인테이너 활동 ", 30) }, createdAt: 9, updatedAt: 9 },
      { id: "z1", label: "Certification", props: { name: "정보처리기사", date: "2019-11" }, createdAt: 10, updatedAt: 10 },
    ] as CareerGraph["nodes"],
    edges: [
      { id: "WORKED_AT:me:c1", type: "WORKED_AT", from: PERSON_ID, to: "c1" },
      { id: "HAD_ROLE:me:r1", type: "HAD_ROLE", from: PERSON_ID, to: "r1" },
      { id: "AT_COMPANY:r1:c1", type: "AT_COMPANY", from: "r1", to: "c1" },
      { id: "WORKED_ON:r1:p1", type: "WORKED_ON", from: "r1", to: "p1" },
      { id: "USED_SKILL:p1:s1", type: "USED_SKILL", from: "p1", to: "s1" },
      { id: "USED_SKILL:p1:s2", type: "USED_SKILL", from: "p1", to: "s2" },
      { id: "ACHIEVED:p1:a1", type: "ACHIEVED", from: "p1", to: "a1" },
      { id: "STUDIED_AT:me:e1", type: "STUDIED_AT", from: PERSON_ID, to: "e1" },
      { id: "EARNED:me:z1", type: "EARNED", from: PERSON_ID, to: "z1" },
      { id: "USED_SKILL:x1:gone", type: "USED_SKILL", from: "x1", to: "gone" },
    ],
  };
}

function graphFixture() {
  const graph = sampleGraph();
  const empty: CareerGraph = { person: { id: PERSON_ID, name: null }, nodes: [], edges: [] };
  const textCases = [
    { maxChars: undefined, propCaps: undefined },
    { maxChars: 2000, propCaps: undefined },
    { maxChars: 900, propCaps: undefined },
    { maxChars: 400, propCaps: undefined },
    { maxChars: 120, propCaps: undefined },
    { maxChars: 3000, propCaps: [400, 10, 0] },
  ].map((opts) => ({
    opts,
    text: graphToText(graph, { ...(opts.maxChars !== undefined ? { maxChars: opts.maxChars } : {}), ...(opts.propCaps ? { propCaps: opts.propCaps } : {}) }),
  }));
  const dateInputs = [
    "2024-03", "2024", "2024-03-15", "2024-02-30", "2024-03-15T09:00:00Z", "2024.03.15", "2024/3/15", "2024. 3. 15", "2024년 3월 15일",
    "24.03.15", "2024.3", "2024/03", "2024년 3월", "24.03", "'24.03", "24년 3월", "202403", "20240315", "20240230", "03/2024", "3.2024",
    "Mar 2024", "March 2024", "Mar. 2024", "2024 Mar", "2024년 상반기", "2024 Q3", "현재", "재직 중", "present", "~ 현재", "모름", "-", "",
    "  ", "1949", "2101", "2024-13", "2024.03 ~ 2024.06", "작년 3월", "２０２４－０３", "x".repeat(41), "99.12", "70.01", "69.01",
  ];
  const parseCases = [...dateInputs.map((raw) => ({ raw, result: parseGraphDate(raw) })), { raw: 2024, result: parseGraphDate(2024) }, { raw: null, result: parseGraphDate(null) }, { raw: true, result: parseGraphDate(true) }];
  const storedCases = [
    { label: "Role", props: { title: "a", startDate: "2021-03-02", endDate: "현재" } },
    { label: "Role", props: { title: "a", startDate: "2021.03", endDate: "2023-01", current: true } },
    { label: "Certification", props: { name: "a", date: "2019년 11월" } },
    { label: "Certification", props: { name: "a", endDate: "현재" } },
    { label: "Project", props: { name: "a", startDate: "알 수 없음", endDate: "2022-12" } },
    { label: "Education", props: { school: "a", endDate: "재학 중" } },
    { label: "Skill", props: { name: "a" } },
  ].map((c) => ({ ...c, result: normalizeStoredDates(c.label, c.props) }));
  const nodeCases = [
    { id: "n1", label: "Role" as const, raw: { id: "n1", userId: "u1", title: "개발", startDate: "2021-03-02", endDate: "현재", createdAt: 5, updatedAt: 9, secret: "x", current: null } },
    { id: "n2", label: "Project" as const, raw: { name: "p", teamSize: 3, categories: ["values"], createdAt: "bad" } },
  ].map((c) => ({ ...c, node: toGraphNode(c.id, c.label, c.raw) }));
  return {
    graph,
    textCases,
    emptyText: graphToText(empty),
    parseGraphDate: parseCases,
    normalizeStoredDates: storedCases,
    toGraphNode: nodeCases,
  };
}

function workerJobsFixture() {
  const kinds = ["resume-draft", "portfolio-graph", "interview-questions", "interview-feedback", "diagnosis"];
  const raws = ["", "*", "resume-draft", " Resume-Draft , portfolio-graph ", "interview", "interview-q", "resume", "diagnosis,*", ",,"];
  return raws.map((raw) => {
    const jobs = parseWorkerJobs(raw);
    return { raw, jobs, enabled: Object.fromEntries(kinds.map((k) => [k, isJobEnabled(jobs, k)])) };
  });
}

/** 저장소 루트 기준 경로 → 파일 내용. */
export function buildWorkerFixtures(): Record<string, string> {
  const files: Record<string, string> = {};
  for (const [name, schema] of Object.entries(WORKER_OUTPUT_SCHEMAS)) files[`${GENERATED_DIR}/${name}.json`] = json(rawJsonSchema(schema));
  files[`${GENERATED_DIR}/graph_domain.json`] = json(graphDomain());
  files[`${FIXTURE_DIR}/llm_contract.json`] = json(llmContract());
  files[`${FIXTURE_DIR}/pricing.json`] = json(pricingFixture());
  files[`${FIXTURE_DIR}/hmac_vectors.json`] = json(hmacFixture());
  files[`${FIXTURE_DIR}/graph.json`] = json(graphFixture());
  files[`${FIXTURE_DIR}/worker_jobs.json`] = json(workerJobsFixture());
  return files;
}
