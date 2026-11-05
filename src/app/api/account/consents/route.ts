import { assertSameOrigin, requireSignedInApiUser } from "@/lib/auth/session";
import { z } from "zod";
import { authError, readJson } from "@/lib/auth/http";
import { marketingAgreed } from "@/lib/legal/consents";
import { consentContextFromRequest, getLatestConsents, listConsentHistory, setMarketingConsent } from "@/lib/legal/service";

const MarketingInputSchema = z.object({ marketing: z.boolean() });

/** 동의 현황과 이력(설정 > 계정). */
export async function GET() {
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  const [latest, history] = await Promise.all([getLatestConsents(user.id), listConsentHistory(user.id)]);
  return Response.json({ marketing: marketingAgreed(latest), history }, { headers: { "Cache-Control": "no-store" } });
}

/** 광고성 정보 수신 동의·철회. 본문 { marketing: boolean }. 철회해도 서비스 이용에 제한이 없다. 승인 전 사용자도 철회할 수 있게 로그인만 확인한다. */
export async function PATCH(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  const parsed = MarketingInputSchema.safeParse(await readJson(req));
  if (!parsed.success) return authError(400, "입력값을 확인해 주세요.");
  await setMarketingConsent(user.id, parsed.data.marketing, consentContextFromRequest(req, "account"));
  return Response.json({ ok: true, marketing: parsed.data.marketing, at: Date.now() });
}
