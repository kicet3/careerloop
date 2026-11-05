import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { DeleteAccountButton } from "@/components/account/DeleteAccount";
import { LogoutButton } from "@/components/account/LogoutButton";
import { MarketingConsent } from "@/components/account/MarketingConsent";
import { accessRedirectPath } from "@/lib/auth/access";
import { getCurrentAccess, requireSignedInUser } from "@/lib/auth/session";
import { BUSINESS } from "@/lib/brand";
import { marketingAgreed } from "@/lib/legal/consents";
import { getLatestConsents } from "@/lib/legal/service";

export const metadata: Metadata = { title: "승인 대기" };
export const dynamic = "force-dynamic";

const COPY = {
  pending: {
    title: "관리자 승인 대기 중입니다",
    body: "가입 신청이 접수되었습니다. 관리자가 승인하면 바로 이용할 수 있습니다. 승인 후 이 화면을 새로고침하거나 다시 로그인해 주세요.",
  },
  rejected: {
    title: "가입이 승인되지 않았습니다",
    body: "이 계정은 이용 승인이 거절되었습니다. 문의가 있으면 아래 연락처로 알려 주세요. 원하면 회원 탈퇴로 정보를 바로 삭제할 수 있습니다.",
  },
  suspended: {
    title: "이용이 정지된 계정입니다",
    body: "관리자가 이 계정의 이용을 정지했습니다. 정지에 대한 문의나 이의 제기는 아래 연락처로 알려 주세요.",
  },
} as const;

/** 승인 대기·거절·정지 안내. 로그인은 됐지만 앱을 쓸 수 없는 사용자만 머문다(승인됐으면 /app, 동의가 없으면 /consent로). */
export default async function PendingPage() {
  await requireSignedInUser("/pending");
  const access = await getCurrentAccess();
  if (!access) redirect("/login");
  if (access.decision === "ok" || access.decision === "consent") redirect(accessRedirectPath(access.decision) ?? "/app");
  const copy = COPY[access.decision];
  // 가입 때 광고성 정보 수신에 동의(또는 기록)한 사용자는 승인 전·정지 중에도 여기서 철회할 수 있어야 한다(설정 화면은 승인 뒤에만 열린다).
  const latest = await getLatestConsents(access.user.id);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">{copy.title}</h1>
      <p className="mt-2 text-sm leading-relaxed text-slate-600">{copy.body}</p>
      <dl className="mt-5 grid grid-cols-[5rem_1fr] gap-y-1.5 rounded-lg bg-slate-50 px-4 py-3 text-sm">
        <dt className="text-slate-500">계정</dt>
        <dd className="break-all text-slate-900">{access.user.email}</dd>
        <dt className="text-slate-500">문의</dt>
        <dd className="break-all text-slate-900">
          <a href={`mailto:${BUSINESS.email}`} className="text-indigo-700 underline underline-offset-2">
            {BUSINESS.email}
          </a>
        </dd>
      </dl>
      {latest.marketing && (
        <div className="mt-4 rounded-lg border border-slate-200 px-4 py-3">
          <MarketingConsent agreed={marketingAgreed(latest)} />
        </div>
      )}
      <div className="mt-6 flex flex-wrap justify-center gap-2">
        <LogoutButton variant="secondary" />
        <DeleteAccountButton variant="ghost" />
      </div>
    </>
  );
}
