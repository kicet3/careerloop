"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "login" | "signup";
type FieldErrors = Partial<Record<"email" | "password" | "name", string>>;

const COPY = {
  login: {
    endpoint: "/api/auth/login",
    submit: "로그인",
    pending: "로그인 중…",
    switchText: "아직 계정이 없나요?",
    switchLabel: "회원가입",
    switchHref: "/signup",
  },
  signup: {
    endpoint: "/api/auth/signup",
    submit: "가입하고 시작하기",
    pending: "가입 중…",
    switchText: "이미 계정이 있나요?",
    switchLabel: "로그인",
    switchHref: "/login",
  },
} as const;

/** `next`는 서버 페이지에서 safeNextPath()로 검증된 값만 받는다. */
export function AuthForm({ mode, next }: { mode: Mode; next: string }) {
  const router = useRouter();
  const copy = COPY[mode];
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    const body: Record<string, string> = {
      email: String(data.get("email") ?? ""),
      password: String(data.get("password") ?? ""),
    };
    if (mode === "signup") body.name = String(data.get("name") ?? "");

    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const res = await fetch(copy.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (res.ok) {
        router.push(next);
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => null)) as { error?: string; fieldErrors?: FieldErrors } | null;
      setFieldErrors(json?.fieldErrors ?? {});
      setFormError(json?.fieldErrors ? null : (json?.error ?? "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."));
    } catch {
      setFormError("네트워크 오류가 발생했습니다. 연결을 확인해 주세요.");
    }
    setPending(false);
  }

  const switchHref = next === "/app" ? copy.switchHref : `${copy.switchHref}?next=${encodeURIComponent(next)}`;

  return (
    <form onSubmit={onSubmit} noValidate className="space-y-5">
      {formError && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {formError}
        </div>
      )}

      {mode === "signup" && (
        <Field
          name="name"
          label="이름"
          hint="선택"
          autoComplete="name"
          maxLength={50}
          error={fieldErrors.name}
        />
      )}
      <Field name="email" label="이메일" type="email" autoComplete="email" required error={fieldErrors.email} />
      <Field
        name="password"
        label="비밀번호"
        type="password"
        autoComplete={mode === "login" ? "current-password" : "new-password"}
        required
        minLength={mode === "signup" ? 8 : undefined}
        maxLength={128}
        description={mode === "signup" ? "8자 이상 128자 이하" : undefined}
        error={fieldErrors.password}
      />

      <button
        type="submit"
        disabled={pending}
        className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
      >
        {pending ? copy.pending : copy.submit}
      </button>

      <p className="text-center text-sm text-slate-600">
        {copy.switchText}{" "}
        <Link href={switchHref} className="font-medium text-indigo-600 hover:text-indigo-700">
          {copy.switchLabel}
        </Link>
      </p>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  description,
  error,
  ...input
}: {
  name: string;
  label: string;
  hint?: string;
  description?: string;
  error?: string;
} & Omit<React.InputHTMLAttributes<HTMLInputElement>, "name">) {
  const id = `field-${name}`;
  const describedBy = error ? `${id}-error` : description ? `${id}-desc` : undefined;
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-slate-800">
        {label}
        {hint && <span className="text-xs font-normal text-slate-400">{hint}</span>}
      </label>
      <input
        id={id}
        name={name}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={`block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-xs placeholder:text-slate-400 focus:outline-none focus:ring-2 ${
          error
            ? "border-red-400 focus:border-red-500 focus:ring-red-100"
            : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-100"
        }`}
        {...input}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : description ? (
        <p id={`${id}-desc`} className="mt-1.5 text-xs text-slate-500">
          {description}
        </p>
      ) : null}
    </div>
  );
}
