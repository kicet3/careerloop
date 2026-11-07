/**
 * 에이전트 RAG 설정. GRAPH_RAG=1|0(기본 켬). 운영(APP_ENV=PRODUCTION)에서는 RAG_EVIDENCE_SECRET(32자 이상)이 없으면 끈다 —
 * 그때 경험 질문하기는 기존 파이프라인을 쓴다(docs/AGENTIC-GRAPH-RAG.md §7.5).
 */
import { randomBytes } from "node:crypto";
import { isProduction } from "@/lib/config/env";

/** 개발·테스트용 프로세스 키(요청 상태가 아니라 상수 — 프로세스가 다시 뜨면 바뀐다). */
const PROCESS_EVIDENCE_KEY = randomBytes(32);

export function evidenceSecret(env: Record<string, string | undefined> = process.env): Buffer | null {
  const raw = env.RAG_EVIDENCE_SECRET?.trim();
  if (raw && raw.length >= 32) return Buffer.from(raw, "utf8");
  return isProduction(env) ? null : PROCESS_EVIDENCE_KEY;
}

/** 에이전트 경로를 쓸지. */
export function ragEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const flag = env.GRAPH_RAG?.trim().toLowerCase();
  if (flag === "0" || flag === "off" || flag === "false") return false;
  return evidenceSecret(env) !== null;
}

/** 보조 LLM 함의 검사(선택, 덜어내기 전용). */
export function entailmentEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.RAG_ENTAILMENT?.trim().toLowerCase() === "on";
}
