import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PasswordForm } from "@/components/app/PasswordForm";
import { Card, CardBody, CardHeader } from "@/components/ui";
import { getAccountInfo } from "@/lib/auth/account";
import { requireUser } from "@/lib/auth/session";

export const metadata: Metadata = { title: "계정" };
export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await requireUser("/app/account");
  const info = await getAccountInfo(user.id);
  if (!info) notFound();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight text-slate-900">
          계정
        </h1>
        <p className="mt-1 text-sm text-slate-500">
          가입은 Google 계정으로만 합니다. 비밀번호를 정하면 이메일로도 로그인할
          수 있습니다.
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
            <dt className="text-slate-500">이메일 로그인</dt>
            <dd className="text-slate-900">
              {info.hasPassword ? "사용 중" : "비밀번호 미설정"}
            </dd>
          </dl>
        </CardBody>
      </Card>

      <Card>
        <CardHeader
          title={info.hasPassword ? "비밀번호 변경" : "비밀번호 설정"}
          description={
            info.hasPassword
              ? "변경하면 지금 기기를 뺀 다른 기기의 로그인은 모두 해제됩니다."
              : `설정하면 ${info.email}과 이 비밀번호로 로그인할 수 있습니다.`
          }
        />
        <CardBody>
          <PasswordForm hasPassword={info.hasPassword} />
        </CardBody>
      </Card>
    </div>
  );
}
