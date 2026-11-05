import { authError, readJson } from "@/lib/auth/http";
import { accessDecision } from "@/lib/auth/access";
import { assertSameOrigin, requireSignedInApiUser } from "@/lib/auth/session";
import { ConsentChoicesSchema } from "@/lib/legal/consents";
import { consentContextFromRequest, recordConsents } from "@/lib/legal/service";

/**
 * 동의 화면(/consent) 제출: 로그인했지만 현재 버전의 필수 동의가 없는 사용자(문서 개정·가입 화면을 거치지 않은 Google 로그인).
 * 본문 { terms: true, privacy: true, age14: true, marketing?: boolean }. 승인 전 사용자도 부를 수 있다(로그인만 확인).
 * 응답 { ok, decision } — decision은 기록 뒤 다시 판정한 값("ok" | "pending" | …)이라 화면이 다음 이동을 정한다.
 */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  if (user.status === "rejected" || user.status === "suspended") {
    return authError(403, "이용할 수 없는 계정입니다.");
  }

  const parsed = ConsentChoicesSchema.safeParse(await readJson(req));
  if (!parsed.success) {
    return authError(400, parsed.error.issues[0]?.message ?? "필수 항목을 모두 체크해 주세요.");
  }
  // 광고성 정보 수신은 체크했을 때만 기록한다 — 체크하지 않았다고 이전 동의를 철회로 바꾸지 않는다(철회는 설정 > 계정).
  const { marketing, ...required } = parsed.data;
  await recordConsents(user.id, marketing ? parsed.data : required, consentContextFromRequest(req, "gate"));
  // 필수 항목을 모두 현재 버전으로 기록했으므로 남은 판정은 승인 상태뿐이다.
  return Response.json({ ok: true, decision: accessDecision(user.status, []) });
}
