import "server-only";
/**
 * 새 이력서 만들기: 출처(그래프·진단 재작성본·빈 문서) 자료를 불러와 필요하면 AI 초안을 쓰고 v1로 저장한다.
 */
import { FeatureError } from "@/lib/api/errors";
import { emptyResumeDocument, performanceScaffold, type ResumeDocument, type ResumeKind } from "@/lib/domain/resumes";
import { createLlmClient, type LlmClient } from "@/lib/llm";
import { withLlmDeadline } from "@/lib/llm/deadline";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { generateResumeDraft, loadDraftMaterial } from "./draft";
import { copyResume, createResume, RESUME_NOT_FOUND } from "./service";
import type { CreateResumeInput, CreateResumeResponse } from "./types";

export interface CreateDeps {
  /** 테스트용: 엔진 선택 없이 이 클라이언트를 쓴다. */
  client?: LlmClient;
  signal?: AbortSignal;
  /** AI 초안 대기 상한(기본 INTERACTIVE_LLM_TIMEOUT_MS). 테스트용. */
  timeoutMs?: number;
}

/** 공용 이력서 초안의 '지원 회사·직무' 자리(프롬프트용). */
const GENERAL_DRAFT_COMPANY = "(지정 없음 — 여러 회사에 두루 내는 공용 이력서)";
const GENERAL_DRAFT_ROLE = "(지정 없음 — 자료에서 가장 잘 드러나는 직무)";

/**
 * 새 이력서. sourceResumeId가 있으면 그 이력서 내용을 복사하고(AI 없음, 원본이 남의 것이면 404),
 * 아니면 출처(그래프·진단 재작성본·빈 문서)로 v1을 만든다. kind 'general'은 회사·직무·공고 없이 만든다.
 */
export async function createResumeFromInput(
  user: { id: string; email: string; name: string | null },
  input: Omit<CreateResumeInput, "kind"> & { kind?: ResumeKind },
  deps: CreateDeps = {},
): Promise<CreateResumeResponse> {
  const general = input.kind === "general";
  if (input.sourceResumeId) {
    const copied = await copyResume(user.id, input.sourceResumeId, {
      kind: input.kind ?? "company",
      company: input.company,
      roleTitle: input.roleTitle,
      jdText: input.jdText,
      postingId: general ? null : (input.postingId ?? null),
      title: input.title || null,
    });
    if (!copied) throw new FeatureError(RESUME_NOT_FOUND, 404);
    return { id: copied.resume.id, notes: [], missingInfo: [] };
  }
  const material = await loadDraftMaterial(user, input.source);
  let document: ResumeDocument;
  let notes: string[] = [];
  let missingInfo: string[] = [];
  if (material) {
    const client = deps.client ?? createLlmClient(await resolveRequestedProvider(input.provider ?? null), { userId: user.id });
    // 요청 안에서 기다리므로 전체 시간에 상한을 둔다(CLI 엔진 대기·재요청이 쌓여도 수십 분 붙잡히지 않게).
    const { draft } = await withLlmDeadline(
      deps.signal,
      (signal) =>
        generateResumeDraft(
          client,
          {
            company: general ? GENERAL_DRAFT_COMPANY : input.company,
            roleTitle: general ? GENERAL_DRAFT_ROLE : input.roleTitle,
            jdText: general ? "" : input.jdText,
            templateId: input.templateId,
            material,
            personName: user.name,
          },
          signal,
        ),
      { timeoutMs: deps.timeoutMs, message: "AI 초안을 만드는 데 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도하거나 빈 문서로 시작해 주세요." },
    );
    document = draft.document;
    notes = draft.notes;
    missingInfo = draft.missingInfo;
  } else {
    document = emptyResumeDocument();
    document.basics.name = (user.name ?? "").slice(0, 80);
    document.basics.email = user.email.slice(0, 160);
    document.basics.headline = general ? "" : input.roleTitle.slice(0, 160);
    // 성과 중심 양식은 원본 예시 구조(성과 2·경력 2·프로젝트 2·역량 2·학력 1·자격 1)를 빈 항목으로 깔아 안내 문구가 보이게 한다.
    if (input.templateId === "performance") document = performanceScaffold(document);
  }

  const { resume } = await createResume(user.id, {
    kind: input.kind ?? "company",
    company: input.company,
    roleTitle: input.roleTitle,
    jdText: input.jdText,
    templateId: input.templateId,
    title: input.title,
    document,
    source: material ? "ai" : "manual",
    postingId: input.postingId ?? null,
    note: material ? (material.kind === "graph" ? "경험 그래프로 만든 AI 초안" : "진단 재작성본으로 만든 AI 초안") : "빈 문서",
  });
  return { id: resume.id, notes, missingInfo };
}
