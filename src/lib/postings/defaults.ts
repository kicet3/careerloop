/**
 * 보관 공고 → 다른 기능 입력의 기본값(순수). 사용자가 비워 보낸 회사·직무·JD만 공고 값으로 채운다(보낸 값은 존중).
 * JD는 구조가 있으면 구역 텍스트(postingJdForPrompt).
 */
import type { JobPosting } from "@/lib/domain/postings";
import { MAX_RESUME_JD_CHARS, MAX_RESUME_META_CHARS } from "@/lib/resumes/types";
import { postingJdForPrompt } from "./structure";

const blank = (v: unknown) => typeof v !== "string" || !v.trim();

/** POST /api/resumes 본문(검증 전)에 공고 기본값을 채운다. 객체가 아니면 그대로 돌려준다(검증이 거절한다). */
export function withResumePostingDefaults(raw: unknown, posting: Pick<JobPosting, "id" | "company" | "roleTitle" | "jdText"> & Partial<Pick<JobPosting, "structured">>): unknown {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const body = { ...(raw as Record<string, unknown>) };
  if (blank(body.company)) body.company = posting.company.slice(0, MAX_RESUME_META_CHARS);
  if (blank(body.roleTitle)) body.roleTitle = posting.roleTitle.slice(0, MAX_RESUME_META_CHARS);
  if (blank(body.jdText)) body.jdText = postingJdForPrompt({ jdText: posting.jdText, structured: posting.structured ?? null }).slice(0, MAX_RESUME_JD_CHARS);
  body.postingId = posting.id;
  return body;
}
