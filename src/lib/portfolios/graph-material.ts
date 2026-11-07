import "server-only";
/**
 * 경험 그래프로 포트폴리오 만들기 — 자료 모으기와 AI 작성(task 'portfolio-draft').
 *
 * 사용자 간 격리(가장 중요한 규칙): 그래프는 요청 사용자의 것만 읽고(getCareerGraph(user.id)), 프롬프트에 넣기 전에 assertGraphOwner로
 * 다시 확인한다. 고른 프로젝트 id는 그 그래프의 Project 노드여야 한다 — 다른 사용자의 노드 id(또는 지워진 id)를 보내면 400으로 거절하고
 * 아무것도 프롬프트에 넣지 않는다. 링크는 AI가 쓰지 않고 그래프의 Project.url과 이 사용자가 그 프로젝트에 연결한 공개 GitHub 저장소 주소로만 붙인다.
 *
 * 사실 확인: 프롬프트는 자료에 없는 사실을 금지하고 모르는 값은 [ADD: ...]로 남기게 한다. 그래도 서술 줄(소개·개요·역할·STAR·성과·배운 점)에
 * 그 프로젝트 자료에 없는 숫자가 있으면 저장 전에 [ADD: 수치 확인 — …]로 바꾸고 '채워야 할 정보'에 더한다(지어낸 수치가 그대로 남지 않게).
 */
import { FeatureError } from "@/lib/api/errors";
import { field, INJECTION_RULE, wrapData } from "@/lib/chat/prompt";
import { prisma } from "@/lib/db/client";
import { CHAT_TAGS } from "@/lib/domain/chat";
import { type CareerGraph, type GraphNode, NODE_TITLE_KEY, nodeDisplayName } from "@/lib/domain/graph";
import {
  type GraphPortfolioLink,
  type GraphPortfolioOutput,
  GraphPortfolioOutputSchema,
  type GraphProjectOption,
} from "@/lib/domain/graph-portfolio";
import { hasMetric } from "@/lib/graph/completeness";
import { assertGraphOwner } from "@/lib/graph/owner";
import { assessProjectStructure, projectSubgraph } from "@/lib/graph/project-structure";
import { getCareerGraph, graphEnabled, graphToText } from "@/lib/graph/service";
import type { LlmClient } from "@/lib/llm";
import { TAGS } from "@/lib/panel/prompts";

export const GRAPH_DISABLED_MESSAGE = "경험 그래프 저장소(Neo4j)가 설정되지 않아 경험 그래프로 포트폴리오를 만들 수 없습니다.";
export const GRAPH_EMPTY_MESSAGE = "경험 그래프에 프로젝트가 없습니다. '경험 그래프'에서 프로젝트를 먼저 정리해 주세요.";
export const UNKNOWN_PROJECT_MESSAGE = "고른 프로젝트 중 내 경험 그래프에 없는 항목이 있습니다. 화면을 새로고침한 뒤 다시 골라 주세요.";
export const POSTING_NOT_FOUND_MESSAGE = "강조할 공고를 찾을 수 없습니다.";

/** 프롬프트에 넣는 그래프 자료 전체 상한(글자). 프로젝트 수로 나눠 쓴다. */
const MATERIAL_MAX_CHARS = 48_000;
const PER_PROJECT_MIN = 3_000;
const PER_PROJECT_MAX = 9_000;
const PROJECT_PROP_CAPS = [1000, 400, 200, 60, 0] as const;
const JD_MAX_CHARS = 8_000;

const propsOf = (n: GraphNode) => n.props as Record<string, unknown>;
const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** 요청 사용자의 그래프(소유자 확인까지). 저장소가 없으면 503. */
export async function loadOwnGraph(user: { id: string; name: string | null }): Promise<CareerGraph> {
  if (!graphEnabled()) throw new FeatureError(GRAPH_DISABLED_MESSAGE, 503);
  return assertGraphOwner(await getCareerGraph(user.id, { personName: user.name }), user.id);
}

function period(p: Record<string, unknown>): string {
  const s = str(p.startDate);
  const e = p.current === true ? "현재" : str(p.endDate);
  return s || e ? `${s}${s || e ? " ~ " : ""}${e}`.trim() : "";
}

