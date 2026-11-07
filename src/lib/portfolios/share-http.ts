import "server-only";
/** 공개 포트폴리오 라우트(/api/p/[token]/*) 공용 응답. 없는 토큰·공개를 끈 것·바뀐 옛 토큰·챗봇을 끈 것은 모두 같은 404. */
import { normalizeIpForLimit } from "@/lib/auth/db-rate-limit";
import { clientIp, createRateLimiter, shareLimiter } from "@/lib/auth/rate-limit";

const PUBLIC_HEADERS = { "Cache-Control": "no-store", "X-Robots-Tag": "noindex, nofollow", "Referrer-Policy": "no-referrer" };

export const publicShareNotFound = () => Response.json({ error: "찾을 수 없습니다." }, { status: 404, headers: PUBLIC_HEADERS });

export function publicJson(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return Response.json(body, { status: init.status ?? 200, headers: { ...PUBLIC_HEADERS, ...init.headers } });
}

const globalForViewer = globalThis as unknown as { __shareViewerLimiter?: ReturnType<typeof createRateLimiter> };
/**
 * PDF 보기 조각(?viewer=1 Range 요청): 한 문서를 1MB 안팎 조각 여러 개로 받아 가므로 공유 페이지 리미터(1분 30회)와 따로,
 * IP당 1분 600회(30MB PDF를 처음부터 끝까지 받아도 남는다). 조각마다 공개 여부는 다시 확인한다.
 */
const shareViewerLimiter = (globalForViewer.__shareViewerLimiter ??= createRateLimiter({ limit: 600, windowMs: 60_000 }));

/**
 * 토큰 추측·연타를 늦추는 IP(IPv6는 /64로 묶는다)당 짧은 창 제한(메모리, 공유 페이지·진단 공유와 같은 리미터를 단계 접두사로 따로 센다 —
 * PDF 보기 조각(viewer)만 따로 둔 넉넉한 리미터). 막히면 429 응답.
 */
export function publicShareRateLimit(req: Request, scope: "original" | "viewer" | "chat"): Response | null {
  const limiter = scope === "viewer" ? shareViewerLimiter : shareLimiter;
  const limit = limiter.hit(`p-${scope}:${normalizeIpForLimit(clientIp(req))}`);
  if (limit.ok) return null;
  return publicJson(
    { error: "요청이 너무 많습니다. 잠시 후 다시 시도해 주세요." },
    { status: 429, headers: { "Retry-After": String(limit.retryAfterSec) } },
  );
}
