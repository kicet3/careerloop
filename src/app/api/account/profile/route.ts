import { authError, readJson } from "@/lib/auth/http";
import { UserNameInputSchema, updateUserName } from "@/lib/auth/profile";
import { assertSameOrigin, requireSignedInApiUser } from "@/lib/auth/session";

/** 표시 이름 바꾸기. 본문 { name }(1~40자). 승인 전 사용자도 바꿀 수 있게 로그인만 확인한다. */
export async function PATCH(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;
  const parsed = UserNameInputSchema.safeParse(await readJson(req));
  if (!parsed.success) return authError(400, parsed.error.issues[0]?.message ?? "입력값을 확인해 주세요.");
  const name = await updateUserName(user.id, parsed.data.name);
  return Response.json({ ok: true, name }, { headers: { "Cache-Control": "no-store" } });
}
