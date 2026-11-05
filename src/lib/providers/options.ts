/**
 * 새 진단에서 고를 수 있는 엔진 목록과 선택 검증(서버 전용).
 * - anthropic: ANTHROPIC_API_KEY가 있고 LLM_MOCK이 아닐 때.
 * - claude-cli·codex-cli: CLI_PROVIDERS=1일 때 보이고, CLI 설치 + 로그인이면 사용 가능.
 * - mock: LLM_MOCK=1일 때만(개발·테스트용). 사용자 화면의 선택지로는 내보내지 않는다.
 */
import "server-only";
import {
  CLI_PROVIDER_IDS,
  isProviderId,
  NO_ENGINE_MESSAGE,
  PROVIDER_DESCRIPTIONS,
  PROVIDER_LABELS,
  type ProviderId,
  type ProviderOption,
} from "@/lib/domain/providers";
import { cliProvidersEnabled } from "./cli";
import { ProviderServiceError } from "./errors";
import { getCliStatus } from "./service";

function option(id: ProviderId, ready: boolean, reason: string | null, account: string | null = null): ProviderOption {
  return { id, label: PROVIDER_LABELS[id], description: PROVIDER_DESCRIPTIONS[id], ready, reason, account };
}

export async function listProviderOptions(): Promise<ProviderOption[]> {
  const mockOnly = process.env.LLM_MOCK === "1";
  const hasKey = !!process.env.ANTHROPIC_API_KEY && !mockOnly;
  const out: ProviderOption[] = [];
  if (hasKey) out.push(option("anthropic", true, null));
  if (cliProvidersEnabled()) {
    const statuses = await Promise.all(CLI_PROVIDER_IDS.map((p) => getCliStatus(p)));
    CLI_PROVIDER_IDS.forEach((id, i) => {
      const s = statuses[i]!;
      const reason = !s.installed
        ? `${id === "claude-cli" ? "claude" : "codex"} CLI가 서버 PC에 설치되어 있지 않습니다.`
        : !s.loggedIn
          ? (s.error ?? "'AI 연결'에서 로그인해야 쓸 수 있습니다.")
          : null;
      out.push(option(id, s.installed && s.loggedIn, reason, s.loggedIn ? s.account : null));
    });
  }
  if (mockOnly) out.push(option("mock", true, null));
  return out;
}

/** 엔진을 고르지 않았을 때: 사용 가능한 엔진 중 첫 번째. 없으면 null. */
export function pickDefault(options: ProviderOption[]): ProviderId | null {
  return options.find((o) => o.ready)?.id ?? null;
}

/** 새 진단 요청의 엔진 값 검증. 비어 있으면 기본 엔진. */
export async function resolveRequestedProvider(requested: string | null): Promise<ProviderId> {
  const options = await listProviderOptions();
  if (!requested) {
    const picked = pickDefault(options);
    if (!picked) throw new ProviderServiceError(NO_ENGINE_MESSAGE, 409);
    return picked;
  }
  if (!isProviderId(requested)) throw new ProviderServiceError("알 수 없는 AI 엔진입니다.", 400);
  const found = options.find((o) => o.id === requested);
  if (!found) throw new ProviderServiceError(`${PROVIDER_LABELS[requested]} 엔진은 이 서버에서 쓸 수 없습니다.`, 400);
  if (!found.ready) {
    throw new ProviderServiceError(`${found.label} 엔진을 아직 쓸 수 없습니다: ${found.reason ?? "연결을 확인해 주세요."}`, 409);
  }
  return found.id;
}
