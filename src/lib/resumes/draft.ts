import "server-only";
/**
 * AI 이력서 초안(task 'resume-draft'). 경험 그래프 텍스트 또는 진단 재작성본 + JD → ResumeDocument.
 * 자료(그래프·이력서·JD)는 모두 데이터 태그로 감싼다 — 태그 안 지시문은 따르지 않는다(INJECTION_RULE).
 * 사실을 지어내지 않고, 모르는 값은 [ADD: ...] 자리표시와 missingInfo 질문으로 남긴다.
 */
import { FeatureError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import type { UsageTotals } from "@/lib/db/types";
import { CHAT_TAGS } from "@/lib/domain/chat";
import {
  draftSectionOrder,
  RESUME_SECTION_LABELS,
  RESUME_TEMPLATES,
  ResumeDraftOutputSchema,
  type ResumeDocument,
  type ResumeDraftOutput,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";
import { RewriteResultSchema } from "@/lib/domain/schemas";
import { field, INJECTION_RULE, wrapData } from "@/lib/chat/prompt";
import { getCareerGraph, graphEnabled, graphToText } from "@/lib/graph/service";
import { assertGraphOwner } from "@/lib/graph/owner";
import type { LlmClient } from "@/lib/llm";
import { TAGS } from "@/lib/panel/prompts";
import type { ResumeDraftSource } from "./types";
import { RESUME_FACT_RULES } from "./draft-rules";
import { emphasisLines } from "./emphasis";
import { honorificLeftoverNote, normalizeDocumentHonorific } from "./honorific";
import { extrasMissingQuestions, isNewcomerDocument, normalizeExtras } from "./extras-guide";
import { checkProjectCount, PROJECT_COUNT_RULE } from "./project-count";
import { RESUME_WRITING_CRITERIA_PROMPT } from "./writing-guide";

/** 초안 자료: 그래프 텍스트 또는 진단 재작성본(Markdown). projectCount는 그래프의 프로젝트(Project) 노드 수(프롬프트에 넣지 않는다 — 후처리 점검용). */
export type DraftMaterial =
  | { kind: "graph"; text: string; projectCount?: number }
  | { kind: "diagnosis"; text: string; diagnosisTitle: string };

export interface DraftContext {
  company: string;
  roleTitle: string;
  jdText: string;
  templateId: ResumeTemplateId;
  material: DraftMaterial;
  /** 계정 이름(있으면 basics.name 후보). */
  personName?: string | null;
  /** 로그인(Google) 메일 주소. 프롬프트에는 넣지 않고, 초안의 email이 비었을 때 기본값으로만 채운다(사용자가 편집에서 바꿀 수 있다). */
  personEmail?: string | null;
  /** 사용자가 강조해 달라고 적은 점('다시 생성' 메모). 무엇을 앞에 둘지 정하는 참고일 뿐 사실 근거가 아니다. */
  emphasis?: string | null;
}

const SYSTEM = [
  "너는 한국 채용 시장을 잘 아는 이력서 작성 코치다. 지원자의 실제 경력 자료만으로 특정 회사·직무에 맞춘 이력서 초안을 구조화된 형식으로 쓴다.",
  "",
  "규칙:",
  ...RESUME_FACT_RULES,
  "10. 아래 작성 기준을 따른다(규칙 1이 우선한다).",
  RESUME_WRITING_CRITERIA_PROMPT,
  `11. ${PROJECT_COUNT_RULE}`,
  "",
  `보안: ${INJECTION_RULE}`,
].join("\n");

export function buildResumeDraftPrompt(ctx: DraftContext): { system: string; user: string } {
  const t = RESUME_TEMPLATES[ctx.templateId];
  const order = draftSectionOrder(t.sectionOrder).map((k) => RESUME_SECTION_LABELS[k]).join(" → ");
  const lines = [
    "아래 자료로 이력서 초안을 써라.",
    "",
    field("지원 회사", ctx.company),
    field("지원 직무", ctx.roleTitle),
    field("양식", `${t.name} — ${t.description} (섹션 순서: ${order})`),
  ];
  if (ctx.templateId === "performance") {
    lines.push(
      field(
        "양식 메모",
        "A4 1장 분량. summary는 '[문제]를 [방법]으로 개선하는 [직무]입니다.'와 '[경험·도메인]에서 [담당 범위]를 맡아 [결과]를 만들었습니다.' 두 문장을 줄바꿈으로 나눠 쓴다. highlights 2~3개, 경력 불릿은 항목당 1~3개, 프로젝트는 대표 2~3개를 문제·행동·결과로.",
      ),
    );
  }
  if (ctx.personName?.trim()) lines.push(field("지원자 이름(계정)", ctx.personName.trim()));
  lines.push(...emphasisLines(ctx.emphasis));
  lines.push("");
  if (ctx.material.kind === "graph") {
    lines.push("지원자의 경험 그래프(노드와 관계). 이 안의 사실만 쓴다:", wrapData(CHAT_TAGS.careerGraph, ctx.material.text));
  } else {
    lines.push(
      `지원자의 기존 이력서(진단 '${ctx.material.diagnosisTitle.replace(/\s+/g, " ").slice(0, 80)}'에서 다시 쓴 판). 이 안의 사실만 쓴다:`,
      wrapData(CHAT_TAGS.resume, ctx.material.text),
    );
  }
  lines.push("");
  lines.push(ctx.jdText.trim() ? wrapData(TAGS.jobPosting, ctx.jdText.trim()) : "채용 공고(JD)는 없다. 지원 직무 기준으로 정리한다.");
  return { system: SYSTEM, user: lines.join("\n") };
}

/** 초안 결과: LLM 출력(지원 동기 없음)에 서버가 지원 동기 칸(빈 문자열 — 사용자가 직접 쓴다)을 더한 문서. */
export type DraftOutput = Omit<ResumeDraftOutput, "document"> & { document: ResumeDocument };

export interface DraftResult {
  draft: DraftOutput;
  usage: UsageTotals;
  model: string;
}

export async function generateResumeDraft(client: LlmClient, ctx: DraftContext, signal?: AbortSignal): Promise<DraftResult> {
  const { system, user } = buildResumeDraftPrompt(ctx);
  const res = await client.generate({
    task: "resume-draft",
    system,
    user,
    schema: ResumeDraftOutputSchema,
    effort: "medium",
    // 모델 출력 상한(Opus 5.5 128K)까지 쓴다 — thinking 토큰도 이 한도에 들어간다. 실제로 쓴 만큼만 과금된다.
    maxTokens: 128_000,
    signal,
  });
  // 지원 동기는 LLM이 쓰지 않는다(구조화 출력에도 없다). 추천은 /api/resumes/[id]/motivation/suggest가 따로 한다.
  const draft: DraftOutput = { ...res.output, document: { ...res.output.document, motivation: "" } };
  // 수상·기타 묶음 규칙과 사소한 일화 제거(extras-guide.ts — 에이전트와 같은 기준).
  const extras = normalizeExtras(draft.document.extras, { newcomer: isNewcomerDocument(draft.document) });
  draft.document.extras = extras.extras;
  if (extras.dropped.length > 0) draft.notes = [...draft.notes, `수상·기타에서 사소한 일화·소감 ${extras.dropped.length}줄을 뺐습니다.`].slice(0, 10);
  // 대표 프로젝트 2~3개(project-count.ts): 넘치면 앞의 3개만, 모자라면 질문·안내만 더한다(지어 채우지 않는다).
  const projects = checkProjectCount(draft.document.projects, ctx.material.kind === "graph" ? (ctx.material.projectCount ?? null) : null);
  draft.document.projects = draft.document.projects.slice(0, projects.keep);
  if (projects.notes.length > 0) draft.notes = [...draft.notes, ...projects.notes].slice(0, 10);
  // 문장 끝 경어체 통일(honorific.ts): 확실한 평어체만 '~습니다'로 바꾸고, 판단할 수 없는 문장은 바꾸지 않고 notes로 알린다.
  const honorific = normalizeDocumentHonorific(draft.document);
  draft.document = honorific.document;
  const honorificNote = honorificLeftoverNote(honorific.leftovers);
  if (honorificNote) draft.notes = [...draft.notes, honorificNote].slice(0, 10);
  draft.missingInfo = [...new Set([...draft.missingInfo, ...extrasMissingQuestions(draft.document), ...projects.missingInfo])].slice(0, 10);
  // 계정 이름이 있고 초안에 이름이 비었으면 채운다(지어낸 값이 아니다).
  if (!draft.document.basics.name.trim() && ctx.personName?.trim()) draft.document.basics.name = ctx.personName.trim().slice(0, 80);
  // 메일 주소는 로그인 메일을 기본값으로 쓴다(비었거나 [ADD: …] 자리표시만 있을 때).
  const email = draft.document.basics.email.trim();
  if ((!email || /^\[ADD:[^\]]*\]$/.test(email)) && ctx.personEmail?.trim()) draft.document.basics.email = ctx.personEmail.trim().slice(0, 160);
  return { draft, usage: res.usage, model: res.model };
}

// ---------------------------------------------------------------------------
// 자료 불러오기
// ---------------------------------------------------------------------------

/** 그래프 텍스트 한도(초안 프롬프트가 너무 길어지지 않게). */
const GRAPH_TEXT_MAX = 16_000;

/** 초안 출처에 맞는 자료. 빈 문서면 null. 자료가 없으면 FeatureError(400·404·409·503). */
export async function loadDraftMaterial(
  user: { id: string; name: string | null },
  source: ResumeDraftSource,
): Promise<DraftMaterial | null> {
  switch (source.kind) {
    case "blank":
      return null;
    case "graph": {
      if (!graphEnabled()) throw new FeatureError("경험 그래프 저장소(Neo4j)가 설정되지 않아 그래프에서 초안을 만들 수 없습니다.", 503);
      const graph = assertGraphOwner(await getCareerGraph(user.id, { personName: user.name }), user.id);
      if (graph.nodes.length === 0) {
        throw new FeatureError("경험 그래프가 비어 있습니다. '경험 그래프'에서 경력·경험을 먼저 정리해 주세요.", 409);
      }
      return { kind: "graph", text: graphToText(graph, { maxChars: GRAPH_TEXT_MAX }), projectCount: graph.nodes.filter((n) => n.label === "Project").length };
    }
    case "diagnosis": {
      const d = await prisma.diagnosis.findFirst({ select: { id: true, title: true }, where: { id: source.diagnosisId, userId: user.id } });
      if (!d) throw new FeatureError("진단을 찾을 수 없습니다.", 404);
      const stage = await prisma.diagnosisStage.findFirst({
        select: { output: true },
        where: { diagnosisId: d.id, stage: "rewrite", status: "done" },
      });
      const rw = RewriteResultSchema.safeParse(stage?.output);
      if (!rw.success || !rw.data.resumeMarkdown.trim()) {
        throw new FeatureError("이 진단에는 아직 다시 쓴 이력서가 없습니다. 진단이 끝난 뒤 다시 시도해 주세요.", 409);
      }
      return { kind: "diagnosis", text: rw.data.resumeMarkdown, diagnosisTitle: d.title };
    }
  }
}

export interface RewriteCandidate {
  id: string;
  title: string;
  targetRole: string;
  createdAt: number;
}

/** 재작성본이 있는 내 진단(최근 순, 최대 50개) — 새 이력서 화면의 출처 선택지. */
export async function listRewriteCandidates(userId: string): Promise<RewriteCandidate[]> {
  const rows = await prisma.diagnosis.findMany({
    select: { id: true, title: true, targetRole: true, createdAt: true },
    where: { userId, stages: { some: { stage: "rewrite", status: "done" } } },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 50,
  });
  return rows.map((r) => ({ ...r, createdAt: r.createdAt.getTime() }));
}