/** 그래프의 프로젝트 → 고르기 항목(그래프 순서). */
export function graphProjectOptions(graph: CareerGraph): GraphProjectOption[] {
  return graph.nodes
    .filter((n) => n.label === "Project")
    .map((n) => {
      const p = propsOf(n);
      const s = assessProjectStructure(graph, n.id)!;
      return {
        id: n.id,
        name: nodeDisplayName(n),
        summary: (str(p.summary) || str(p.situation)).slice(0, 160),
        period: period(p),
        done: s.done,
        total: s.total,
        skills: graph.edges.filter((e) => e.from === n.id && e.type === "USED_SKILL").length,
        hasMetric: s.items.some((i) => i.id === "results" && i.state === "done") || hasMetric(str(p.result)),
      };
    });
}

/** 고른 id가 모두 이 그래프의 Project 노드인지. 하나라도 아니면 400(다른 사용자의 id·지워진 id). */
export function assertProjectsInGraph(graph: CareerGraph, projectIds: readonly string[]): void {
  const projects = new Set(graph.nodes.filter((n) => n.label === "Project").map((n) => n.id));
  if (projects.size === 0) throw new FeatureError(GRAPH_EMPTY_MESSAGE, 409);
  if (projectIds.length === 0 || projectIds.some((id) => !projects.has(id))) throw new FeatureError(UNKNOWN_PROJECT_MESSAGE, 400);
}

/** 강조할 공고(내 공고 보관함). 없으면 null. */
export async function findOwnPosting(
  userId: string,
  postingId: string,
): Promise<{ id: string; company: string; roleTitle: string; jdText: string } | null> {
  const p = await prisma.jobPosting.findFirst({ select: { id: true, company: true, roleTitle: true, jdText: true }, where: { id: postingId, userId } });
  return p ? { ...p, jdText: p.jdText ?? "" } : null;
}

export interface PortfolioProjectMaterial {
  id: string;
  name: string;
  /** 프롬프트에 넣는 이 프로젝트의 그래프 텍스트(속성 + 주변 그래프). */
  text: string;
}

export interface PortfolioMaterial {
  personName: string | null;
  projects: PortfolioProjectMaterial[];
  /** 프로젝트 id → 그래프에 있는 주소(Project.url, 공개 GitHub 저장소). */
  links: Map<string, GraphPortfolioLink[]>;
  posting: { company: string; roleTitle: string; jdText: string } | null;
}

function projectText(graph: CareerGraph, projectId: string, maxChars: number): string {
  const project = graph.nodes.find((n) => n.id === projectId)!;
  const titleKey = NODE_TITLE_KEY.Project;
  const own = Object.entries(propsOf(project))
    .filter(([k, v]) => k !== titleKey && v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `- ${k}: ${(Array.isArray(v) ? v.join("|") : String(v)).replace(/\s+/g, " ").slice(0, 1200)}`);
  const sub = projectSubgraph(graph, projectId)!;
  // 주변 그래프에서 이 프로젝트 자신은 위에 원문으로 적었으므로 다른 노드만 요약한다.
  const around = graphToText(sub, { maxChars: Math.max(1000, maxChars - own.join("\n").length - 200), propCaps: PROJECT_PROP_CAPS });
  return [`프로젝트 [${projectId}] ${nodeDisplayName(project)}`, "속성:", ...(own.length ? own : ["- (없음)"]), "주변 그래프:", around].join("\n");
}

/**
 * 자료 모으기: 요청 사용자의 그래프에서 고른 프로젝트만 잘라 낸다(고른 순서). 공고는 이 사용자의 것만(없어졌으면 공고 없이).
 * 다른 사용자의 그래프·프로젝트·공고는 어떤 경로로도 들어가지 않는다.
 */
