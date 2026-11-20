import { isAgentRunner } from "@/lib/resume-agent/chain";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 에이전트 실행기(맥미니) 상태 확인. 실행기로 뜬 서버만 204, 그 밖의 배포는 404(존재도 숨김). 내용·인증 없음. */
export function GET() {
  return new Response(null, { status: isAgentRunner() ? 204 : 404, headers: { "Cache-Control": "no-store" } });
}
