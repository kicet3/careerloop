import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { authErrorMessage } from "@/lib/auth/google";
import { safeNextPath } from "@/lib/auth/validation";
import { googleLoginConfigured, passwordLoginEnabled } from "@/lib/config/env";
import { AuthForm } from "../AuthForm";

export const metadata: Metadata = { title: "로그인" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">로그인</h1>
      <p className="mt-1 mb-6 text-sm text-slate-600">진단 이력과 보고서를 이어서 확인하세요.</p>
      <AuthForm
        mode="login"
        next={next}
        googleEnabled={googleLoginConfigured()}
        passwordEnabled={passwordLoginEnabled()}
        initialError={authErrorMessage(params.error)}
      />
    </>
  );
}
