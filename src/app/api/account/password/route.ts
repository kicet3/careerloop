import { authError, readJson } from "@/lib/auth/http";
import { setAccountPassword } from "@/lib/auth/account";
import { passwordChangeLimiter } from "@/lib/auth/rate-limit";
import {
  assertSameOrigin,
  requireApiUser,
  revokeOtherSessions,
} from "@/lib/auth/session";
import { SetPasswordInputSchema, toFieldErrors } from "@/lib/auth/validation";

/** 로그인한 사용자의 이메일 로그인용 비밀번호 설정·변경. 성공하면 현재 기기를 뺀 다른 세션을 모두 끊는다. */
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireApiUser();
  if (user instanceof Response) return user;

  const limit = passwordChangeLimiter.hit(user.id);
  if (!limit.ok) {
    return authError(
      429,
      "시도가 너무 많습니다. 잠시 후 다시 시도해 주세요.",
      undefined,
      {
        "Retry-After": String(limit.retryAfterSec),
      },
    );
  }

  const parsed = SetPasswordInputSchema.safeParse(await readJson(req));
  if (!parsed.success)
    return authError(
      400,
      "입력값을 확인해 주세요.",
      toFieldErrors(parsed.error),
    );

  const result = await setAccountPassword(user.id, parsed.data);
  if (!result.ok) {
    if (result.reason === "current_required")
      return authError(400, "현재 비밀번호를 입력해 주세요.", {
        currentPassword: "현재 비밀번호를 입력해 주세요.",
      });
    if (result.reason === "current_invalid")
      return authError(400, "현재 비밀번호가 올바르지 않습니다.", {
        currentPassword: "현재 비밀번호가 올바르지 않습니다.",
      });
    return authError(404, "계정을 찾을 수 없습니다.");
  }
  passwordChangeLimiter.reset(user.id);
  await revokeOtherSessions(user.id);
  return Response.json({ ok: true, created: result.created });
}
