import Link from "next/link";

type Mode = "login" | "signup";

/**
 * Google 로그인·가입 전용(이메일·비밀번호 로그인은 없다). 처음 로그인하면 자동으로 가입된다.
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
  const googleHref = next === "/app" ? "/api/auth/google" : `/api/auth/google?next=${encodeURIComponent(next)}`;
  const switchBase = mode === "login" ? "/signup" : "/login";
  const switchHref = next === "/app" ? switchBase : `${switchBase}?next=${encodeURIComponent(next)}`;

  return (
    <div className="space-y-5">
      {error && (
        <div role="alert" className="rounded-lg border border-red-200 bg-red-50 px-3 py-2.5 text-sm text-red-700">
          {error}
        </div>
      )}
      <GoogleButton href={googleHref} enabled={googleEnabled} label={mode === "signup" ? "Google로 가입하기" : "Google로 로그인"} />
      {googleEnabled ? (
        <p className="text-center text-xs text-slate-500">
          {mode === "signup"
            ? "Google 계정으로만 가입할 수 있습니다. 별도 비밀번호는 만들지 않습니다."
            : "Google 계정으로만 로그인할 수 있습니다. 처음이면 바로 가입됩니다."}
        </p>
      ) : (
        <p className="text-center text-sm text-slate-600">
          Google 로그인이 설정되지 않아 지금은 로그인할 수 없습니다. 관리자에게 문의해 주세요.
        </p>
      )}
      <p className="text-center text-sm text-slate-600">
        {mode === "login" ? "아직 계정이 없나요?" : "이미 계정이 있나요?"}{" "}
        <Link href={switchHref} className="font-medium text-indigo-600 hover:text-indigo-700">
          {mode === "login" ? "회원가입" : "로그인"}
        </Link>
      </p>
    </div>
  );
}

function GoogleButton({ href, enabled, label }: { href: string; enabled: boolean; label: string }) {
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
      <span aria-disabled="true" className={`${className} cursor-not-allowed opacity-50`}>
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
