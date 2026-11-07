/**
 * JD 분석 → 요건별 검색 질의 묶음(순수). 필수·우대 요건(R…)은 모두, 요건에 안 묶인 키워드(K…)·주요 업무(T…)는 남는 만큼.
 */
import type { JdAnalysis } from "@/lib/domain/schemas";
import { extractKeywords, skillKey } from "@/lib/skills/dictionary";
import type { RequirementSignal } from "./schemas";

export const MAX_SIGNALS = 40;

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n) : s);

/** JD 분석 → 검색 질의 묶음(필수·우대 요건, 요건에 안 묶인 키워드, 주요 업무). 최대 MAX_SIGNALS개. */
export function requirementSignals(jd: JdAnalysis): RequirementSignal[] {
  const out: RequirementSignal[] = [];
  const covered = new Set<string>();
  const kwFor = (text: string) => jd.keywords.filter((k) => k.trim() && text.toLowerCase().includes(k.trim().toLowerCase()));
  const req = (r: JdAnalysis["mustHave"][number], kind: "must" | "nice") => {
    const base = `${r.text} ${r.jdQuote ?? ""}`;
    const kws = kwFor(base);
    const skills = [...new Set(extractKeywords(r.text, r.jdQuote ?? "").map(skillKey))];
    for (const k of kws) covered.add(skillKey(k));
    for (const s of skills) covered.add(s);
    out.push({ id: r.id, kind, text: r.text, query: clip([r.text, r.jdQuote ?? "", ...kws].join(" ").trim(), 400), skills, category: r.category });
  };
  jd.mustHave.forEach((r) => req(r, "must"));
  jd.niceToHave.forEach((r) => req(r, "nice"));
  let k = 0;
  for (const kw of jd.keywords) {
    const key = skillKey(kw);
    if (!kw.trim() || covered.has(key)) continue;
    covered.add(key);
    out.push({ id: `K${++k}`, kind: "keyword", text: kw.trim(), query: kw.trim(), skills: [key] });
  }
  jd.responsibilities.forEach((t, i) => {
    if (t.trim()) out.push({ id: `T${i + 1}`, kind: "responsibility", text: t.trim(), query: clip(t.trim(), 300), skills: extractKeywords(t).map(skillKey) });
  });
  // 필수·우대는 모두 남기고 키워드·업무를 자른다.
  const reqs = out.filter((s) => s.kind === "must" || s.kind === "nice");
  const rest = out.filter((s) => s.kind !== "must" && s.kind !== "nice");
  return [...reqs, ...rest].slice(0, Math.max(MAX_SIGNALS, reqs.length));
}

