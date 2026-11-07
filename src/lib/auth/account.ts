import "server-only";
import { profilePhotoUrl } from "@/lib/account/photo";
import { prisma } from "@/lib/db/client";
import { hashPassword, verifyPassword } from "./password";

export type AccountInfo = {
  email: string;
  name: string | null;
  hasPassword: boolean;
  googleLinked: boolean;
  /** 내 프로필 사진 주소(소유자만 읽는 /api/account/photo?v=…). 없으면 null. */
  photoUrl: string | null;
};

export async function getAccountInfo(
  userId: string,
): Promise<AccountInfo | null> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, passwordHash: true, googleSub: true, photoKey: true },
  });
  if (!row) return null;
  return {
    email: row.email,
    name: row.name,
    hasPassword: !!row.passwordHash,
    googleLinked: !!row.googleSub,
    photoUrl: profilePhotoUrl(row.photoKey),
  };
}

export type SetPasswordResult =
  | { ok: true; created: boolean }
  | { ok: false; reason: "current_required" | "current_invalid" | "not_found" };

/**
 * 이메일 로그인용 비밀번호 설정·변경. 이미 비밀번호가 있으면 현재 비밀번호가 맞아야 바꾼다.
 * 처음 설정(Google 가입 계정)은 로그인 세션만으로 허용한다.
 */
export async function setAccountPassword(
  userId: string,
  input: { currentPassword?: string; newPassword: string },
): Promise<SetPasswordResult> {
  const row = await prisma.user.findUnique({
    where: { id: userId },
    select: { passwordHash: true },
  });
  if (!row) return { ok: false, reason: "not_found" };
  if (row.passwordHash) {
    if (!input.currentPassword)
      return { ok: false, reason: "current_required" };
    if (!(await verifyPassword(input.currentPassword, row.passwordHash)))
      return { ok: false, reason: "current_invalid" };
  }
  await prisma.user.updateMany({
    where: { id: userId },
    data: { passwordHash: await hashPassword(input.newPassword) },
  });
  return { ok: true, created: !row.passwordHash };
}

export type DeleteAccountResult = { ok: true } | { ok: false; reason: "not_found" | "graph_failed" | "storage_failed" };

export interface DeleteAccountDeps {
  /** 테스트용: 그래프 삭제를 바꾼다. 기본은 NEO4J_URI가 있을 때만 deleteUserGraph. */
  deleteGraph?: (userId: string) => Promise<void>;
  /** 테스트용: 저장소(users/<id>/ 접두사) 삭제를 바꾼다. */
  deleteStorage?: (userId: string) => Promise<void>;
  /** 테스트용: GitHub 앱 권한 해지를 바꾼다. 기본은 revokeGithubGrant(최선 노력 — 실패해도 탈퇴는 진행). */
  revokeGithub?: (userId: string) => Promise<unknown>;
}

/**
 * users/<id>/ 접두사(이력서·포트폴리오 글과 원본 파일·프로필 사진 등) + uploads/<id>/ 접두사(대용량 업로드 임시 자리)를 지운다.
 */
async function deleteUserStorage(userId: string): Promise<void> {
  const { deleteObject, listByPrefix, uploadStagingPrefix, userPrefix } = await import("@/lib/storage");
  for (const key of await listByPrefix(userPrefix(userId))) await deleteObject(key);
  for (const key of await listByPrefix(uploadStagingPrefix(userId))) await deleteObject(key);
}

