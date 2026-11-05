import "server-only";
/**
 * 새 이력서 만들기: 출처(그래프·진단 재작성본·빈 문서) 자료를 불러와 필요하면 AI 초안을 쓰고 v1로 저장한다.
 */
import { createRateLimiter } from "@/lib/auth/rate-limit";
import { emptyResumeDocument, performanceScaffold, type ResumeDocument } from "@/lib/domain/resumes";
import { createLlmClient, type LlmClient } from "@/lib/llm";
import { withLlmDeadline } from "@/lib/llm/deadline";
import { resolveRequestedProvider } from "@/lib/providers/options";
import { generateResumeDraft, loadDraftMaterial } from "./draft";
import { createResume } from "./service";
import type { CreateResumeInput, CreateResumeResponse } from "./types";

const globalForResumes = globalThis as unknown as { __resumeDraftLimiter?: ReturnType<typeof createRateLimiter> };

/** AI 초안: 사용자당 하루 30회(엔진 비용·남용 방지). 프로세스 메모리 기준이라 느슨한 방어다. */
export const resumeDraftLimiter = (globalForResumes.__resumeDraftLimiter ??= createRateLimiter({
  limit: 30,
  windowMs: 24 * 60 * 60_000,
}));

export interface CreateDeps {
  /** 테스트용: 엔진 선택 없이 이 클라이언트를 쓴다. */
  client?: LlmClient;
  signal?: AbortSignal;
  /** AI 초안 대기 상한(기본 INTERACTIVE_LLM_TIMEOUT_MS). 테스트용. */
  timeoutMs?: number;
}

export async function createResumeFromInput(
  user: { id: string; email: string; name: string | null },
  input: CreateResumeInput,
  deps: CreateDeps = {},
): Promise<CreateResumeResponse> {
  const material = await loadDraftMaterial(user, input.source);
  let document: ResumeDocument;
  let notes: string[] = [];
  let missingInfo: string[] = [];
  if (material) {
    const client = deps.client ?? createLlmClient(await resolveRequestedProvider(input.provider ?? null));
    // 요청 안에서 기다리므로 전체 시간에 상한을 둔다(CLI 엔진 대기·재요청이 쌓여도 수십 분 붙잡히지 않게).
    const { draft } = await withLlmDeadline(
      deps.signal,
      (signal) =>
        generateResumeDraft(
          client,
          {
            company: input.company,
            roleTitle: input.roleTitle,
            jdText: input.jdText,
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
    document.basics.headline = input.roleTitle.slice(0, 160);
    // 성과 중심 양식은 원본 예시 구조(성과 2·경력 2·프로젝트 2·역량 2·학력 1·자격 1)를 빈 항목으로 깔아 안내 문구가 보이게 한다.
    if (input.templateId === "performance") document = performanceScaffold(document);
  }

  const { resume } = await createResume(user.id, {
    company: input.company,
    roleTitle: input.roleTitle,
    jdText: input.jdText,
    templateId: input.templateId,
    title: input.title,
    document,
    source: material ? "ai" : "manual",
    postingId: input.postingId ?? null,
    note: material ? (material.kind === "graph" ? "경력 그래프로 만든 AI 초안" : "진단 재작성본으로 만든 AI 초안") : "빈 문서",
  });
  return { id: resume.id, notes, missingInfo };
}
