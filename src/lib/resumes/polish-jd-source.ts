import "server-only";
/**
 * 다듬기 도구 get_jd_analysis의 자료 로더(docs/RESUME-POLISH-TOOLS.md). 이 사용자·이 이력서로만 읽는다 — 모든 조회에 userId 조건,
 * 이력서는 호출자가 getVersionDocument(userId, resumeId)로 소유를 확인한 것만 넘긴다. LLM 인자는 여기 닿지 않는다(구역 이름만 렌더에 쓴다).
 *
 * 모으는 것(있는 것만):
 *   - 공고 구역: 연결된 내 보관 공고의 저장된 구조(AI·직접 편집 — 이력서 JD가 그 공고의 JD와 같을 때만), 아니면 JD 원문의 제목 기준 분류.
 *   - JD 분석: 같은 공고의 진단 JD 단계 또는 이 이력서의 이전 에이전트 작업(resume-agent/jd-source.ts — 지금 JD와 같을 때만).
 *   - JD 맞춤 작성 팁: 지금 JD로 만든 것(ready)만. stale 팁은 싣지 않는다.
 *   - 키워드 포함 여부: 팁·분석 키워드·기술 스택을 지금 이력서 본문으로 결정적으로 센다.
 *   - 요건 충족 현황: 이 이력서의 마지막 완료 에이전트 작업의 심사 리포트(작성 시점 기준) — 그 리포트가 실제 JD로 심사했고
 *     (report.jd.source === "jd") 그 작업의 r0.jd 단계 jdHash가 지금 JD와 같을 때만. JD를 바꿨거나 JD 없이 추론한 요건이면 싣지 않는다.
 */
import { prisma, Prisma } from "@/lib/db/client";
import { resumeKeywordCoverage } from "@/lib/domain/resume-jd-tips";
import type { ResumeDocument } from "@/lib/domain/resumes";
import { parseStoredStructure } from "@/lib/postings/service";
import { structureContentFromText } from "@/lib/postings/structure";
import { findReusableJdAnalysis } from "@/lib/resume-agent/jd-source";
import { jdHash, normalizeJd } from "@/lib/resume-agent/jd-hash";
import { AgentReportSchema } from "@/lib/resume-agent/schemas";
import { lookupJdTips, resolveResumeJd } from "./jd-tips";
import type { PolishJdSources } from "./polish-tools";
import type { ResumeMeta } from "./types";

const JD_MAX = 12_000;

export async function loadPolishJdSources(userId: string, resume: ResumeMeta, doc: ResumeDocument): Promise<PolishJdSources> {
  const posting = resume.postingId
    ? await prisma.jobPosting.findFirst({ where: { id: resume.postingId, userId }, select: { jdText: true, structured: true } })
    : null;
  const ownJd = (resume.jdText ?? "").trim();
  const jdText = (ownJd || (posting?.jdText ?? "").trim()).slice(0, JD_MAX);

  let structure: PolishJdSources["structure"] = null;
  const stored = posting ? parseStoredStructure(posting.structured) : null;
  // 저장된 구조는 이력서 JD가 그 공고의 JD일 때만(사용자가 이력서 JD를 따로 고쳤으면 그 JD를 제목 기준으로 나눈다).
  if (stored && (!ownJd || normalizeJd(ownJd) === normalizeJd(posting?.jdText))) {
    structure = { source: stored.source, summary: stored.summary, duties: stored.duties, requirements: stored.requirements, preferred: stored.preferred, techStack: stored.techStack };
  } else if (jdText) {
    const s = structureContentFromText(jdText);
    if (s.duties.length || s.requirements.length || s.preferred.length || s.techStack.length) {
      structure = { source: "text", summary: "", duties: s.duties, requirements: s.requirements, preferred: s.preferred, techStack: s.techStack };
    }
  }

  const reusable = jdText ? await findReusableJdAnalysis({ userId, jdText, postingId: resume.postingId, resumeId: resume.id }).catch(() => null) : null;
  const analysis: PolishJdSources["analysis"] = reusable
    ? {
        from: reusable.reusedFrom.kind,
        summary: reusable.jd.summary,
        seniority: reusable.jd.seniority,
        mustHave: reusable.jd.mustHave,
        niceToHave: reusable.jd.niceToHave,
        keywords: reusable.jd.keywords,
        responsibilities: reusable.jd.responsibilities,
        hiddenSignals: reusable.jd.hiddenSignals,
      }
    : null;

  let tips: PolishJdSources["tips"] = null;
  const resolved = await resolveResumeJd(userId, resume);
  if (resolved.ok) {
    const lookup = await lookupJdTips(userId, resume.id, resolved.hash);
    if (lookup.status === "ready" && lookup.tips) {
      const t = lookup.tips;
      tips = { summary: t.summary, sections: t.sections, keywords: t.keywords, experiences: t.experiences };
    }
  }

  const requirements = jdText ? await loadRequirements(userId, resume.id, jdText) : null;

  const seen = new Set<string>();
  const keywords = [...(tips?.keywords ?? []), ...(analysis?.keywords ?? []), ...(structure?.techStack ?? [])].filter((k) => {
    const key = k.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    company: resume.company,
    roleTitle: resume.roleTitle,
    hasJd: !!jdText,
    structure,
    analysis,
    tips,
    coverage: resumeKeywordCoverage(doc, keywords.slice(0, 40)),
    requirements,
  };
}

/**
 * 마지막 완료 에이전트 작업의 요건 충족 현황 — 지금 JD로 심사한 것만. 리포트에는 JD 원문이 없으므로 같은 작업의 r0.jd 출력 jdHash로 비교한다
 * (v1 작업·출력이 비워진 작업은 jdHash가 없어 싣지 않는다 — 다른 JD의 요건을 지금 요건처럼 보이는 것보다 없는 편이 낫다).
 */
async function loadRequirements(userId: string, resumeId: string, jdText: string): Promise<PolishJdSources["requirements"]> {
  const job = await prisma.resumeAgentJob.findFirst({
    select: { report: true, steps: { where: { key: "r0.jd", status: "done" }, select: { output: true }, take: 1 } },
    where: { userId, status: "completed", report: { not: Prisma.DbNull }, OR: [{ resumeId }, { targetResumeId: resumeId }] },
    orderBy: [{ completedAt: "desc" }, { id: "desc" }],
  });
  if (!job) return null;
  const report = AgentReportSchema.safeParse(job.report);
  if (!report.success || report.data.jd.source !== "jd") return null;
  const out = job.steps[0]?.output as { jdHash?: unknown } | null | undefined;
  if (!out || typeof out.jdHash !== "string" || out.jdHash !== jdHash(jdText)) return null;
  return report.data.requirements.map((r) => ({ text: r.text, must: r.must, status: r.status }));
}
