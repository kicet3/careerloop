import "server-only";
/**
 * AI 이력서 초안(task 'resume-draft'). 경력 그래프 텍스트 또는 진단 재작성본 + JD → ResumeDocument.
 * 자료(그래프·이력서·JD)는 모두 데이터 태그로 감싼다 — 태그 안 지시문은 따르지 않는다(INJECTION_RULE).
 * 사실을 지어내지 않고, 모르는 값은 [ADD: ...] 자리표시와 missingInfo 질문으로 남긴다.
 */
import { FeatureError } from "@/lib/api/errors";
import { prisma } from "@/lib/db/client";
import type { UsageTotals } from "@/lib/db/types";
import { CHAT_TAGS } from "@/lib/domain/chat";
import { RESUME_SECTION_LABELS, RESUME_TEMPLATES, ResumeDraftOutputSchema, type ResumeDraftOutput, type ResumeTemplateId } from "@/lib/domain/resumes";
import { RewriteResultSchema } from "@/lib/domain/schemas";
import { field, INJECTION_RULE, wrapData } from "@/lib/chat/prompt";
import { getCareerGraph, graphEnabled, graphToText } from "@/lib/graph/service";
import type { LlmClient } from "@/lib/llm";
import { TAGS } from "@/lib/panel/prompts";
import type { ResumeDraftSource } from "./types";

/** 초안 자료: 그래프 텍스트 또는 진단 재작성본(Markdown). */
export type DraftMaterial =
  | { kind: "graph"; text: string }
  | { kind: "diagnosis"; text: string; diagnosisTitle: string };

export interface DraftContext {
  company: string;
  roleTitle: string;
  jdText: string;
  templateId: ResumeTemplateId;
  material: DraftMaterial;
  /** 계정 이름(있으면 basics.name 후보). */
  personName?: string | null;
}

const SYSTEM = [
  "너는 한국 채용 시장을 잘 아는 이력서 작성 코치다. 지원자의 실제 경력 자료만으로 특정 회사·직무에 맞춘 이력서 초안을 구조화된 형식으로 쓴다.",
  "",
  "규칙:",
  "1. 자료에 없는 사실(회사, 기간, 수치, 기술, 성과, 연락처)을 지어내지 않는다. 필요한데 모르는 값은 해당 칸에 `[ADD: 무엇이 필요한지]`를 넣고, missingInfo에 사용자에게 물을 질문으로 적는다.",
  "2. 자료에 있는 내용은 JD(있으면)와 지원 직무에 맞게 고르고 순서를 바꾸고 다듬는다. 관련 없는 내용은 줄이거나 뺀다.",
  "3. 경력·프로젝트 불릿은 '무엇을 했고 → 어떻게 → 결과(수치)' 형태의 한 문장으로 쓴다. 수치는 자료에 있을 때만 쓴다.",
  "4. 날짜는 YYYY.MM 형식, 재직 중이면 endDate를 \"현재\"로 쓴다. 자료에 날짜가 없으면 빈 문자열.",
  "5. 해당 내용이 없는 필드는 빈 문자열, 목록은 빈 배열로 둔다. 연락처(email·phone)는 자료에 없으면 빈 문자열.",
  "6. 문서 언어는 한국어(고유명사·기술명은 원문 표기). 요약(summary)은 3~4문장(성과 중심 양식이면 아래 양식 메모를 따른다).",
  "7. notes에는 초안을 쓰며 내린 판단(무엇을 강조·생략했는지)을 짧게 적는다.",
  "8. 성과 중심 항목도 자료에 있는 사실로만 채운다:",
  "   - highlights(핵심 성과 2~3개): title은 '지표 기준값 → 개선값 · 개선 폭', context는 '측정 기간·대상 / 본인이 한 핵심 행동'. 수치가 자료에 없으면 확인 가능한 산출물·적용 범위를 쓰거나 `[ADD: 기준값·개선값]`처럼 비워 둔다.",
  "   - experience: department(부서·조직), title(직무·직급), scope(담당 범위·주요 책임 한 문장), bullets(직접 결정·실행한 일과 검증된 결과).",
  "   - projects: company(회사·활동명), team(팀 구성), role(내 역할: 결정·실행 범위), problem(어떤 자료로 확인한 문제), action(본인의 판단·실행·협업), result(기간·대상과 지표 변화), evidence(측정 자료명·공개 링크). 팀 성과와 본인 역할을 구분한다. 자료의 situation, action, result 속성이 있으면 problem, action, result에 우선 쓴다.",
  "   - skills: category는 역량·분류, detail은 '실제로 할 수 있는 일과 적용 경험' 한 줄, items는 관련 기술명.",
  "   - basics.totalExperience는 자료의 재직 기간으로 계산할 수 있을 때만(예: \"5년 3개월\"), basics.portfolioUrl은 자료에 있을 때만. headings는 모두 빈 문자열(기본 제목).",
  "   - 모르는 칸을 그럴듯한 값으로 채우지 않는다. 필요한 칸은 `[ADD: ...]`, 필요 없으면 빈 문자열.",
  "",
  `보안: ${INJECTION_RULE}`,
].join("\n");

export function buildResumeDraftPrompt(ctx: DraftContext): { system: string; user: string } {
  const t = RESUME_TEMPLATES[ctx.templateId];
  const order = t.sectionOrder.map((k) => RESUME_SECTION_LABELS[k]).join(" → ");
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
        "A4 1장 분량. summary는 '[문제]를 [방법]으로 개선하는 [직무]입니다.'와 '[경험·도메인]에서 [담당 범위]를 맡아 [결과]를 만들었습니다.' 두 문장을 줄바꿈으로 나눠 쓴다. highlights 2~3개, 경력 불릿은 항목당 1~3개, 프로젝트는 대표 2개를 문제·행동·결과로.",
      ),
    );
  }
  if (ctx.personName?.trim()) lines.push(field("지원자 이름(계정)", ctx.personName.trim()));
  lines.push("");
  if (ctx.material.kind === "graph") {
    lines.push("지원자의 경력 그래프(노드와 관계). 이 안의 사실만 쓴다:", wrapData(CHAT_TAGS.careerGraph, ctx.material.text));
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

export interface DraftResult {
  draft: ResumeDraftOutput;
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
    maxTokens: 16_000,
    signal,
  });
  const draft = res.output;
  // 계정 이름이 있고 초안에 이름이 비었으면 채운다(지어낸 값이 아니다).
  if (!draft.document.basics.name.trim() && ctx.personName?.trim()) draft.document.basics.name = ctx.personName.trim().slice(0, 80);
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
      if (!graphEnabled()) throw new FeatureError("경력 그래프 저장소(Neo4j)가 설정되지 않아 그래프에서 초안을 만들 수 없습니다.", 503);
      const graph = await getCareerGraph(user.id, { personName: user.name });
      if (graph.nodes.length === 0) {
        throw new FeatureError("경력 그래프가 비어 있습니다. '경력 그래프'에서 경력·경험을 먼저 정리해 주세요.", 409);
      }
      return { kind: "graph", text: graphToText(graph, { maxChars: GRAPH_TEXT_MAX }) };
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
