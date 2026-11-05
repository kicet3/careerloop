/**
 * CLI 출력 파서(순수 함수, 테스트 대상). 로그인 안내문에서 링크·코드를 뽑고, 상태 출력과 오류 문구를 해석한다.
 * 로그인 링크는 정해진 출처·경로만 받는다 — CLI 출력에 섞인 다른 URL을 사용자에게 링크로 내보내지 않기 위해서다.
 */

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const strip = (s: string) => s.replace(ANSI_RE, "");

const URL_TOKEN_RE = /https:\/\/[^\s\x1b\x07"'<>]+/g;

function findUrl(text: string, accept: (u: URL) => boolean): string | null {
  for (const source of [strip(text), text]) {
    for (const m of source.matchAll(URL_TOKEN_RE)) {
      const token = m[0].replace(/[)\].,;:!]+$/, "");
      let u: URL;
      try {
        u = new URL(token);
      } catch {
        continue;
      }
      if (u.protocol === "https:" && !u.username && !u.password && accept(u)) return u.toString();
    }
  }
  return null;
}

const CLAUDE_AUTH_HOSTS = new Set(["claude.com", "claude.ai", "console.anthropic.com", "platform.claude.com"]);

/** `claude auth login` 안내문 → 브라우저로 열 OAuth 인가 링크. 붙여넣을 코드는 그 페이지가 보여 준다. */
export function parseClaudeLoginPrompt(output: string): { url: string } | null {
  const url = findUrl(output, (u) => CLAUDE_AUTH_HOSTS.has(u.hostname) && /\/oauth\/authorize$/.test(u.pathname));
  return url ? { url } : null;
}

export const CODEX_DEVICE_URL = "https://auth.openai.com/codex/device";

/** `codex login --device-auth` 안내문 → 기기 인증 페이지와 1회용 코드. */
export function parseCodexDevicePrompt(output: string): { url: string; code: string } | null {
  const text = strip(output);
  const url = findUrl(text, (u) => u.origin + u.pathname === CODEX_DEVICE_URL && !u.search && !u.hash);
  if (!url) return null;
  const after = text.slice(text.indexOf(CODEX_DEVICE_URL) + CODEX_DEVICE_URL.length);
  const code = /one-time code[^\n]*\n\s*([A-Z0-9]{4}-[A-Z0-9]{4,6})\s*$/im.exec(after)?.[1];
  return code ? { url, code } : null;
}

/** `claude auth status` JSON → 로그인 여부와 계정. 구독 로그인(claude.ai)만 연결로 본다. */
export function parseClaudeAuthStatus(stdout: string): {
  parsed: boolean;
  loggedIn: boolean;
  account: string | null;
  method: string | null;
} {
  try {
    const j = JSON.parse(stdout) as { loggedIn?: unknown; authMethod?: unknown; email?: unknown };
    if (!j || typeof j !== "object" || typeof j.loggedIn !== "boolean") throw new Error("unexpected");
    const method = typeof j.authMethod === "string" ? j.authMethod : null;
    return {
      parsed: true,
      loggedIn: j.loggedIn === true && method !== "none",
      account: typeof j.email === "string" && j.email ? j.email : null,
      method,
    };
  } catch {
    return { parsed: false, loggedIn: false, account: null, method: null };
  }
}

/** `codex login status` 출력 → 로그인 여부와 방식. */
export function parseCodexLoginStatus(output: string): { recognized: boolean; loggedIn: boolean; account: string | null } {
  const text = strip(output).trim();
  if (/not logged in/i.test(text)) return { recognized: true, loggedIn: false, account: null };
  const m = /logged in using ([^\n]+)/i.exec(text);
  return m ? { recognized: true, loggedIn: true, account: m[1]!.trim() } : { recognized: false, loggedIn: false, account: null };
}

/** CLI 오류 문구가 로그인 문제(미로그인·토큰 만료)인가. */
export function looksLikeAuthError(text: string): boolean {
  return /not\s+logged\s+in|please\s+(?:run\s+)?[`/]?(?:claude\s+)?login|login\s+required|log\s+in\s+again|authentication[_\s-](?:failed|error|required)|failed\s+to\s+authenticate|invalid\s+(?:bearer|access|api)\s*(?:token|key)|oauth\s+token\s+(?:has\s+)?expired|token\s+(?:is\s+)?(?:expired|revoked)|refresh\s+token|unauthorized|\b401\b/i.test(
    text,
  );
}

/** 구독 계정의 사용량 한도(몇 시간 뒤에야 풀린다). */
export function looksLikeUsageLimit(text: string): boolean {
  return /usage\s+limit|hit\s+your\s+limit|limit\s+reached|quota|(?:5-hour|weekly|daily)\s+limit|resets?\s+(?:at|in)\b/i.test(text);
}

/** 과부하·일시적 속도 제한(잠시 뒤 다시 하면 된다). */
export function looksLikeTransientOverload(text: string): boolean {
  return /overloaded|\b529\b|\b429\b|too\s+many\s+requests|rate[\s_-]?limit|\b50[234]\b|temporarily\s+unavailable/i.test(text);
}
