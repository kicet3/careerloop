import { deleteAccount } from "@/lib/auth/account";
import { authError, readJson } from "@/lib/auth/http";
import { assertSameOrigin, destroySession, requireSignedInApiUser } from "@/lib/auth/session";
import { ACCOUNT_DELETE_CONFIRM } from "@/lib/domain/users";

export const runtime = "nodejs";

/**
 * 회원 탈퇴. 본문 { confirm: "탈퇴합니다" }(화면의 확인 입력). 승인 대기·거절·정지 사용자도 할 수 있다(로그인만 확인).
 * 경험 그래프 → 저장소 파일 → DB 행(CASCADE) 순으로 지우고(src/lib/auth/account.ts deleteAccount) 세션 쿠키를 비운다.
 */
export async function DELETE(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;
  const user = await requireSignedInApiUser();
  if (user instanceof Response) return user;

  const body = (await readJson(req)) as { confirm?: unknown } | null;
  if (body?.confirm !== ACCOUNT_DELETE_CONFIRM) {
    return authError(400, `확인 문구 '${ACCOUNT_DELETE_CONFIRM}'를 정확히 입력해 주세요.`, {
      confirm: `'${ACCOUNT_DELETE_CONFIRM}'를 입력해 주세요.`,
    });
  }

  const result = await deleteAccount(user.id);
  if (!result.ok) {
    if (result.reason === "graph_failed") {
      return authError(503, "경험 그래프 삭제에 실패해 탈퇴를 멈췄습니다. 잠시 후 다시 시도해 주세요. 아무것도 지워지지 않았습니다.");
    }
    if (result.reason === "storage_failed") {
      return authError(503, "저장된 파일 삭제에 실패해 탈퇴를 멈췄습니다. 잠시 후 다시 시도해 주세요. 계정은 아직 남아 있습니다.");
    }
    // 이미 지워진 계정 — 쿠키만 비운다.
  }
  await destroySession();
  return Response.json({ ok: true });
}
