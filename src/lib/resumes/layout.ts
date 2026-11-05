/**
 * 양식별 섹션 배치와 텍스트 변환(순수 함수, 웹 미리보기·PDF·진단 프리필 공용).
 * 빈 섹션은 빼고, 사이드바 양식이면 기술·학력·자격을 옆 열로 보낸다.
 */
import {
  RESUME_SECTION_LABELS,
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeExperience,
  type ResumeHeadingKey,
  type ResumeProject,
  type ResumeSectionKey,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";

/** 사이드바 양식에서 옆 열로 가는 섹션. */
export const SIDEBAR_SECTIONS: readonly ResumeSectionKey[] = ["skills", "education", "certifications"];

const blank = (s: string) => s.trim().length === 0;

export const isExperienceEmpty = (e: ResumeExperience) =>
  blank(e.company) && blank(e.title) && blank(e.department) && blank(e.scope) && e.bullets.every(blank);

export const isProjectEmpty = (p: ResumeProject) =>
  [p.name, p.summary, p.problem, p.action, p.result, p.evidence, p.team, p.company].every(blank) && p.bullets.every(blank);

export function isSectionEmpty(doc: ResumeDocument, key: ResumeSectionKey): boolean {
  switch (key) {
    case "summary":
      return blank(doc.summary);
    case "highlights":
      return doc.highlights.every((h) => blank(h.title) && blank(h.context));
    case "experience":
      return doc.experience.every((e) => isExperienceEmpty(e));
    case "projects":
      return doc.projects.every((p) => isProjectEmpty(p));
    case "skills":
      return doc.skills.every((s) => blank(s.category) && blank(s.detail) && s.items.every(blank));
    case "education":
      return doc.education.every((e) => blank(e.school) && blank(e.major));
    case "certifications":
      return doc.certifications.every((c) => blank(c.name));
    case "extras":
      return doc.extras.every((x) => blank(x.title) && x.items.every(blank));
  }
}

export interface ResumeLayout {
  main: ResumeSectionKey[];
  side: ResumeSectionKey[];
}

/** 다른 양식에도 그대로 옮겨 쓰는 바꾼 제목(예: '경력' → '관련 경험'). 역량·학력 제목은 성과 양식 전용 묶음이라 옮기지 않는다. */
const SHARED_HEADINGS: readonly ResumeSectionKey[] = ["highlights", "experience", "projects"];

/** 섹션 제목: 문서에서 바꾼 제목(성과 중심 양식에서 편집)이 있으면 그것, 없으면 기본 제목. */
export function sectionTitle(doc: ResumeDocument, key: ResumeSectionKey): string {
  const custom = SHARED_HEADINGS.includes(key) ? doc.headings[key as ResumeHeadingKey].trim() : "";
  return custom || RESUME_SECTION_LABELS[key];
}

/** 성과 중심 양식의 기본 섹션 제목(학력과 자격을 한 섹션으로 묶고, 기술은 '직무 역량'). */
export const PERFORMANCE_HEADINGS: Record<ResumeHeadingKey, string> = {
  highlights: "핵심 성과",
  experience: "경력",
  projects: "대표 프로젝트",
  skills: "직무 역량",
  education: "학력·자격",
};

export function performanceHeading(doc: ResumeDocument, key: ResumeHeadingKey): string {
  return doc.headings[key].trim() || PERFORMANCE_HEADINGS[key];
}

/** 양식 순서대로 내용이 있는 섹션만. 사이드바 양식이 아니면 side는 빈 배열. */
export function resumeLayout(doc: ResumeDocument, templateId: ResumeTemplateId): ResumeLayout {
  const t = RESUME_TEMPLATES[templateId];
  const keys = t.sectionOrder.filter((k) => !isSectionEmpty(doc, k));
  if (t.style.layout !== "sidebar") return { main: keys, side: [] };
  return { main: keys.filter((k) => !SIDEBAR_SECTIONS.includes(k)), side: keys.filter((k) => SIDEBAR_SECTIONS.includes(k)) };
}

/** 프로젝트의 문제·행동·결과를 다른 양식(웹·PDF)에서는 "문제: …" 불릿으로 보인다. */
export function projectStoryLines(p: ResumeProject): string[] {
  return (
    [
      ["문제", p.problem],
      ["행동", p.action],
      ["결과", p.result],
    ] as const
  )
    .filter(([, v]) => v.trim())
    .map(([k, v]) => `${k}: ${v.trim()}`);
}

/** "2021.03 – 현재" 형식. 둘 다 비면 "". */
export function period(start: string, end: string): string {
  const a = start.trim();
  const b = end.trim();
  if (!a && !b) return "";
  if (!b) return a;
  if (!a) return b;
  return `${a} – ${b}`;
}

const ADD_RE = /(\[ADD:[^\]]*\])/;

