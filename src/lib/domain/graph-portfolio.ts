/**
 * 경험 그래프로 만드는 포트폴리오(portfolios.kind = 'graph')의 계약(클라이언트·서버 공용, 순수).
 *
 * - 시작 입력(StartGraphPortfolioSchema): 넣을 프로젝트(그래프 Project 노드 id), 강조할 공고(선택), 이름·메모(선택), 다시 만들 포트폴리오 id(선택).
 * - AI 출력(GraphPortfolioOutputSchema, task 'portfolio-draft'): 프로젝트마다 개요·역할·기술·문제·해결(STAR)·성과. 링크는 AI가 쓰지 않는다 —
 *   서버가 그래프(Project.url)와 연결한 공개 GitHub 저장소 주소로 붙인다(지어낸 주소가 들어가지 않게).
 * - graphPortfolioToMarkdown: 출력 → 저장할 Markdown 본문. 면접 질문·진단은 이 본문을 파일 텍스트처럼 읽는다.
 * - 진행 작업 화면 타입(GraphPortfolioJobView)과 단계 표시.
 */
import { z } from "zod";
import { PortfolioTitleSchema } from "./portfolios";

/** 한 번에 넣을 수 있는 프로젝트 수. */
export const MAX_GRAPH_PORTFOLIO_PROJECTS = 12;
/** 강조·톤 메모 상한(글자). */
export const MAX_GRAPH_PORTFOLIO_NOTES_CHARS = 1000;

const id = () => z.string().trim().min(1).max(64);

/** POST /api/portfolios/graph — 경험 그래프로 포트폴리오 만들기(또는 portfolioId를 다시 만들기). */
export const StartGraphPortfolioSchema = z.object({
  projectIds: z
    .array(id())
    .min(1, "포트폴리오에 넣을 프로젝트를 하나 이상 골라 주세요.")
    .max(MAX_GRAPH_PORTFOLIO_PROJECTS, `프로젝트는 한 번에 ${MAX_GRAPH_PORTFOLIO_PROJECTS}개까지 고를 수 있습니다.`)
    .transform((ids) => [...new Set(ids)]),
  postingId: id().nullable().optional(),
  title: PortfolioTitleSchema.optional(),
  notes: z
    .string()
    .trim()
    .max(MAX_GRAPH_PORTFOLIO_NOTES_CHARS, `메모는 ${MAX_GRAPH_PORTFOLIO_NOTES_CHARS.toLocaleString("ko-KR")}자 이내로 입력해 주세요.`)
    .optional(),
  provider: z.string().trim().max(40).nullable().optional(),
  /** 다시 만들기: 이 포트폴리오(kind 'graph')의 본문을 바꾼다. */
  portfolioId: id().nullable().optional(),
});
export type StartGraphPortfolioInput = z.infer<typeof StartGraphPortfolioSchema>;

/** portfolios.graph_source(jsonb). 다시 만들기 기본값과 '채워야 할 정보' 표시용. */
export const GraphPortfolioSourceSchema = z.object({
  projectIds: z.array(z.string()).max(50).catch([]),
  postingId: z.string().nullable().catch(null),
  notes: z.string().catch(""),
  missingInfo: z.array(z.string()).max(50).catch([]),
  generatedAt: z.number().catch(0),
  /** 저장한 본문에 남은 [ADD: …] 자리 수(본문을 저장할 때마다 서버가 다시 센다). 없으면(옛 행) null. */
  addMarkers: z.number().int().min(0).nullable().catch(null),
});
export type GraphPortfolioSource = z.infer<typeof GraphPortfolioSourceSchema>;
/** 생성 정보 입력(addMarkers는 저장할 때 본문에서 센다). */
export type GraphPortfolioSourceInput = Omit<GraphPortfolioSource, "addMarkers">;

/** 본문에 남은 [ADD: …] 자리 수. */
export function countPortfolioAddMarkers(text: string): number {
  return (text.match(/\[ADD:[^\]]*\]/g) ?? []).length;
}

/** '채워야 할 정보' 수: 본문에 남은 [ADD] 자리 수(옛 행은 AI가 남긴 목록 수). */
export function portfolioOpenItems(source: GraphPortfolioSource | null): number {
  if (!source) return 0;
  return source.addMarkers ?? source.missingInfo.length;
}

