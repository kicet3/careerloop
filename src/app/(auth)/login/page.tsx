import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/session";
import { safeNextPath } from "@/lib/auth/validation";
import { AuthForm } from "../AuthForm";

export const metadata: Metadata = { title: "로그인 · 이력서 심사위원단" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const next = safeNextPath((await searchParams).next);
  if (await getCurrentUser()) redirect(next);

  return (
    <>
      <h1 className="text-xl font-semibold tracking-tight text-slate-900">로그인</h1>
      <p className="mt-1 mb-6 text-sm text-slate-600">진단 이력과 보고서를 이어서 확인하세요.</p>
      <AuthForm mode="login" next={next} />
    </>
  );
}
