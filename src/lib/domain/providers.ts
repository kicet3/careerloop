/**
 * 진단을 돌리는 AI 엔진(LLM 공급 경로). 클라이언트·서버가 함께 쓰는 식별자와 표시 이름만 둔다.
 * 실제 클라이언트 생성은 lib/llm/index.ts, 로그인·상태 확인은 lib/providers/*(서버 전용).
 *
 * - anthropic: ANTHROPIC_API_KEY로 Claude API 직접 호출(기본).
 * - claude-cli: 로컬 `claude` CLI(Claude Code)에 Claude 구독 계정으로 로그인해 `claude -p`로 호출.
 * - codex-cli: 로컬 `codex` CLI에 ChatGPT 계정으로 로그인해 `codex exec`로 호출.
 *
 * CLI 엔진은 서버를 띄운 PC의 CLI 로그인을 쓰는 임시·개인용 경로다(CLI_PROVIDERS=1일 때만 켜진다).
 * 예전의 가짜 심사위원(mock) 엔진은 없앴다. 그 엔진으로 만든 기존 진단은 RETIRED_PROVIDER_IDS로 알아본다.
 */
export const PROVIDER_IDS = ["anthropic", "claude-cli", "codex-cli"] as const;
export type ProviderId = (typeof PROVIDER_IDS)[number];

export const CLI_PROVIDER_IDS = ["claude-cli", "codex-cli"] as const;
export type CliProviderId = (typeof CLI_PROVIDER_IDS)[number];

export function isProviderId(v: unknown): v is ProviderId {
  return typeof v === "string" && (PROVIDER_IDS as readonly string[]).includes(v);
}

/** 없앤 엔진 id. 예전 진단 행의 provider·model 컬럼에 남아 있을 수 있다(보기만 되고 재시도는 막는다). */
export const RETIRED_PROVIDER_IDS = ["mock"] as const;

/** 더 이상 지원하지 않는 엔진으로 만든 진단인가. provider가 비어 있던 예전 행은 model 이름으로 본다. */
export function isRetiredEngine(d: { provider: string | null; model: string }): boolean {
  const retired = RETIRED_PROVIDER_IDS as readonly string[];
  return (d.provider != null && retired.includes(d.provider)) || retired.includes(d.model);
}

export const RETIRED_ENGINE_MESSAGE =
  "이 진단은 더 이상 지원하지 않는 샘플 엔진으로 만들어졌습니다. 새 진단으로 다시 시작해 주세요.";

export function isCliProviderId(v: unknown): v is CliProviderId {
  return typeof v === "string" && (CLI_PROVIDER_IDS as readonly string[]).includes(v);
}

export const PROVIDER_LABELS: Record<ProviderId, string> = {
  anthropic: "Claude API",
  "claude-cli": "Claude 계정 로그인",
  "codex-cli": "ChatGPT 계정 로그인",
};

export const PROVIDER_DESCRIPTIONS: Record<ProviderId, string> = {
  anthropic: "서버에 설정된 Anthropic API 키로 Claude를 호출합니다.",
  "claude-cli": "Claude Pro·Max 구독 계정으로 로그인한 Claude Code CLI로 심사합니다.",
  "codex-cli": "ChatGPT 계정으로 로그인한 Codex CLI로 심사합니다.",
};

/** 이력서가 전송되는 곳(새 진단 화면의 안내 문구). */
export const PROVIDER_DATA_DESTINATION: Record<ProviderId, string> = {
  anthropic: "Anthropic의 Claude API",
  "claude-cli": "Anthropic(Claude 구독 계정)",
  "codex-cli": "OpenAI(ChatGPT 계정)",
};

/** 고를 수 있는 엔진이 하나도 준비되지 않았을 때 안내. */
export const NO_ENGINE_MESSAGE =
  "지금 사용할 수 있는 AI 엔진이 없습니다. 'AI 연결'에서 Claude 또는 ChatGPT 계정으로 로그인하거나, 서버에 ANTHROPIC_API_KEY를 설정해 주세요.";

/** 새 진단 화면·연결 화면에 내려 주는 엔진 상태. */
export interface ProviderOption {
  id: ProviderId;
  label: string;
  description: string;
  /** 지금 이 엔진으로 진단을 시작할 수 있는가. */
  ready: boolean;
  /** ready가 아닐 때 이유(한국어). */
  reason: string | null;
  /** 연결된 계정 표시(이메일 등). CLI 엔진만. */
  account: string | null;
}

// ---- CLI 엔진 연결 상태(연결 화면·API 응답) ----

export interface CliStatus {
  installed: boolean;
  loggedIn: boolean;
  account: string | null;
  /** 상태 확인 자체가 실패했을 때 사유. */
  error: string | null;
}

export type LoginPhase = "starting" | "waiting" | "verifying" | "succeeded" | "failed" | "cancelled";

/** 웹 화면에 내려 주는 로그인 진행 상태. */
export interface LoginView {
  phase: LoginPhase;
  /** 사용자가 열 링크. */
  url: string | null;
  /** ChatGPT 기기 인증 코드(사용자가 링크 페이지에 입력). */
  userCode: string | null;
  /** Claude처럼 브라우저에서 받은 코드를 이 화면에 붙여넣어야 하는가. */
  needsCode: boolean;
  codeSubmitted: boolean;
  message: string | null;
  expiresAt: number;
}

export interface ProviderConnection {
  id: CliProviderId;
  enabled: boolean;
  systemLogin: boolean;
  status: CliStatus;
  login: LoginView | null;
}
