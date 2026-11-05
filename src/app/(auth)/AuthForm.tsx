"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";

type Mode = "login" | "signup";
type FieldErrors = Partial<Record<"email" | "password", string>>;

/**
 * 가입은 Google로만(처음 Google 로그인하면 자동 가입). 로그인은 Google 또는 이메일·비밀번호
 * (Google로 가입한 뒤 계정 설정에서 비밀번호를 정한 사용자).
 * `next`는 서버 페이지에서 safeNextPath()로 검증된 값만 받는다. `googleEnabled`·`error`도 서버 페이지가 정한다.
 */
export function AuthForm({
  mode,
  next,
  googleEnabled,
  error = null,
}: {
  mode: Mode;
  next: string;
  googleEnabled: boolean;
  error?: string | null;
}) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [formError, setFormError] = useState<string | null>(error);
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});

  const googleHref =
    next === "/app"
      ? "/api/auth/google"
      : `/api/auth/google?next=${encodeURIComponent(next)}`;
  const switchBase = mode === "login" ? "/signup" : "/login";
  const switchHref =
    next === "/app"
      ? switchBase
      : `${switchBase}?next=${encodeURIComponent(next)}`;

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const data = new FormData(e.currentTarget);
    setPending(true);
    setFormError(null);
    setFieldErrors({});
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: String(data.get("email") ?? ""),
          password: String(data.get("password") ?? ""),
        }),
      });
      if (res.ok) {
        router.push(next);
        router.refresh();
        return;
      }
      const json = (await res.json().catch(() => null)) as {
        error?: string;
        fieldErrors?: FieldErrors;
      } | null;
      setFieldErrors(json?.fieldErrors ?? {});
      setFormError(
        json?.fieldErrors
          ? null
          : (json?.error ??
              "요청을 처리하지 못했습니다. 잠시 후 다시 시도해 주세요."),
      );
    } catch {
      setFormError("네트워크 오류가 발생했습니다. 연결을 확인해 주세요.");
    }
    setPending(false);
  }

  return (
    <div className="space-y-5">
      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
        >
          {formError}
        </div>
      )}
      <GoogleButton
        href={googleHref}
        enabled={googleEnabled}
        label={mode === "signup" ? "Google로 가입하기" : "Google로 로그인"}
      />
      {mode === "signup" ? (
        <p className="text-center text-xs text-slate-500">
          {googleEnabled
            ? "회원가입은 Google 계정으로만 할 수 있습니다. 가입 후 계정 설정에서 비밀번호를 정하면 이메일로도 로그인할 수 있습니다."
            : "Google 로그인이 설정되지 않아 지금은 가입할 수 없습니다. 관리자에게 문의해 주세요."}
        </p>
      ) : (
        <>
          {!googleEnabled && (
            <p className="-mt-3 text-center text-xs text-slate-500">
              Google 로그인이 설정되지 않았습니다.
            </p>
          )}
          <div
            className="flex items-center gap-3 text-xs text-slate-400"
            aria-hidden="true"
          >
            <span className="h-px flex-1 bg-slate-200" />
            또는 이메일로
            <span className="h-px flex-1 bg-slate-200" />
          </div>
          <form onSubmit={onSubmit} noValidate className="space-y-4">
            <Field
              name="email"
              label="이메일"
              type="email"
              autoComplete="email"
              required
              error={fieldErrors.email}
            />
            <Field
              name="password"
              label="비밀번호"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
              error={fieldErrors.password}
            />
            <button
              type="submit"
              disabled={pending}
              className="w-full rounded-lg bg-indigo-600 px-4 py-2.5 text-sm font-semibold text-white shadow-sm transition hover:bg-indigo-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {pending ? "로그인 중…" : "이메일로 로그인"}
            </button>
            <p className="text-center text-xs text-slate-500">
              이메일 로그인은 Google로 가입한 뒤 계정 설정에서 비밀번호를 정한
              경우에 쓸 수 있습니다.
            </p>
          </form>
        </>
      )}
      <p className="text-center text-sm text-slate-600">
        {mode === "login" ? "아직 계정이 없나요?" : "이미 계정이 있나요?"}{" "}
        <Link
          href={switchHref}
          className="font-medium text-indigo-600 hover:text-indigo-700"
        >
          {mode === "login" ? "Google로 회원가입" : "로그인"}
        </Link>
      </p>
    </div>
  );
}

function GoogleButton({
  href,
  enabled,
  label,
}: {
  href: string;
  enabled: boolean;
  label: string;
}) {
  const className =
    "flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm transition";
  const content = (
    <>
      <GoogleMark />
      {label}
    </>
  );
  if (!enabled) {
    return (
      <span
        aria-disabled="true"
        className={`${className} cursor-not-allowed opacity-50`}
      >
        {content}
      </span>
    );
  }
  // API 라우트(서버 리다이렉트)라 <Link>가 아닌 일반 링크로 이동한다.
  return (
    <a
      href={href}
      className={`${className} hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600`}
    >
      {content}
    </a>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 48 48" className="size-5" aria-hidden="true">
      <path
        fill="#FFC107"
        d="M43.6 20.5H42V20H24v8h11.3C33.7 32.7 29.3 36 24 36c-6.6 0-12-5.4-12-12s5.4-12 12-12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 12.9 4 4 12.9 4 24s8.9 20 20 20 20-8.9 20-20c0-1.3-.1-2.4-.4-3.5z"
      />
      <path
        fill="#FF3D00"
        d="m6.3 14.7 6.6 4.8C14.7 15.1 19 12 24 12c3.1 0 5.8 1.2 7.9 3.1l5.7-5.7C34 6.1 29.3 4 24 4 16.3 4 9.7 8.3 6.3 14.7z"
      />
      <path
        fill="#4CAF50"
        d="M24 44c5.2 0 9.9-2 13.4-5.2l-6.2-5.2C29.2 35.1 26.7 36 24 36c-5.3 0-9.6-3.3-11.3-8l-6.5 5C9.5 39.6 16.2 44 24 44z"
      />
      <path
        fill="#1976D2"
        d="M43.6 20.5H42V20H24v8h11.3c-.8 2.2-2.2 4.2-4.1 5.6l6.2 5.2C37 39.2 44 34 44 24c0-1.3-.1-2.4-.4-3.5z"
      />
    </svg>
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
  const describedBy = error
    ? `${id}-error`
    : description
      ? `${id}-desc`
      : undefined;
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 flex items-baseline justify-between text-sm font-medium text-slate-800"
      >
        {label}
        {hint && (
          <span className="text-xs font-normal text-slate-400">{hint}</span>
        )}
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
