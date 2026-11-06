import "server-only";
/**
 * 'AI로 다시 정리': 저장된 공고 본문(가져온 원문 sourceText, 없거나 jdText를 고쳤으면 jdText)으로 구역만 LLM에 다시 뽑아
 * 근거 검증 뒤 저장한다. 페이지를 다시 내려받지 않는다. jdText가 원문이 아니라 구조로 조합된 상태(URL 가져오기)일 때만
 * jdText를 새 구조로 다시 조합한다 — 직접 입력한 JD는 사용자 글이라 덮어쓰지 않는다. 외국어 본문이면 근거 검증 뒤 구역을
 * 한국어로 옮긴다(extractStructure → translate.ts). 직무명·근무지 컬럼은 바꾸지 않는다.
 */
import { FeatureError } from "@/lib/api/errors";
import type { JobPosting } from "@/lib/domain/postings";
import type { LlmClient } from "@/lib/llm";
import { INTERACTIVE_LLM_TIMEOUT_MS, withLlmDeadline } from "@/lib/llm/deadline";
import { extractStructure } from "./extract";
import { getPosting, setPostingStructure } from "./service";
import { structureInputText } from "./structure";

export async function restructurePosting(
  userId: string,
  id: string,
  deps: { llm: LlmClient; signal?: AbortSignal; timeoutMs?: number },
): Promise<JobPosting | null> {
  const posting = await getPosting(userId, id);
  if (!posting) return null;
  const input = structureInputText(posting);
  if (!input.trim()) throw new FeatureError("정리할 JD 원문이 없습니다. 공고 수정에서 JD를 붙여넣어 주세요.", 400);
  // 번역은 전체 상한 전에 스스로 끝낸다 — 늦어지면 근거 검증을 마친 원문 구역을 저장한다.
  const deadlineAt = Date.now() + (deps.timeoutMs ?? INTERACTIVE_LLM_TIMEOUT_MS);
  const run = (signal: AbortSignal) => extractStructure(input, deps.llm, { signal, company: posting.company, deadlineAt });
  const { structure } = await withLlmDeadline(deps.signal, run, {
    timeoutMs: deps.timeoutMs,
    message: "공고 정리가 너무 오래 걸려 중단했습니다. 잠시 후 다시 시도해 주세요.",
  });
  // 가져온 원문으로 정리했으면 jdText도 새 구조로 조합한다(얇으면 원문으로 되돌린다).
  const composeJd = !!posting.sourceText && input === posting.sourceText;
  return setPostingStructure(userId, id, structure, { composeJd, rawText: posting.sourceText });
}
