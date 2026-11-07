import { wordDiff } from "./diff";

/** 다듬기 제안의 전/후 낱말 차이(지운 조각·더한 조각 강조). */
export function DiffView({ before, after }: { before: string; after: string }) {
  const parts = wordDiff(before, after);
  return (
    <div className="grid gap-2 text-sm">
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 whitespace-pre-wrap">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">전</span>
        {parts
          .filter((p) => p.kind !== "add")
          .map((p, i) => (p.kind === "del" ? <del key={i} className="bg-rose-100 text-rose-800">{p.text}</del> : <span key={i}>{p.text}</span>))}
      </div>
      <div className="rounded-md border border-slate-200 bg-white px-3 py-2 whitespace-pre-wrap">
        <span className="mb-1 block text-[11px] font-medium text-slate-500">후</span>
        {parts
          .filter((p) => p.kind !== "del")
          .map((p, i) => (p.kind === "add" ? <ins key={i} className="bg-emerald-100 text-emerald-800 no-underline">{p.text}</ins> : <span key={i}>{p.text}</span>))}
      </div>
    </div>
  );
}
