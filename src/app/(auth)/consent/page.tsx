import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { accessRedirectPath } from "@/lib/auth/access";
import { getCurrentAccess, requireSignedInUser } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/validation";
import { CONSENT_DOCS, marketingAgreed } from "@/lib/legal/consents";
import { getLatestConsents } from "@/lib/legal/service";
import { ConsentGateForm } from "./ConsentGateForm";

export const metadata: Metadata = { title: "약관·개인정보 안내 확인" };
export const dynamic = "force-dynamic";

/**
 * 동의 화면: 로그인했지만 현재 버전의 필수 동의가 없는 사용자(가입 화면을 거치지 않은 Google 로그인, 문서 개정, 기존 회원).
 * 동의가 필요 없으면 원래 가려던 곳(또는 승인 대기 화면)으로 보낸다.
 */
export default async function ConsentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  await requireSignedInUser(`/consent${next !== "/app" ? `?next=${encodeURIComponent(next)}` : ""}`);
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  if (access.decision !== "consent") redirect(accessRedirectPath(access.decision, next) ?? next);

  const latest = await getLatestConsents(access.user.id);
  // 예전 버전에 동의한 기록이 있으면 '개정' 안내, 없으면 처음 확인.
  const revised = access.missingConsents.filter((t) => latest[t]?.agreed && latest[t]?.version !== CONSENT_DOCS[t].version);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">
        {revised.length ? "약관·개인정보 처리방침이 바뀌었습니다" : "서비스 이용 전에 확인해 주세요"}
      </h1>
      <p className="mt-1 mb-6 text-sm text-slate-600">
        {revised.length
          ? "바뀐 내용을 확인하고 다시 동의해 주세요. 확인한 뒤 이어서 이용할 수 있습니다."
          : `${access.user.email} 계정으로 이용하려면 아래 필수 항목을 확인해 주세요.`}
      </p>
      <ConsentGateForm next={next} showMarketing={!marketingAgreed(latest)} />
    </>
  );
}
