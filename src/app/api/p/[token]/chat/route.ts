import { featureErrorResponse } from "@/lib/api/errors";
import { clientIp } from "@/lib/auth/rate-limit";
import { assertSameOrigin } from "@/lib/auth/session";
import { ShareChatRequestSchema } from "@/lib/domain/portfolio-shares";
import { answerShareQuestion, shareChatAvailable, ShareChatLimitError } from "@/lib/portfolios/share-chat";
import { publicJson, publicShareNotFound, publicShareRateLimit } from "@/lib/portfolios/share-http";
import { findActiveShareByToken } from "@/lib/portfolios/shares";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";
export const maxDuration = 60;

/**
 * 공개 포트폴리오 방문자 챗봇(로그인 없음). { question, history: 최근 대화 } → ShareChatResponse.
 * 공개본만 근거로 답하고 질문·답 본문은 저장하지 않는다(src/lib/portfolios/share-chat.ts). 우리 화면에서만 부른다(같은 출처).
 * 없는 토큰·공개를 끈 것·바뀐 옛 토큰·챗봇을 끈 공유·서비스 전체로 챗봇을 끈 경우(PORTFOLIO_SHARE_CHAT_DAILY_LIMIT=0)는 모두 같은 404.
 */
export async function POST(req: Request, { params }: { params: Promise<{ token: string }> }) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const limited = publicShareRateLimit(req, "chat");
  if (limited) return limited;
  const { token } = await params;
  try {
    const share = await findActiveShareByToken(token);
    if (!share || !shareChatAvailable(share)) return publicShareNotFound();
    const input = await readJsonInput(req, ShareChatRequestSchema, 32 * 1024);
    const answer = await answerShareQuestion(share, input, clientIp(req));
    return publicJson(answer);
  } catch (err) {
    if (err instanceof ShareChatLimitError) {
      return publicJson({ error: err.message }, { status: 429, headers: { "Retry-After": String(err.retryAfterSec) } });
    }
    return featureErrorResponse(err, "POST /api/p/[token]/chat");
  }
}
