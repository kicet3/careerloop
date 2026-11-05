import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { authErrorMessage } from "@/lib/auth/google";
import { safeNextPath } from "@/lib/auth/validation";
import { googleLoginConfigured, passwordLoginEnabled } from "@/lib/config/env";
import { AuthForm } from "../AuthForm";

export const metadata: Metadata = { title: "회원가입" };

export default async function SignupPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const params = await searchParams;
  const next = safeNextPath(params.next);
  if (await getCurrentUser()) redirect(next);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">회원가입</h1>
      <p className="mt-1 mb-6 text-sm text-slate-600">
        심사위원 7명의 진단과 JD 적합도 분석, 개선 방향성을 받아 보세요.
      </p>
      <AuthForm
        mode="signup"
        next={next}
        googleEnabled={googleLoginConfigured()}
        passwordEnabled={passwordLoginEnabled()}
        initialError={authErrorMessage(params.error)}
      />
    </>
  );
}