export async function loadPortfolioMaterial(
  user: { id: string; name: string | null },
  input: { projectIds: readonly string[]; postingId?: string | null },
): Promise<PortfolioMaterial> {
  const graph = await loadOwnGraph(user);
  assertProjectsInGraph(graph, input.projectIds);
  const per = Math.max(PER_PROJECT_MIN, Math.min(PER_PROJECT_MAX, Math.floor(MATERIAL_MAX_CHARS / input.projectIds.length)));
  const projects = input.projectIds.map((id) => {
    const node = graph.nodes.find((n) => n.id === id)!;
    return { id, name: nodeDisplayName(node), text: projectText(graph, id, per) };
  });

  const links = new Map<string, GraphPortfolioLink[]>();
  const add = (id: string, link: GraphPortfolioLink) => {
    const list = links.get(id) ?? [];
    if (!list.some((l) => l.url === link.url)) list.push(link);
    links.set(id, list);
  };
  for (const p of projects) {
    const url = str(propsOf(graph.nodes.find((n) => n.id === p.id)!).url);
    if (/^https?:\/\//i.test(url)) add(p.id, { label: url.includes("github.com") ? "GitHub" : "프로젝트 링크", url });
  }
  // 이 사용자가 프로젝트에 연결한 GitHub 저장소(비공개 저장소는 남이 열 수 없으므로 붙이지 않는다).
  const repos = await prisma.githubRepoSnapshot.findMany({
    select: { projectNodeId: true, htmlUrl: true, fullName: true },
    where: { userId: user.id, private: false, projectNodeId: { in: [...input.projectIds] } },
  });
  for (const r of repos) if (r.projectNodeId && /^https:\/\/github\.com\//.test(r.htmlUrl)) add(r.projectNodeId, { label: `GitHub · ${r.fullName}`, url: r.htmlUrl });

  const posting = input.postingId ? await findOwnPosting(user.id, input.postingId) : null;
  return { personName: user.name?.trim() || null, projects, links, posting };
}

// ---------------------------------------------------------------------------
// AI 작성
// ---------------------------------------------------------------------------

const SYSTEM = [
  "너는 한국 채용 시장을 잘 아는 포트폴리오 작성 코치다. 지원자의 경험 그래프(프로젝트와 주변 노드) 자료만으로 프로젝트 중심 포트폴리오를 구조화된 형식으로 쓴다.",
  "",
  "규칙:",
  "1. 자료에 없는 사실(회사, 기간, 수치, 기술, 성과, 팀 규모, 링크)을 절대 지어내지 않는다. 필요한데 자료에 없는 값은 그 칸에 `[ADD: 무엇이 필요한지]`를 넣고 missingInfo에 사용자에게 물을 질문으로 적는다.",
  "2. 수치(%, 시간, 건수, 금액, 사용자 수 등)는 자료에 적힌 값을 그대로만 쓴다. 계산·반올림·추정한 수치를 새로 만들지 않는다. 수치가 없으면 확인 가능한 산출물·적용 범위로 쓰거나 `[ADD: 전후 수치]`로 남긴다.",
  "3. projects는 자료에 나온 프로젝트를 자료 순서대로 하나씩 쓴다. projectId는 자료의 대괄호 안 id를 그대로 쓰고, 자료에 없는 프로젝트를 만들지 않는다.",
  "4. 각 프로젝트: oneLiner(무엇을 왜), overview(배경·목표·대상 2~4문장), period('YYYY.MM ~ YYYY.MM', 진행 중이면 '~ 현재'), affiliation(회사·팀·동아리), role(맡은 역할·책임 범위, 팀 규모는 자료에 있을 때만), techStack(자료에 연결된 기술만), star(situation·task·action·result — action은 한 항목 한 문장으로 '무엇을 → 어떻게 → 왜'), outcomes(성과 한 줄씩), learned(자료에 있을 때만).",
  "5. 팀 성과와 본인 기여를 구분한다. 자료에서 본인이 한 일로 확인되지 않는 일은 본인이 했다고 쓰지 않는다.",
  "6. 강조할 공고가 있으면 공고 요건과 관련된 기술·성과를 앞에 두고 더 자세히 쓴다. 공고에 맞추려고 자료에 없는 경험을 더하지 않는다.",
  "7. headline·intro·coreSkills는 고른 프로젝트들의 자료에서만 뽑는다. 문서 언어는 한국어(고유명사·기술명은 원문 표기).",
  "8. 링크(URL)는 쓰지 않는다 — 서버가 그래프에 있는 주소를 붙인다. 연락처·개인정보도 쓰지 않는다.",
  "9. 해당 내용이 없고 꼭 필요하지 않은 칸은 빈 문자열(목록은 빈 배열)로 둔다. notes에는 무엇을 강조·생략했는지 짧게 적는다.",
  "",
  `보안: ${INJECTION_RULE}`,
].join("\n");

export function buildGraphPortfolioPrompt(m: PortfolioMaterial, opts: { title: string; notes?: string | null }): { system: string; user: string } {
  const lines = ["아래 자료로 포트폴리오를 써라.", "", field("포트폴리오 이름", opts.title)];
  if (m.personName) lines.push(field("지원자 이름(계정)", m.personName));
  if (m.posting) lines.push(field("강조할 공고", `${m.posting.company} · ${m.posting.roleTitle}`));
  if (opts.notes?.trim()) lines.push(field("사용자 요청(강조점·톤 — 사실을 더하는 근거로 쓰지 않는다)", opts.notes.trim()));
  lines.push("", `고른 프로젝트 ${m.projects.length}개의 경험 그래프 자료. 이 안의 사실만 쓴다:`);
  lines.push(wrapData(CHAT_TAGS.careerGraph, m.projects.map((p) => p.text).join("\n\n=====\n\n")));
  lines.push("");
  const jd = m.posting?.jdText.trim().slice(0, JD_MAX_CHARS) ?? "";
  lines.push(jd ? wrapData(TAGS.jobPosting, jd) : "강조할 채용 공고(JD)는 없다. 프로젝트 자체의 문제·해결·성과가 잘 드러나게 쓴다.");
  return { system: SYSTEM, user: lines.join("\n") };
}

// ---- 수치 확인 ----

const NUM_RE = /\d+(?:[.,]\d+)*/g;
const normNum = (s: string) => s.replace(/,/g, "");

/** text의 숫자 중 source에 없는 것(쉼표는 무시). */
export function unverifiedNumbers(text: string, source: string): string[] {
  const known = new Set((source.match(NUM_RE) ?? []).map(normNum));
  return [...new Set((text.match(NUM_RE) ?? []).map(normNum))].filter((n) => !known.has(n));
}

/** [ADD: ...] 안의 숫자는 자리표시라 확인하지 않는다. */
const stripPlaceholders = (s: string) => s.replace(/\[ADD:[^\]]*\]/g, " ");

/**
 * 출력 정리: 자료에 없는 프로젝트는 빼고 고른 순서로 맞추며, 서술 줄(소개·개요·역할·STAR 전부·성과·배운 점)에 그 자료에 없는 숫자가 있으면
 * [ADD: 수치 확인 — …]로 바꾼다. 기술 스택·기간은 버전·날짜 숫자가 자연스러워 확인하지 않는다.
 * 빠진 프로젝트·바꾼 줄은 missingInfo에 더한다.
 */
export function sanitizePortfolioOutput(out: GraphPortfolioOutput, m: PortfolioMaterial): GraphPortfolioOutput {
  const missing = [...out.missingInfo];
  const allSource = [m.projects.map((p) => p.text).join("\n"), m.personName ?? ""].join("\n");
  const flag = (line: string, source: string): string => {
    const bad = unverifiedNumbers(stripPlaceholders(line), source);
    if (bad.length === 0) return line;
    missing.push(`'${line.slice(0, 80)}' — 경험 그래프에 없는 수치(${bad.join(", ")})라 확인이 필요합니다. 맞다면 그래프에도 적어 주세요.`);
    return `[ADD: 수치 확인 — ${line.replace(/[[\]]/g, "")}]`;
  };
  const opt = (line: string, source: string): string => (line ? flag(line, source) : line);
  const byId = new Map(out.projects.map((p) => [p.projectId.replace(/^\[|\]$/g, "").trim(), p]));
  const projects: GraphPortfolioOutput["projects"] = [];
  for (const mp of m.projects) {
    const p = byId.get(mp.id);
    if (!p) {
      missing.push(`'${mp.name}' 프로젝트를 AI가 쓰지 않았습니다. 다시 만들거나 직접 더해 주세요.`);
      continue;
    }
    projects.push({
      ...p,
      projectId: mp.id,
      oneLiner: opt(p.oneLiner, mp.text),
      overview: opt(p.overview, mp.text),
      role: opt(p.role, mp.text),
      outcomes: p.outcomes.map((o) => flag(o, mp.text)),
      star: {
        situation: opt(p.star.situation, mp.text),
        task: opt(p.star.task, mp.text),
        action: p.star.action.map((a) => flag(a, mp.text)),
        result: opt(p.star.result, mp.text),
      },
      learned: opt(p.learned, mp.text),
    });
  }
  return {
    ...out,
    headline: opt(out.headline, allSource),
    intro: opt(out.intro, allSource),
    projects,
    missingInfo: [...new Set(missing)].slice(0, 30),
  };
}

export async function generateGraphPortfolio(
  client: LlmClient,
  m: PortfolioMaterial,
  opts: { title: string; notes?: string | null },
  signal?: AbortSignal,
): Promise<GraphPortfolioOutput> {
  const { system, user } = buildGraphPortfolioPrompt(m, opts);
  const res = await client.generate({
    task: "portfolio-draft",
    system,
    user,
    schema: GraphPortfolioOutputSchema,
    effort: "medium",
    // 이력서 초안과 같이 모델 출력 상한까지 쓴다(thinking 포함, 실제로 쓴 만큼만 과금).
    maxTokens: 128_000,
    signal,
  });
  return sanitizePortfolioOutput(res.output, m);
}