/** `[ADD: ...]` 자리표시를 표시용으로 나눈다(홀수 번째가 자리표시). */
export function splitAddMarkers(text: string): { text: string; add: boolean }[] {
  return text
    .split(ADD_RE)
    .filter((p) => p.length > 0)
    .map((p) => ({ text: p, add: p.startsWith("[ADD:") && p.endsWith("]") }));
}

export function countAddMarkers(doc: ResumeDocument): number {
  return (JSON.stringify(doc).match(/\[ADD:[^\]]*\]/g) ?? []).length;
}

const nonEmpty = (xs: readonly string[]) => xs.map((x) => x.trim()).filter(Boolean);
const join = (parts: readonly string[], sep = " · ") => nonEmpty(parts).join(sep);

/**
 * 진단 입력·복사용 일반 텍스트(Markdown 비슷한 형식). 양식의 섹션 순서를 따른다(사이드바 양식도 한 열로).
 */
export function resumeToText(doc: ResumeDocument, templateId: ResumeTemplateId): string {
  const out: string[] = [];
  const b = doc.basics;
  if (b.name.trim()) out.push(`# ${b.name.trim()}`);
  const headline = join([b.headline, b.totalExperience.trim() ? `총 경력 ${b.totalExperience.trim()}` : ""]);
  if (headline) out.push(headline);
  const contact = join(
    [b.email, b.phone, b.location, b.portfolioUrl, ...b.links.map((l) => join([l.label, l.url], ": "))],
    " | ",
  );
  if (contact) out.push(contact);

  for (const key of RESUME_TEMPLATES[templateId].sectionOrder) {
    if (isSectionEmpty(doc, key)) continue;
    out.push("", `## ${sectionTitle(doc, key)}`);
    switch (key) {
      case "summary":
        out.push(doc.summary.trim());
        break;
      case "highlights":
        for (const h of doc.highlights) {
          if (blank(h.title) && blank(h.context)) continue;
          out.push(h.context.trim() ? `- ${h.title.trim()} (${h.context.trim()})` : `- ${h.title.trim()}`);
        }
        break;
      case "experience":
        for (const e of doc.experience) {
          if (isExperienceEmpty(e)) continue;
          out.push("", `### ${join([e.company, e.department, e.title, period(e.startDate, e.endDate), e.location], " | ")}`);
          if (e.scope.trim()) out.push(e.scope.trim());
          for (const x of nonEmpty(e.bullets)) out.push(`- ${x}`);
        }
        break;
      case "projects":
        for (const p of doc.projects) {
          if (isProjectEmpty(p)) continue;
          out.push("", `### ${join([p.name, p.company, p.team, p.role, period(p.startDate, p.endDate)], " | ")}`);
          if (p.summary.trim()) out.push(p.summary.trim());
          for (const [label, v] of [
            ["문제", p.problem],
            ["행동", p.action],
            ["결과", p.result],
            ["근거", p.evidence],
          ] as const) {
            if (v.trim()) out.push(`- ${label}: ${v.trim()}`);
          }
          for (const x of nonEmpty(p.bullets)) out.push(`- ${x}`);
          if (nonEmpty(p.techs).length) out.push(`기술: ${nonEmpty(p.techs).join(", ")}`);
        }
        break;
      case "skills":
        for (const s of doc.skills) {
          const body = join([s.detail, nonEmpty(s.items).join(", ")], " — ");
          if (body || s.category.trim()) out.push(s.category.trim() ? `- ${s.category.trim()}: ${body}` : `- ${body}`);
        }
        break;
      case "education":
        for (const e of doc.education) {
          if (blank(e.school) && blank(e.major)) continue;
          out.push(`- ${join([e.school, e.degree, e.major, period(e.startDate, e.endDate), e.note], " | ")}`);
        }
        break;
      case "certifications":
        for (const c of doc.certifications.filter((c) => !blank(c.name))) out.push(`- ${join([c.name, c.issuer, c.date], " | ")}`);
        break;
      case "extras":
        for (const x of doc.extras) {
          if (x.title.trim()) out.push("", `### ${x.title.trim()}`);
          for (const i of nonEmpty(x.items)) out.push(`- ${i}`);
        }
        break;
    }
  }
  return out.join("\n").trim();
}
