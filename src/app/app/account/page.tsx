import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import { DeleteAccountButton } from "@/components/account/DeleteAccount";
import { MarketingConsent } from "@/components/account/MarketingConsent";
import { formatDateTime } from "@/components/app/stages";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { getAccountInfo } from "@/lib/auth/account";
import { requireUser } from "@/lib/auth/session";
import { CONSENT_DOCS, marketingAgreed, type ConsentSource } from "@/lib/legal/consents";
import { getLatestConsents, listConsentHistory } from "@/lib/legal/service";

const SOURCE_LABEL: Record<ConsentSource, string> = { signup: "가입", gate: "재확인", account: "계정 설정" };

const HISTORY_LABEL = {
  terms: "이용약관",
  privacy: "개인정보 처리 안내",
  age14: "만 14세 이상 확인",
  marketing: "광고성 정보 수신",
} as const;

export const metadata: Metadata = { title: "계정" };
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireUser("/app/account");
  const [info, latest, history] = await Promise.all([
    getAccountInfo(user.id),
    getLatestConsents(user.id),
    listConsentHistory(user.id, 20),
  ]);
  if (!info) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          계정
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          가입과 로그인은 Google 계정으로만 합니다.
        </p>
      </div>

      <Card>
        <CardHeader title="로그인 정보" />
        <CardBody>
          <dl className="grid max-w-lg grid-cols-[7rem_1fr] gap-y-2 text-sm">
            <dt className="text-slate-500">이메일</dt>
            <dd className="break-all text-slate-900">{info.email}</dd>
            {info.name && (
              <>
                <dt className="text-slate-500">이름</dt>
                <dd className="text-slate-900">{info.name}</dd>
              </>
            )}
            <dt className="text-slate-500">Google</dt>
            <dd className="text-slate-900">
              {info.googleLinked ? "연결됨" : "연결 안 됨"}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="동의 관리"
          description={
            <>
              <Link href="/terms" className="text-indigo-700 underline underline-offset-2">
                이용약관
              </Link>{" "}
              ·{" "}
              <Link href="/privacy" className="font-semibold text-indigo-700 underline underline-offset-2">
                개인정보 처리방침
              </Link>
            </>
          }
        />
        <CardBody className="space-y-5">
          <MarketingConsent agreed={marketingAgreed(latest)} />
          {history.length > 0 && (
            <details>
              <summary className="cursor-pointer text-sm font-medium text-slate-600 hover:text-slate-900">동의 기록 보기</summary>
              <ul className="mt-2 divide-y divide-slate-100 text-xs text-slate-600">
                {history.map((h, i) => (
                  <li key={`${h.type}-${h.at}-${i}`} className="flex flex-wrap gap-x-3 py-1.5">
                    <span className="w-32 shrink-0 tabular-nums">{formatDateTime(h.at)}</span>
                    <span className="font-medium text-slate-800">{HISTORY_LABEL[h.type] ?? h.type}</span>
                    <span>{h.agreed ? (CONSENT_DOCS[h.type]?.kind === "consent" ? "동의" : "확인") : "철회"}</span>
                    <span className="text-slate-400">
                      {SOURCE_LABEL[h.source] ?? h.source} · {h.version}판
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title="회원 탈퇴"
          description="탈퇴하면 계정과 진단·이력서·공고·지원 기록, 경험 그래프, 올린 파일이 모두 삭제되며 되돌릴 수 없습니다."
        />
        <CardBody>
          <DeleteAccountButton />
        </CardBody>
      </Card>
    </div>
  );
}
