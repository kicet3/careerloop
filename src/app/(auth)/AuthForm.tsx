"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import { ConsentChecklist } from "@/components/legal/ConsentChecklist";
import { EMPTY_CONSENT_CHECKS, requiredConsentsChecked, type ConsentChecks } from "@/lib/legal/consents";

type Mode = "login" | "signup";

/**
 * 가입은 Google로만. 가입 화면은 동의 목록(필수 체크 전에는 버튼 비활성)을 폼으로 POST /api/auth/google에 보내고,
 * 서버가 동의를 서명 쿠키에 담아 Google로 보낸다(콜백이 동의 기록을 남긴다). 로그인 화면의 Google 버튼은 GET 링크 —
 * 동의 기록이 없는 새 사용자는 로그인 뒤 /consent 화면을 거친다. 로그인도 Google로만 한다(이메일·비밀번호 로그인 없음).
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
  const formError = error;
  const [consents, setConsents] = useState<ConsentChecks>(EMPTY_CONSENT_CHECKS);
  const [redirecting, setRedirecting] = useState(false);
  // Google 화면에서 뒤로 오면(bfcache 복원) '이동 중' 상태를 풀어 다시 누를 수 있게 한다.
  useEffect(() => {
    const onShow = (e: PageTransitionEvent) => {
      if (e.persisted) setRedirecting(false);
    };
    window.addEventListener("pageshow", onShow);
    return () => window.removeEventListener("pageshow", onShow);
  }, []);

  const googleHref =
    next === "/app"
      ? "/api/auth/google"
      : `/api/auth/google?next=${encodeURIComponent(next)}`;
  const switchBase = mode === "login" ? "/signup" : "/login";
  const switchHref =
    next === "/app"
      ? switchBase
      : `${switchBase}?next=${encodeURIComponent(next)}`;

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
      {mode === "signup" ? (
        <form
          method="post"
          action="/api/auth/google"
          className="space-y-4"
          onSubmit={(e) => {
            if (!googleEnabled || !requiredConsentsChecked(consents) || redirecting) {
              e.preventDefault();
              return;
            }
            setRedirecting(true);
          }}
        >
          <input type="hidden" name="next" value={next} />
          <ConsentChecklist checks={consents} onChange={setConsents} />
          <GoogleSubmitButton
            enabled={googleEnabled && requiredConsentsChecked(consents)}
            pending={redirecting}
            label="Google로 가입하기"
          />
          <p className="text-center text-xs text-slate-500">
            {!googleEnabled
              ? "Google 로그인이 설정되지 않아 지금은 가입할 수 없습니다. 관리자에게 문의해 주세요."
              : requiredConsentsChecked(consents)
                ? "가입하면 관리자 승인 후 이용할 수 있습니다."
                : "필수 항목을 모두 체크하면 Google로 가입할 수 있습니다."}
          </p>
        </form>
      ) : (
        <>
          <GoogleButton href={googleHref} enabled={googleEnabled} label="Google로 로그인" />
          {!googleEnabled && (
            <p className="text-center text-xs text-slate-500">
              Google 로그인이 설정되지 않았습니다.
            </p>
          )}
          <p className="text-center text-xs text-slate-500">CareerLoop는 Google 계정으로만 로그인할 수 있습니다.</p>
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

/** 가입 폼 제출 버튼(필수 동의 전에는 비활성). */
function GoogleSubmitButton({ enabled, pending, label }: { enabled: boolean; pending: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={!enabled || pending}
      aria-busy={pending || undefined}
      className="flex w-full items-center justify-center gap-2.5 rounded-lg border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 shadow-sm transition hover:bg-slate-50 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-indigo-600 disabled:cursor-not-allowed disabled:opacity-50"
    >
      <GoogleMark />
      {pending ? "Google로 이동 중…" : label}
    </button>
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