/**
 * 회원 탈퇴: 경험 그래프(Neo4j) → 저장소 객체(users/<id>/·uploads/<id>/ 접두사 — 포트폴리오 원본·프로필 사진 포함, R2·로컬) → DB 사용자 행 순으로 지운다.
 * DB 행을 지우기 직전에 GitHub 연결이 있으면 GitHub에서 앱 권한을 해지한다(최선 노력 — 실패해도 로그만 남기고 진행).
 * DB 행을 지우면 세션·보관 공고·진단·이력서·지원 기록·채팅·동의 기록·AI 토큰 사용량(llm_usage_events)·MCP 토큰(mcp_tokens)·경험 그래프 후속 질문(graph_followups)·GitHub 연결(github_accounts)과 가져온 저장소 정보(github_repo_snapshots)·AI 이력서 초안 작업(resume_draft_jobs)·알림(notifications)이 FK CASCADE로 함께 지워지고, 공용 공고(URL 가져오기·직접 입력 모두)의
 * created_by는 null이 된다(공용 공고 자체는 공고 페이지 내용이라 남는다). 그래프 삭제가 실패하면 아무것도 지우지 않고
 * graph_failed(다시 시도). 저장소 삭제가 실패해도 DB 행을 지우지 않고 storage_failed를 돌려준다 — 행이 남아 있어야 사용자가
 * 다시 탈퇴를 시도해 같은 접두사를 지울 수 있다(행을 먼저 지우면 남은 파일을 다시 찾을 길이 없다). 그래프는 이미 지워졌을 수 있지만
 * 다시 시도해도 안전하다(멱등). 공용 공고의 'N명이 담음'은 탈퇴 뒤 다시 센다.
 * 호출자(라우트)는 성공 뒤 세션 쿠키를 지운다(destroySession).
 */
export async function deleteAccount(userId: string, deps: DeleteAccountDeps = {}): Promise<DeleteAccountResult> {
  const exists = await prisma.user.findUnique({ where: { id: userId }, select: { id: true } });
  if (!exists) return { ok: false, reason: "not_found" };

  try {
    if (deps.deleteGraph) await deps.deleteGraph(userId);
    else {
      const { graphEnabled } = await import("@/lib/graph/client");
      if (graphEnabled()) await (await import("@/lib/graph/service")).deleteUserGraph(userId);
    }
  } catch (err) {
    console.error("[deleteAccount] 그래프 삭제 실패", err);
    return { ok: false, reason: "graph_failed" };
  }

  try {
    await (deps.deleteStorage ?? deleteUserStorage)(userId);
  } catch (err) {
    console.error("[deleteAccount] 저장소 객체 삭제 실패", userId, err);
    return { ok: false, reason: "storage_failed" };
  }

  // CASCADE로 지워질 보관함 공고가 연결된 공용 공고 — 지운 뒤 담은 사용자 수를 다시 센다.
  const shared = await prisma.jobPosting.findMany({
    select: { sharedPostingId: true },
    where: { userId, sharedPostingId: { not: null } },
    distinct: ["sharedPostingId"],
  });

  // GitHub 앱 권한 해지(토큰은 곧 행과 함께 지워진다). revokeGithubGrant는 던지지 않지만 혹시 모를 오류도 탈퇴를 막지 않는다.
  const revoke = deps.revokeGithub ?? (async (id: string) => (await import("@/lib/github/account")).revokeGithubGrant(id));
  await revoke(userId).catch((err) => console.error("[deleteAccount] GitHub 권한 해지 실패", err));

  // 공개 링크 행은 CASCADE로 지워진다 — 그 공유의 챗봇 레이트 기록(공유 id를 키에 쓴 IP 해시 등)은 FK가 없어 함께 지운다.
  const shareIds = (await prisma.portfolioShare.findMany({ select: { id: true }, where: { userId } })).map((r) => r.id);
  const { shareRateEventsWhere } = await import("@/lib/portfolios/shares");

  await prisma.$transaction([
    // rate_events는 사용자 FK가 없다 — 사용자 id를 키로 쓴 기록만 지운다(IP 키는 해시라 사용자와 연결되지 않는다).
    prisma.rateEvent.deleteMany({ where: { key: userId } }),
    ...(shareIds.length > 0 ? [prisma.rateEvent.deleteMany({ where: shareRateEventsWhere(shareIds) })] : []),
    prisma.user.deleteMany({ where: { id: userId } }),
  ]);

  if (shared.length > 0) {
    const { refreshSharedImporterCount } = await import("@/lib/postings/shared");
    for (const { sharedPostingId } of shared) {
      // 탈퇴는 이미 끝났다 — 다시 세기 실패는 로그만 남긴다(다음 담기·가져오기 때 다시 센다).
      await refreshSharedImporterCount(sharedPostingId!).catch((err) => console.error("[deleteAccount] 담은 수 다시 세기 실패", err));
    }
  }
  return { ok: true };
}