export function parseGraphPortfolioSource(raw: unknown): GraphPortfolioSource | null {
  if (!raw || typeof raw !== "object") return null;
  const parsed = GraphPortfolioSourceSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// AI 출력
// ---------------------------------------------------------------------------

const text = (d: string) => z.string().describe(d);

export const GraphPortfolioProjectSchema = z.object({
  projectId: text("자료의 프로젝트 id([p1] 같은 대괄호 안 값) 그대로"),
  name: text("프로젝트 이름(자료 그대로)"),
  oneLiner: text("한 줄 소개(무엇을 왜 만들었는지)"),
  overview: text("개요 2~4문장: 배경·목표·대상"),
  period: text("기간 'YYYY.MM ~ YYYY.MM'(자료에 없으면 빈 문자열)"),
  affiliation: text("소속(회사·팀·동아리 등, 자료에 없으면 빈 문자열)"),
  role: text("내 역할·책임 범위(팀 규모가 자료에 있으면 함께)"),
  techStack: z.array(z.string()).max(20).describe("사용 기술 이름(자료에 있는 것만)"),
  star: z.object({
    situation: text("상황·문제"),
    task: text("목표·과제"),
    action: z.array(z.string()).max(8).describe("내가 한 일(한 항목 한 문장, 방법과 선택 이유)"),
    result: text("결과 요약"),
  }),
  outcomes: z.array(z.string()).max(8).describe("성과 한 줄씩. 수치는 자료에 있는 값만 그대로"),
  learned: text("배운 점(자료에 없으면 빈 문자열)"),
});
export type GraphPortfolioProject = z.infer<typeof GraphPortfolioProjectSchema>;

export const GraphPortfolioOutputSchema = z.object({
  headline: text("포트폴리오 첫머리 한 줄(어떤 문제를 어떻게 푸는 사람인지)"),
  intro: text("소개 2~3문장(자료에 있는 사실로만)"),
  coreSkills: z.array(z.string()).max(15).describe("대표 기술(자료에 있는 것만)"),
  projects: z.array(GraphPortfolioProjectSchema).max(MAX_GRAPH_PORTFOLIO_PROJECTS),
  notes: z.array(z.string()).max(10).describe("작성하며 내린 판단(무엇을 강조·생략했는지)"),
  missingInfo: z.array(z.string()).max(20).describe("사용자가 채우면 좋은 정보(질문 형태). 본문에는 [ADD: ...]로 남긴다"),
});
export type GraphPortfolioOutput = z.infer<typeof GraphPortfolioOutputSchema>;

/** 서버가 그래프에서 붙이는 프로젝트 링크. */
export interface GraphPortfolioLink {
  label: string;
  url: string;
}

const clean = (s: string | undefined | null) => (s ?? "").replace(/\s+/g, " ").trim();
const listItem = (s: string) => `- ${clean(s)}`;

/**
 * AI 출력 → 저장할 Markdown. 링크는 links(프로젝트 id → 그래프의 주소)로만 붙인다. 빈 칸은 쓰지 않는다
 * (필요한데 빈 칸은 AI가 [ADD: ...]로 남긴다).
 */
export function graphPortfolioToMarkdown(
  out: GraphPortfolioOutput,
  opts: { title: string; personName?: string | null; links?: ReadonlyMap<string, readonly GraphPortfolioLink[]> },
): string {
  const lines: string[] = [`# ${clean(opts.title) || "포트폴리오"}`];
  if (opts.personName?.trim()) lines.push("", `**${clean(opts.personName)}**`);
  if (clean(out.headline)) lines.push("", `> ${clean(out.headline)}`);
  if (clean(out.intro)) lines.push("", clean(out.intro));
  const skills = out.coreSkills.map(clean).filter(Boolean);
  if (skills.length) lines.push("", `**핵심 기술** · ${skills.join(" · ")}`);

  out.projects.forEach((p, i) => {
    lines.push("", "---", "", `## ${i + 1}. ${clean(p.name) || "프로젝트"}`);
    if (clean(p.oneLiner)) lines.push("", `**${clean(p.oneLiner)}**`);
    const meta = [clean(p.period), clean(p.affiliation)].filter(Boolean);
    if (meta.length) lines.push("", meta.join(" · "));
    if (clean(p.overview)) lines.push("", "### 개요", "", clean(p.overview));
    if (clean(p.role)) lines.push("", "### 역할", "", clean(p.role));
    const tech = p.techStack.map(clean).filter(Boolean);
    if (tech.length) lines.push("", "### 기술 스택", "", tech.map((t) => `\`${t.replace(/`/g, "")}\``).join(" "));
    const star: string[] = [];
    if (clean(p.star.situation)) star.push(listItem(`**상황(S)** ${p.star.situation}`));
    if (clean(p.star.task)) star.push(listItem(`**과제(T)** ${p.star.task}`));
    const actions = p.star.action.map(clean).filter(Boolean);
    if (actions.length === 1) star.push(listItem(`**행동(A)** ${actions[0]}`));
    else if (actions.length > 1) star.push(listItem("**행동(A)**"), ...actions.map((a) => `  - ${a}`));
    if (clean(p.star.result)) star.push(listItem(`**결과(R)** ${p.star.result}`));
    if (star.length) lines.push("", "### 문제·해결", "", ...star);
    const outcomes = p.outcomes.map(clean).filter(Boolean);
    if (outcomes.length) lines.push("", "### 성과", "", ...outcomes.map(listItem));
    if (clean(p.learned)) lines.push("", "### 배운 점", "", clean(p.learned));
    const links = opts.links?.get(p.projectId) ?? [];
    if (links.length) lines.push("", "### 링크", "", ...links.map((l) => listItem(`[${l.label.replace(/[[\]]/g, "")}](${l.url})`)));
  });
  return lines.join("\n").trim() + "\n";
}

