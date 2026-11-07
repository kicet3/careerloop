/**
 * 에이전트 설정(환경 변수, 순수 — 테스트를 위해 env를 인자로 받는다).
 * - RESUME_AGENT: "0" 끔 / "admin" ADMIN_EMAILS 계정만 / 그 밖(기본) 켬. graphEnabled()도 필요하다(호출부가 확인).
 * - RESUME_AGENT_MAX_REVISIONS(0~2, 기본 2), RESUME_AGENT_MIN_FIT(기본 75), RESUME_AGENT_PANEL(core|full, 기본 core),
 *   RESUME_AGENT_READER_EFFORT(low|medium, 기본 low — final_panel 독자 4명).
 */
import { isAdminEmail } from "@/lib/auth/admin-emails";
import type { Effort } from "@/lib/llm/types";

type Env = Record<string, string | undefined>;

/** 에이전트를 이 사용자에게 보일지(그래프 저장소 설정 여부는 호출부가 함께 본다). */
export function agentEnabledFor(user: { email?: string | null }, env: Env = process.env): boolean {
  const flag = (env.RESUME_AGENT ?? "").trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  if (flag === "admin") return isAdminEmail(user.email ?? null, env);
  return true;
}

export interface AgentSettings {
  maxRevisions: number;
  minFit: number;
  panel: "core" | "full";
  readerEffort: Effort;
}

export function agentSettings(env: Env = process.env): AgentSettings {
  const rev = Number(env.RESUME_AGENT_MAX_REVISIONS);
  const fit = Number(env.RESUME_AGENT_MIN_FIT);
  return {
    maxRevisions: Number.isInteger(rev) && rev >= 0 && rev <= 2 ? rev : 2,
    minFit: Number.isFinite(fit) && fit >= 40 && fit <= 100 ? Math.round(fit) : 75,
    panel: env.RESUME_AGENT_PANEL === "full" ? "full" : "core",
    readerEffort: env.RESUME_AGENT_READER_EFFORT === "medium" ? "medium" : "low",
  };
}
