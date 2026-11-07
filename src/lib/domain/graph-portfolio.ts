/**
 * 경험 그래프로 만드는 포트폴리오(portfolios.kind = 'graph')의 계약(클라이언트·서버 공용, 순수).
 *
 * - 시작 입력(StartGraphPortfolioSchema): 넣을 프로젝트(그래프 Project 노드 id), 양식(templateId, 기본 'project-pdf'), 강조할 공고(선택),
 *   이름·메모(선택), 다시 만들 포트폴리오 id(선택).
 * - AI 출력(GraphPortfolioOutputSchema, task 'portfolio-draft'): 양식(portfolio-templates.ts)의 구역 key로 채운 sections 배열
 *   (최상위 + 프로젝트마다). 한 스키마로 모든 양식을 받고, 구역 제목·순서는 서버가 양식으로 붙인다. 링크는 AI가 쓰지 않는다 —
 *   서버가 그래프(Project.url)와 연결한 공개 GitHub 저장소 주소로 붙인다(지어낸 주소가 들어가지 않게).
 * - graphPortfolioToMarkdown: 출력 → 저장할 Markdown 본문(양식의 구역 순서). 면접 질문·진단은 이 본문을 파일 텍스트처럼 읽는다.
 * - 진행 작업 화면 타입(GraphPortfolioJobView)과 단계 표시.
 */
import { z } from "zod";
import {
  DEFAULT_PORTFOLIO_TEMPLATE_ID,
  getPortfolioTemplate,
  type PortfolioTemplateId,
  PortfolioTemplateIdSchema,
  type PortfolioTemplateSection,
} from "./portfolio-templates";
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
  /** 포트폴리오 양식(portfolio-templates.ts). 없으면 기본 양식. 모르는 id는 400. */
  templateId: PortfolioTemplateIdSchema.default(DEFAULT_PORTFOLIO_TEMPLATE_ID),
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
  /** 만든 양식. 양식이 생기기 전 행·모르는 값은 null(화면은 기본 양식으로 다시 만들기를 제안한다). */
  templateId: PortfolioTemplateIdSchema.nullable().catch(null),
});
export type GraphPortfolioSource = z.infer<typeof GraphPortfolioSourceSchema>;
/** 생성 정보 입력(addMarkers는 저장할 때 본문에서 센다). */
export type GraphPortfolioSourceInput = Omit<GraphPortfolioSource, "addMarkers" | "templateId"> & { templateId?: PortfolioTemplateId | null };

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

/** 구역 수 상한(최상위·프로젝트마다). 양식의 구역 수보다 넉넉하게. */
export const MAX_PORTFOLIO_TOP_SECTIONS = 10;
export const MAX_PORTFOLIO_PROJECT_SECTIONS = 14;
export const MAX_PORTFOLIO_SECTION_BULLETS = 10;

/**
 * 양식의 구역 하나(kind 'text'). 한 스키마로 모든 양식을 받는다 — 어떤 key를 어떤 순서로 쓸지는 프롬프트의 양식 지침이 정하고,
 * 제목·순서는 서버가 양식(portfolio-templates.ts)으로 붙인다(모르는 key는 버린다).
 */
export const GraphPortfolioSectionSchema = z.object({
  key: text("양식의 구역 key(지침에 적힌 영문 key 그대로)"),
  body: text("문단(없으면 빈 문자열)"),
  bullets: z.array(z.string()).max(MAX_PORTFOLIO_SECTION_BULLETS).describe("목록 항목 한 줄씩(없으면 빈 배열)"),
});
export type GraphPortfolioSection = z.infer<typeof GraphPortfolioSectionSchema>;

export const GraphPortfolioProjectSchema = z.object({
  projectId: text("자료의 프로젝트 id([p1] 같은 대괄호 안 값) 그대로"),
  name: text("프로젝트 이름(자료 그대로)"),
  oneLiner: text("한 줄 소개(무엇을 왜 만들었는지)"),
  period: text("기간 'YYYY.MM ~ YYYY.MM'(자료에 없으면 빈 문자열)"),
  affiliation: text("소속(회사·팀·동아리 등, 자료에 없으면 빈 문자열)"),
  techStack: z.array(z.string()).max(20).describe("사용 기술 이름(자료에 있는 것만)"),
  sections: z.array(GraphPortfolioSectionSchema).max(MAX_PORTFOLIO_PROJECT_SECTIONS).describe("양식의 프로젝트 구역(지침 순서대로)"),
});
export type GraphPortfolioProject = z.infer<typeof GraphPortfolioProjectSchema>;

