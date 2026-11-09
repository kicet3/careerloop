/**
 * Python 워커 연결 설정(docs/PYTHON-WORKER.md §6). 순수 함수 — env를 인자로 받아 테스트한다.
 * - WORKER_URL: 워커 주소(https://<도메인>). 없으면 모든 작업을 Vercel(after())에서 실행한다.
 * - WORKER_SHARED_SECRET: 워커와 같은 값(32자 이상). 짧으면 워커로 보내지 않는다.
 * - WORKER_JOBS: 워커로 보낼 작업 종류(쉼표 목록, '*'는 전부). 'interview'처럼 접두어를 쓰면 'interview-questions'·'interview-feedback'이 함께 켜진다.
 */
import { MIN_SECRET_LENGTH } from "./sign";

/** 워커가 받는 작업 종류. 포팅이 끝난 종류만 디스패치한다(docs/PYTHON-WORKER.md §5). */
export const WORKER_JOB_KINDS = ["resume-draft", "portfolio-graph", "interview-questions", "interview-feedback"] as const;
export type WorkerJobKind = (typeof WORKER_JOB_KINDS)[number];

export interface WorkerConfig {
  /** 끝의 '/'를 뗀 origin(+경로 없음). */
  url: string;
  secret: string;
  jobs: readonly string[];
}

type Env = Record<string, string | undefined>;

/** 쉼표 목록 → 정리된 항목(소문자·공백 제거·빈 항목 제거). */
export function parseWorkerJobs(raw: string | undefined): string[] {
  return (raw ?? "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

/** kind가 스위치 목록에 들어 있는가. '*'는 전부, 'interview'는 'interview-…' 전부. */
export function isJobEnabled(jobs: readonly string[], kind: string): boolean {
  return jobs.some((j) => j === "*" || j === kind || kind.startsWith(`${j}-`));
}

/**
 * 워커 설정. WORKER_URL이 없거나 https/http 주소가 아니거나 비밀값이 짧으면 null(워커를 쓰지 않는다).
 * 경로가 붙은 주소(https://x/worker)는 서명 경로가 nginx 뒤에서 달라지므로 받지 않는다.
 */
export function workerConfig(env: Env = process.env): WorkerConfig | null {
  const rawUrl = env.WORKER_URL?.trim();
  const secret = env.WORKER_SHARED_SECRET?.trim() ?? "";
  if (!rawUrl) return null;
  let u: URL;
  try {
    u = new URL(rawUrl);
  } catch {
    return null;
  }
  // 평문 http는 로컬 개발(localhost·127.0.0.1)에서만 — 비밀값은 서명에만 쓰지만 작업 id가 그대로 지나간다.
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if ((u.pathname !== "/" && u.pathname !== "") || u.search || u.hash || u.username || u.password) return null;
  if (secret.length < MIN_SECRET_LENGTH) return null;
  return { url: u.origin, secret, jobs: parseWorkerJobs(env.WORKER_JOBS) };
}