// ---------------------------------------------------------------------------
// 고르기 목록·작업 화면
// ---------------------------------------------------------------------------

/** 만들기 화면의 프로젝트 고르기 항목(그래프 Project 노드). */
export interface GraphProjectOption {
  id: string;
  name: string;
  summary: string;
  period: string;
  /** 구조화 항목 완료 수/전체(project-structure.ts). */
  done: number;
  total: number;
  skills: number;
  /** 수치 성과가 있는가. */
  hasMetric: boolean;
}

/** 기본으로 고를 프로젝트: 구조화가 잘 된 순으로 최대 n개(동률이면 그래프 순서). */
export function defaultProjectSelection(options: readonly GraphProjectOption[], n = 5): string[] {
  return [...options]
    .map((o, i) => ({ o, i, score: o.done * 2 + (o.hasMetric ? 3 : 0) + Math.min(o.skills, 3) }))
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .slice(0, n)
    .map((x) => x.o.id);
}

export const GRAPH_PORTFOLIO_JOB_STATUSES = ["running", "completed", "failed"] as const;
export type GraphPortfolioJobStatus = (typeof GRAPH_PORTFOLIO_JOB_STATUSES)[number];

/** 진행 단계: 자료 모으기 → AI 작성 → 저장. */
export const GRAPH_PORTFOLIO_JOB_STAGES = ["material", "writing", "saving"] as const;
export type GraphPortfolioJobStage = (typeof GRAPH_PORTFOLIO_JOB_STAGES)[number];

export const GRAPH_PORTFOLIO_STEP_LABELS = [
  { key: "material", label: "자료 모으는 중", done: "자료 모음" },
  { key: "writing", label: "AI가 포트폴리오 쓰는 중", done: "포트폴리오 씀" },
  { key: "saving", label: "저장 중", done: "저장함" },
  { key: "done", label: "완료", done: "완료" },
] as const;

export interface GraphPortfolioJobView {
  id: string;
  status: GraphPortfolioJobStatus;
  stage: GraphPortfolioJobStage;
  label: string;
  error: string | null;
  /** 완료하면 만든(다시 만든) 포트폴리오 id. 다시 만들기는 시작부터 대상 id. */
  portfolioId: string | null;
  /** 다시 만들기 작업인가. */
  regenerate: boolean;
  notes: string[];
  missingInfo: string[];
  canRetry: boolean;
  attempts: number;
  startedAt: number;
  createdAt: number;
  updatedAt: number;
  completedAt: number | null;
}

export function graphPortfolioStepStates(job: Pick<GraphPortfolioJobView, "status" | "stage">): ("done" | "active" | "failed" | "todo")[] {
  const at = job.status === "completed" ? GRAPH_PORTFOLIO_STEP_LABELS.length - 1 : GRAPH_PORTFOLIO_JOB_STAGES.indexOf(job.stage);
  return GRAPH_PORTFOLIO_STEP_LABELS.map((_, i) => {
    if (job.status === "completed") return "done";
    if (i < at) return "done";
    if (i === at) return job.status === "failed" ? "failed" : "active";
    return "todo";
  });
}