export const GraphPortfolioOutputSchema = z.object({
  headline: text("포트폴리오 첫머리 한 줄(어떤 문제를 어떻게 푸는 사람인지)"),
  coreSkills: z.array(z.string()).max(15).describe("대표 기술(자료에 있는 것만)"),
  sections: z.array(GraphPortfolioSectionSchema).max(MAX_PORTFOLIO_TOP_SECTIONS).describe("양식의 최상위 구역(프로젝트 앞·뒤, 지침 순서대로)"),
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
const linkItem = (l: GraphPortfolioLink) => listItem(`[${l.label.replace(/[[\]]/g, "")}](${l.url})`);

const normKey = (k: string) => k.replace(/[^a-z0-9_-]/gi, "").toLowerCase();

/** sections → key별 첫 구역(모르는 key도 담는다 — 그릴 때 양식 key만 꺼낸다). */
export function sectionsByKey(sections: readonly GraphPortfolioSection[]): Map<string, GraphPortfolioSection> {
  const map = new Map<string, GraphPortfolioSection>();
  for (const s of sections) {
    const k = normKey(s.key);
    if (k && !map.has(k)) map.set(k, s);
  }
  return map;
}

interface SectionContext {
  content: GraphPortfolioSection | undefined;
  skills: readonly string[];
  links: readonly GraphPortfolioLink[];
  /** 연락처 구역(kind 'contact')에 붙이는 사용자 본인의 주소(연결한 GitHub 프로필). 프로젝트 링크는 넣지 않는다. */
  contact: readonly GraphPortfolioLink[];
  toc: readonly string[];
  /** 기술을 `코드` 칩으로(프로젝트) 또는 ' · '로(최상위). */
  chips: boolean;
}

/** 구역 하나의 Markdown 줄(제목 포함). 비어서 쓰지 않으면 빈 배열. 필수 구역이 비면 [ADD: … 보완 필요]. */
function sectionLines(sec: PortfolioTemplateSection, level: 2 | 3, ctx: SectionContext): string[] {
  const head = `${"#".repeat(level)} ${sec.heading}`;
  const missing = sec.optional ? [] : ["", head, "", `[ADD: ${sec.heading} 보완 필요]`];
  switch (sec.kind) {
    case "skills": {
      const names = ctx.skills.map(clean).filter(Boolean);
      if (!names.length) return [];
      return ["", head, "", ctx.chips ? names.map((n) => `\`${n.replace(/`/g, "")}\``).join(" ") : names.join(" · ")];
    }
    case "links":
      return ctx.links.length ? ["", head, "", ...ctx.links.map(linkItem)] : missing;
    case "contact": {
      const hasGithub = ctx.contact.some((l) => /^https:\/\/github\.com\//.test(l.url));
      return ["", head, "", ...ctx.contact.map(linkItem), hasGithub ? "- [ADD: 이메일·블로그 주소]" : "- [ADD: 이메일·GitHub·블로그 주소]"];
    }
    case "toc": {
      const names = ctx.toc.map(clean).filter(Boolean);
      return names.length ? ["", head, "", ...names.map((n, i) => `${i + 1}. ${n}`)] : [];
    }
    case "text": {
      const body = clean(ctx.content?.body);
      const bullets = (ctx.content?.bullets ?? []).map(clean).filter(Boolean);
      if (!body && !bullets.length) return missing;
      return ["", head, ...(body ? ["", body] : []), ...(bullets.length ? ["", ...bullets.map(listItem)] : [])];
    }
  }
}

/**
 * AI 출력 → 저장할 Markdown. 고른 양식(templateId, 없으면 기본 양식)의 구역 순서·제목대로 그린다:
 * 제목 → 이름 → 한 줄 소개 → 앞 구역 → 프로젝트(양식의 프로젝트 구역) → 뒤 구역.
 * 링크는 links(프로젝트 id → 그래프의 주소)로만 붙인다. 연락처 구역은 contactLinks(본인 GitHub 프로필)만 붙이고 나머지는 [ADD]. 선택 구역이 비면 쓰지 않고, 필수 구역이 비면 [ADD: … 보완 필요]를 남긴다.
 */
export function graphPortfolioToMarkdown(
  out: GraphPortfolioOutput,
  opts: {
    title: string;
    personName?: string | null;
    links?: ReadonlyMap<string, readonly GraphPortfolioLink[]>;
    /** 연락처 구역용 사용자 본인 주소(연결한 GitHub 프로필). */
    contactLinks?: readonly GraphPortfolioLink[];
    templateId?: string | null;
  },
): string {
  const tpl = getPortfolioTemplate(opts.templateId);
  const lines: string[] = [`# ${clean(opts.title) || "포트폴리오"}`];
  if (opts.personName?.trim()) lines.push("", `**${clean(opts.personName)}**`);
  if (clean(out.headline)) lines.push("", `> ${clean(out.headline)}`);

  const names = out.projects.map((p) => clean(p.name) || "프로젝트");
  const allLinks = out.projects.flatMap((p, i) => (opts.links?.get(p.projectId) ?? []).map((l) => ({ label: `${names[i]} · ${l.label}`, url: l.url })));
  const top = sectionsByKey(out.sections);
  const contact = opts.contactLinks ?? [];
  const topCtx = (sec: PortfolioTemplateSection): SectionContext => ({
    content: top.get(sec.key),
    skills: out.coreSkills,
    links: allLinks,
    contact,
    toc: names,
    chips: false,
  });

  for (const sec of tpl.before) lines.push(...sectionLines(sec, 2, topCtx(sec)));

  out.projects.forEach((p, i) => {
    const label = tpl.projectLabel ? `${tpl.projectLabel} ` : "";
    lines.push("", "---", "", `## ${label}${i + 1}. ${names[i]}`);
    if (clean(p.oneLiner)) lines.push("", `**${clean(p.oneLiner)}**`);
    const meta = [clean(p.period), clean(p.affiliation)].filter(Boolean);
    if (meta.length) lines.push("", meta.join(" · "));
    const own = sectionsByKey(p.sections);
    for (const sec of tpl.project) {
      lines.push(...sectionLines(sec, 3, { content: own.get(sec.key), skills: p.techStack, links: opts.links?.get(p.projectId) ?? [], contact, toc: [], chips: true }));
    }
  });

  const after = tpl.after.flatMap((sec) => sectionLines(sec, 2, topCtx(sec)));
  if (after.length) lines.push("", "---", ...after);
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
