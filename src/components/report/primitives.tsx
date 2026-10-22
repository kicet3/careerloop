/** 보고서 공용 표현 조각. 훅 없음(서버 컴포넌트에서 사용 가능). */
import type { ReactNode } from "react";
import type { VerdictTone } from "@/lib/domain/reviewers";
import type { CheckedQuote, VerdictView } from "@/lib/report/types";

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(" ");
}

export const TONE_BADGE: Record<VerdictTone, string> = {
  positive: "bg-emerald-50 text-emerald-700 ring-emerald-600/20",
  neutral: "bg-amber-50 text-amber-800 ring-amber-600/20",
  negative: "bg-rose-50 text-rose-700 ring-rose-600/20",
};

export const TONE_DOT: Record<VerdictTone, string> = {
  positive: "bg-emerald-500",
  neutral: "bg-amber-500",
  negative: "bg-rose-500",
};

export const TONE_TEXT: Record<VerdictTone, string> = {
  positive: "text-emerald-700",
  neutral: "text-amber-700",
  negative: "text-rose-700",
};

export function Pill({ tone, children, className }: { tone: VerdictTone | "accent" | "muted"; children: ReactNode; className?: string }) {
  const toneClass =
    tone === "accent"
      ? "bg-indigo-50 text-indigo-700 ring-indigo-600/20"
      : tone === "muted"
        ? "bg-slate-100 text-slate-600 ring-slate-500/15"
        : TONE_BADGE[tone];
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1 whitespace-nowrap rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset",
        toneClass,
        className,
      )}
    >
      {children}
    </span>
  );
}

export function VerdictBadge({ verdict, size = "sm" }: { verdict: VerdictView; size?: "sm" | "md" }) {
  return (
    <span
      className={cx(
        "inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap rounded-full font-semibold ring-1 ring-inset",
        size === "md" ? "px-3 py-1 text-sm" : "px-2.5 py-0.5 text-xs",
        TONE_BADGE[verdict.tone],
      )}
    >
      <span aria-hidden className={cx("h-1.5 w-1.5 rounded-full", TONE_DOT[verdict.tone])} />
      {verdict.label}
    </span>
  );
}

export function Chip({ children, tone = "default" }: { children: ReactNode; tone?: "default" | "positive" | "negative" }) {
  const cls =
    tone === "positive"
      ? "border-emerald-200 bg-emerald-50 text-emerald-800"
      : tone === "negative"
        ? "border-rose-200 bg-rose-50 text-rose-800 line-through decoration-rose-300"
        : "border-slate-200 bg-white text-slate-700";
  return <span className={cx("inline-block rounded-md border px-2 py-0.5 text-xs font-medium", cls)}>{children}</span>;
}

export function UnverifiedMark() {
  return (
    <span
      title="이 인용을 이력서 원문에서 찾지 못했습니다. 모델이 문장을 바꿔 옮겼을 수 있습니다."
      className="ml-2 inline-flex items-center rounded bg-amber-100 px-1.5 py-0.5 align-middle text-[11px] font-semibold text-amber-800 not-italic"
    >
      원문에서 찾지 못함
    </span>
  );
}

/** 이력서 원문 인용 블록. */
export function QuoteBlock({ quote, className }: { quote: CheckedQuote; className?: string }) {
  return (
    <blockquote
      className={cx(
        "border-l-[3px] bg-slate-50 px-3.5 py-2 text-sm leading-relaxed text-slate-800",
        quote.verified ? "border-slate-300" : "border-amber-400",
        className,
      )}
    >
      <span className="break-words">“{quote.text}”</span>
      {!quote.verified && <UnverifiedMark />}
    </blockquote>
  );
}

export function Section({
  id,
  number,
  title,
  description,
  children,
}: {
  id: string;
  number: number;
  title: string;
  description?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section id={id} aria-labelledby={`${id}-title`} className="scroll-mt-24 border-t border-slate-200 pt-10 print:pt-6">
      <header className="mb-6 break-after-avoid">
        <p className="text-xs font-semibold tracking-widest text-indigo-600">{String(number).padStart(2, "0")}</p>
        <h2 id={`${id}-title`} className="mt-1 text-xl font-bold tracking-tight text-slate-900 sm:text-2xl">
          {title}
        </h2>
        {description && <p className="mt-2 max-w-2xl text-sm leading-relaxed text-slate-500">{description}</p>}
      </header>
      {children}
    </section>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div className={cx("break-inside-avoid rounded-xl border border-slate-200 bg-white p-5 shadow-sm print:shadow-none", className)}>
      {children}
    </div>
  );
}

export function SubHeading({ children }: { children: ReactNode }) {
  return <h3 className="mb-3 text-sm font-semibold text-slate-900">{children}</h3>;
}

export function EmptyState({ children }: { children: ReactNode }) {
  return (
    <p className="rounded-xl border border-dashed border-slate-300 bg-slate-50 px-5 py-8 text-center text-sm text-slate-500">
      {children}
    </p>
  );
}

export function BulletList({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cx("space-y-1.5 text-sm leading-relaxed text-slate-700", className)}>
      {items.map((x, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden className="mt-2 h-1 w-1 shrink-0 rounded-full bg-slate-400" />
          <span>{x}</span>
        </li>
      ))}
    </ul>
  );
}
