/**
 * 에이전트 설정(환경 변수, 순수 — 테스트를 위해 env를 인자로 받는다).
 * - RESUME_AGENT: "0" 끔 / "admin" ADMIN_EMAILS 계정만 / 그 밖(기본) 켬. graphEnabled()도 필요하다(호출부가 확인).
 * - RESUME_AGENT_MAX_REVISIONS(0~2, 기본 2), RESUME_AGENT_MIN_FIT(기본 75), RESUME_AGENT_PANEL(core|full, 기본 core),
 *   RESUME_AGENT_READER_EFFORT(low|medium, 기본 low — final_panel 독자 4명).
 * - 구역별 에이전트(파이프라인 v2, docs/RESUME-SECTION-AGENTS.md): RESUME_AGENT_PIPELINE(1|2, 기본 2 — 새 작업에만, 시작 때 고정),
 *   RESUME_AGENT_PARALLEL(한 호출 안 병렬 구역 수 1~4, 기본 4), RESUME_AGENT_MOTIVATION("0"이면 파이프라인의 지원 동기 두 에이전트를 끈다).
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
  /** 새 작업의 단계 계획 버전(진행 중 작업은 행의 pipelineVersion을 따른다). */
  pipeline: 1 | 2;
  /** v2: 한 호출 안에서 함께 실행할 구역 단계 수(1이면 직렬). */
  parallel: number;
  /** v2: 지원처별 이력서의 지원 동기 초안·추천 에이전트를 돌릴지. */
  motivation: boolean;
}

export function agentSettings(env: Env = process.env): AgentSettings {
  const rev = Number(env.RESUME_AGENT_MAX_REVISIONS);
  const fit = Number(env.RESUME_AGENT_MIN_FIT);
  const par = Number(env.RESUME_AGENT_PARALLEL);
  return {
    maxRevisions: Number.isInteger(rev) && rev >= 0 && rev <= 2 ? rev : 2,
    minFit: Number.isFinite(fit) && fit >= 40 && fit <= 100 ? Math.round(fit) : 75,
    panel: env.RESUME_AGENT_PANEL === "full" ? "full" : "core",
    readerEffort: env.RESUME_AGENT_READER_EFFORT === "medium" ? "medium" : "low",
    pipeline: env.RESUME_AGENT_PIPELINE?.trim() === "1" ? 1 : 2,
    parallel: Number.isInteger(par) && par >= 1 && par <= 4 ? par : 4,
    motivation: !["0", "off", "false"].includes((env.RESUME_AGENT_MOTIVATION ?? "").trim().toLowerCase()),
  };
}
