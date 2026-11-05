"use client";

import { useState } from "react";
import { Button } from "@/components/ui";

type FieldErrors = Partial<
  Record<"currentPassword" | "newPassword" | "confirm", string>
>;

const inputClass = (error?: string) =>
  `block w-full rounded-lg border bg-white px-3 py-2 text-sm text-slate-900 shadow-xs focus:outline-none focus:ring-2 ${
    error
      ? "border-red-400 focus:border-red-500 focus:ring-red-100"
      : "border-slate-300 focus:border-indigo-500 focus:ring-indigo-100"
  }`;

/** 이메일 로그인용 비밀번호 설정·변경. hasPassword면 현재 비밀번호를 함께 받는다. */
export function PasswordForm({
  hasPassword: initialHasPassword,
}: {
  hasPassword: boolean;
}) {
  const [hasPassword, setHasPassword] = useState(initialHasPassword);
  const [pending, setPending] = useState(false);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (pending) return;
    const form = e.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get("currentPassword") ?? "");
    const newPassword = String(data.get("newPassword") ?? "");
    const confirm = String(data.get("confirm") ?? "");
    setErrors({});
    setFormError(null);
    setDone(null);
    if (newPassword !== confirm) {
      setErrors({ confirm: "새 비밀번호가 서로 다릅니다." });
      return;
    }
    setPending(true);
    try {
      const res = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          hasPassword ? { currentPassword, newPassword } : { newPassword },
        ),
      });
      const json = (await res.json().catch(() => null)) as {
        ok?: boolean;
        created?: boolean;
        error?: string;
        fieldErrors?: FieldErrors;
      } | null;
      if (res.ok) {
        form.reset();
        setDone(
          json?.created
            ? "비밀번호를 설정했습니다. 이제 이메일과 비밀번호로도 로그인할 수 있습니다."
            : "비밀번호를 변경했습니다. 다른 기기의 로그인은 모두 해제되었습니다.",
        );
        setHasPassword(true);
      } else {
        setErrors(json?.fieldErrors ?? {});
        setFormError(
          json?.fieldErrors
            ? null
            : (json?.error ?? "요청을 처리하지 못했습니다."),
        );
      }
    } catch {
      setFormError("네트워크 오류가 발생했습니다. 연결을 확인해 주세요.");
    }
    setPending(false);
  }

  return (
    <form onSubmit={onSubmit} noValidate className="max-w-sm space-y-4">
      {formError && (
        <div
          role="alert"
          className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700"
        >
          {formError}
        </div>
      )}
      {done && (
        <div
          role="status"
          className="rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2.5 text-sm text-emerald-700"
        >
          {done}
        </div>
      )}
      {hasPassword && (
        <Field
          name="currentPassword"
          label="현재 비밀번호"
          autoComplete="current-password"
          error={errors.currentPassword}
        />
      )}
      <Field
        name="newPassword"
        label={hasPassword ? "새 비밀번호" : "비밀번호"}
        autoComplete="new-password"
        hint="8자 이상 128자 이하"
        error={errors.newPassword}
      />
      <Field
        name="confirm"
        label="비밀번호 확인"
        autoComplete="new-password"
        error={errors.confirm}
      />
      <Button type="submit" loading={pending}>
        {hasPassword ? "비밀번호 변경" : "비밀번호 설정"}
      </Button>
    </form>
  );
}

function Field({
  name,
  label,
  hint,
  error,
  autoComplete,
}: {
  name: string;
  label: string;
  hint?: string;
  error?: string;
  autoComplete: string;
}) {
  const id = `pw-${name}`;
  return (
    <div>
      <label
        htmlFor={id}
        className="mb-1.5 block text-sm font-medium text-slate-800"
      >
        {label}
      </label>
      <input
        id={id}
        name={name}
        type="password"
        autoComplete={autoComplete}
        required
        maxLength={128}
        aria-invalid={error ? true : undefined}
        aria-describedby={
          error ? `${id}-error` : hint ? `${id}-hint` : undefined
        }
        className={inputClass(error)}
      />
      {error ? (
        <p id={`${id}-error`} className="mt-1.5 text-xs text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1.5 text-xs text-slate-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}
