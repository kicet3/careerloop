/**
 * 재작성 이력서용 작은 Markdown 렌더러. HTML을 주입하지 않고 React 요소로만 만든다(dangerouslySetInnerHTML 금지).
 * 지원: 제목(#), 목록(-, *, +, 1.), 인용(>), 구분선(---), 문단(줄바꿈 유지), **굵게**, `코드`, [링크](http..), [ADD: ...] 강조.
 */
import type { ReactNode } from "react";

type Block =
  | { kind: "heading"; level: number; text: string }
  | { kind: "list"; ordered: boolean; items: { depth: number; text: string }[] }
  | { kind: "quote"; lines: string[] }
  | { kind: "hr" }
  | { kind: "para"; lines: string[] };

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
const LIST = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/;
const QUOTE = /^\s*>\s?(.*)$/;
const HR = /^\s*([-*_])(\s*\1){2,}\s*$/;

export function parseMarkdownBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  let para: string[] | null = null;
  const flush = () => {
    if (para?.length) blocks.push({ kind: "para", lines: para });
    para = null;
  };
  for (const raw of src.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    if (!line.trim()) {
      flush();
      continue;
    }
    if (HR.test(line)) {
      flush();
      blocks.push({ kind: "hr" });
      continue;
    }
    const h = HEADING.exec(line);
    if (h) {
      flush();
      blocks.push({ kind: "heading", level: h[1].length, text: h[2] });
      continue;
    }
    const l = LIST.exec(line);
    if (l) {
      flush();
      const ordered = /\d/.test(l[2]);
      const item = { depth: Math.min(3, Math.floor(l[1].length / 2)), text: l[3] };
      const last = blocks[blocks.length - 1];
      if (last?.kind === "list") last.items.push(item);
      else blocks.push({ kind: "list", ordered, items: [item] });
      continue;
    }
    const q = QUOTE.exec(line);
    if (q) {
      flush();
      const last = blocks[blocks.length - 1];
      if (last?.kind === "quote") last.lines.push(q[1]);
      else blocks.push({ kind: "quote", lines: [q[1]] });
      continue;
    }
    // 목록 바로 아래 들여쓴 줄은 직전 항목의 연속으로 본다.
    const last = blocks[blocks.length - 1];
    if (!para && last?.kind === "list" && /^\s{2,}/.test(line)) {
      last.items[last.items.length - 1].text += " " + line.trim();
      continue;
    }
    (para ??= []).push(line.trim());
  }
  flush();
  return blocks;
}

const INLINE = /(\[ADD:[^\]]*\]|\*\*[^*]+\*\*|__[^_]+__|`[^`]+`|\[[^\]]+\]\([^)\s]+\))/g;

export function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const tok = m[0];
    const key = `${keyPrefix}-${n++}`;
    if (tok.startsWith("[ADD:")) {
      out.push(<AddPlaceholder key={key} text={tok.slice(5, -1).trim()} />);
    } else if (tok.startsWith("**") || tok.startsWith("__")) {
      out.push(
        <strong key={key} className="font-semibold text-slate-900">
          {renderInline(tok.slice(2, -2), key)}
        </strong>,
      );
    } else if (tok.startsWith("`")) {
      out.push(
        <code key={key} className="rounded bg-slate-100 px-1 py-0.5 font-mono text-[0.9em]">
          {tok.slice(1, -1)}
        </code>,
      );
    } else {
      const lm = /^\[([^\]]+)\]\(([^)\s]+)\)$/.exec(tok);
      const label = lm?.[1] ?? tok;
      const href = lm?.[2] ?? "";
      out.push(
        /^https?:\/\//i.test(href) ? (
          <a key={key} href={href} rel="noopener noreferrer nofollow" target="_blank" className="text-indigo-700 underline underline-offset-2">
            {label}
          </a>
        ) : (
          <span key={key}>{label}</span>
        ),
      );
    }
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function AddPlaceholder({ text }: { text: string }) {
  return (
    <mark
      title="사실 확인이 필요한 자리입니다. 직접 채워 넣으세요."
      className="rounded bg-amber-100 px-1 py-0.5 font-medium text-amber-900 ring-1 ring-inset ring-amber-300 print:bg-transparent print:ring-amber-500"
    >
      [ADD: {text}]
    </mark>
  );
}

const HEADING_CLASS: Record<number, string> = {
  1: "text-xl font-bold tracking-tight text-slate-900",
  2: "mt-6 border-b border-slate-200 pb-1 text-sm font-bold uppercase tracking-wide text-indigo-700",
  3: "mt-4 text-base font-semibold text-slate-900",
};

export function MiniMarkdown({ source, className }: { source: string; className?: string }) {
  const blocks = parseMarkdownBlocks(source);
  return (
    <div className={className}>
      {blocks.map((b, i) => {
        const k = `b${i}`;
        switch (b.kind) {
          case "heading": {
            const cls = HEADING_CLASS[Math.min(b.level, 3)] + (i === 0 ? "" : b.level === 1 ? " mt-6" : "");
            const content = renderInline(b.text, k);
            if (b.level === 1) return <h3 key={k} className={cls}>{content}</h3>;
            if (b.level === 2) return <h4 key={k} className={cls}>{content}</h4>;
            return <h5 key={k} className={cls}>{content}</h5>;
          }
          case "list": {
            const items = b.items.map((it, j) => (
              <li key={j} style={it.depth ? { marginLeft: `${it.depth * 1.25}rem` } : undefined} className="pl-1">
                {renderInline(it.text, `${k}-${j}`)}
              </li>
            ));
            return b.ordered ? (
              <ol key={k} className="mt-2 list-decimal space-y-1 pl-5 text-sm leading-relaxed text-slate-700 marker:text-slate-400">
                {items}
              </ol>
            ) : (
              <ul key={k} className="mt-2 list-disc space-y-1 pl-5 text-sm leading-relaxed text-slate-700 marker:text-slate-400">
                {items}
              </ul>
            );
          }
          case "quote":
            return (
              <blockquote key={k} className="mt-2 border-l-[3px] border-slate-300 pl-3 text-sm text-slate-600">
                {b.lines.map((ln, j) => (
                  <p key={j}>{renderInline(ln, `${k}-${j}`)}</p>
                ))}
              </blockquote>
            );
          case "hr":
            return <hr key={k} className="my-4 border-slate-200" />;
          case "para":
            return (
              <p key={k} className="mt-2 text-sm leading-relaxed text-slate-700">
                {b.lines.map((ln, j) => (
                  <span key={j}>
                    {j > 0 && <br />}
                    {renderInline(ln, `${k}-${j}`)}
                  </span>
                ))}
              </p>
            );
        }
      })}
    </div>
  );
}
