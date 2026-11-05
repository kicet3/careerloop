/** 법적 문서(약관·처리방침) 조판용 작은 부품. 표시 전용. */
import type { ReactNode } from "react";

export function DocTitle({ title, effective, children }: { title: string; effective: string; children?: ReactNode }) {
  return (
    <header className="mb-8 border-b border-slate-100 pb-6">
      <h1 className="text-2xl font-bold tracking-tight text-slate-900">{title}</h1>
      <p className="mt-2 text-sm text-slate-500">시행일: {effective}</p>
      {children && <div className="mt-4 text-sm leading-relaxed text-slate-700">{children}</div>}
    </header>
  );
}

export function Toc({ items }: { items: { id: string; title: string }[] }) {
  return (
    <nav aria-label="목차" className="mb-8 rounded-lg bg-slate-50 px-4 py-3">
      <p className="mb-2 text-xs font-semibold text-slate-500">목차</p>
      <ol className="grid gap-1 text-sm sm:grid-cols-2">
        {items.map((it) => (
          <li key={it.id}>
            <a href={`#${it.id}`} className="text-indigo-700 hover:underline">
              {it.title}
            </a>
          </li>
        ))}
      </ol>
    </nav>
  );
}

export function Section({ id, title, children }: { id: string; title: string; children: ReactNode }) {
  return (
    <section id={id} className="mb-8 scroll-mt-6">
      <h2 className="mb-3 text-lg font-semibold text-slate-900">{title}</h2>
      <div className="space-y-3 text-sm leading-relaxed text-slate-700 [&_li]:mt-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ul]:list-disc [&_ul]:pl-5">
        {children}
      </div>
    </section>
  );
}

/** 사업자가 확인해 채워야 하는 값 표시(눈에 띄게). */
export function Placeholder({ children }: { children: ReactNode }) {
  return <mark className="rounded bg-amber-100 px-1 font-semibold text-amber-900">{children}</mark>;
}
