/**
 * 이력서 양식 미리보기(HTML). PDF(src/lib/resumes/pdf.tsx)와 같은 섹션 배치·스타일 토큰을 쓴다.
 * 훅이 없어 서버·클라이언트 어디서나 렌더링된다. 사용자 입력은 텍스트로만 넣는다(링크도 a 태그로 만들지 않는다).
 */
import type { CSSProperties, ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import {
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeSectionKey,
  type ResumeTemplate,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";
import { period, projectStoryLines, resumeLayout, sectionTitle, splitAddMarkers } from "@/lib/resumes/layout";
import { PerformanceSheet } from "./PerformanceSheet";

const joinParts = (xs: string[], sep = " · ") => xs.map((x) => x.trim()).filter(Boolean).join(sep);


function Rich({ text }: { text: string }) {
  return (
    <>
      {splitAddMarkers(text).map((p, i) =>
        p.add ? (
          <mark key={i} className="rounded bg-yellow-200 px-0.5 text-slate-900">
            {p.text}
          </mark>
        ) : (
          <span key={i}>{p.text}</span>
        ),
      )}
    </>
  );
}

function Bullets({ items, accent }: { items: string[]; accent: string }) {
  const list = items.map((x) => x.trim()).filter(Boolean);
  if (list.length === 0) return null;
  return (
    <ul className="mt-1 space-y-0.5">
      {list.map((it, i) => (
        <li key={i} className="flex gap-2">
          <span aria-hidden style={{ color: accent }} className="font-bold">
            •
          </span>
          <span className="min-w-0 flex-1">
            <Rich text={it} />
          </span>
        </li>
      ))}
    </ul>
  );
}

function Heading({ t, k, title }: { t: ResumeTemplate; k: ResumeSectionKey; title: string }) {
  const accent = t.style.accent;
  const style: CSSProperties =
    t.style.headingStyle === "underline"
      ? { borderBottom: `1px solid ${accent}` }
      : t.style.headingStyle === "bar"
        ? { borderLeft: `3px solid ${accent}`, paddingLeft: 8 }
        : { color: accent };
  return (
    <h3 data-heading={k} className="mb-2 pb-0.5 text-[1.15em] font-extrabold text-slate-900" style={style}>
      {title}
    </h3>
  );
}

function ItemHead({ title, when }: { title: string; when: string }) {
  return (
    <div className="flex flex-wrap items-baseline justify-between gap-x-3">
      <p className="min-w-0 font-bold text-slate-900">
        <Rich text={title} />
      </p>
      {when && <p className="shrink-0 text-[0.9em] text-slate-500">{when}</p>}
    </div>
  );
}

function SectionBody({ doc, k, t, narrow }: { doc: ResumeDocument; k: ResumeSectionKey; t: ResumeTemplate; narrow: boolean }) {
  const accent = t.style.accent;
  const gap = t.style.density === "compact" ? "space-y-2" : "space-y-3";
  switch (k) {
    case "summary":
      return (
        <p className="whitespace-pre-line">
          <Rich text={doc.summary.trim()} />
        </p>
      );
    case "highlights":
      return (
        <ul className="space-y-1.5">
          {doc.highlights
            .filter((h) => h.title.trim() || h.context.trim())
            .map((h, i) => (
              <li key={i}>
                <p className="font-bold text-slate-900">
                  <Rich text={h.title} />
                </p>
                {h.context.trim() && (
                  <p className="text-[0.92em] text-slate-500">
                    <Rich text={h.context} />
                  </p>
                )}
              </li>
            ))}
        </ul>
      );
    case "experience":
      return (
        <div className={gap}>
          {doc.experience.map((e, i) => (
            <div key={i}>
              <ItemHead title={joinParts([e.company, e.title], " | ")} when={period(e.startDate, e.endDate)} />
              {joinParts([e.department, e.location]) && <p className="text-[0.92em] text-slate-500">{joinParts([e.department, e.location])}</p>}
              {e.scope.trim() && (
                <p className="mt-0.5">
                  <Rich text={e.scope} />
                </p>
              )}
              <Bullets items={e.bullets} accent={accent} />
            </div>
          ))}
        </div>
      );
    case "projects":
      return (
        <div className={gap}>
          {doc.projects.map((p, i) => (
            <div key={i}>
              <ItemHead title={joinParts([p.name, p.role], " | ")} when={period(p.startDate, p.endDate)} />
              {joinParts([p.company, p.team]) && <p className="text-[0.92em] text-slate-500">{joinParts([p.company, p.team])}</p>}
              {p.summary.trim() && (
                <p className="text-[0.95em] text-slate-600">
                  <Rich text={p.summary} />
                </p>
              )}
              <Bullets items={projectStoryLines(p)} accent={accent} />
              <Bullets items={p.bullets} accent={accent} />
              {p.evidence.trim() && <p className="mt-0.5 text-[0.9em] text-slate-500">근거: {p.evidence}</p>}
              {p.techs.some((x) => x.trim()) && (
                <p className="mt-0.5 text-[0.9em] text-slate-500">기술: {joinParts(p.techs, ", ")}</p>
              )}
            </div>
          ))}
        </div>
      );
    case "skills":
      return (
        <div className="space-y-1.5">
          {doc.skills
            .filter((g) => g.items.some((x) => x.trim()) || g.detail.trim())
            .map((g, i) =>
              t.style.skillChips ? (
                <div key={i}>
                  {g.category.trim() && <p className="font-bold text-slate-900">{g.category}</p>}
                  {g.detail.trim() && <p className="text-[0.95em] text-slate-600">{g.detail}</p>}
                  <ul className="mt-1 flex flex-wrap gap-1">
                    {g.items
                      .map((x) => x.trim())
                      .filter(Boolean)
                      .map((x, j) => (
                        <li key={j} className="rounded border px-1.5 py-0.5 text-[0.85em]" style={{ borderColor: accent, color: accent }}>
                          {x}
                        </li>
                      ))}
                  </ul>
                </div>
              ) : (
                <div key={i} className={narrow ? "" : "flex flex-wrap gap-x-3 sm:flex-nowrap"}>
                  {g.category.trim() && <p className={cn("font-bold text-slate-900", !narrow && "sm:w-28 sm:shrink-0")}>{g.category}</p>}
                  <p className="min-w-0 flex-1">{joinParts([g.detail, joinParts(g.items, ", ")], " — ")}</p>
                </div>
              ),
            )}
        </div>
      );
    case "education":
      return (
        <div className="space-y-1.5">
          {doc.education.filter((e) => e.school.trim() || e.major.trim()).map((e, i) => (
            <div key={i}>
              <p className="font-bold text-slate-900">{e.school}</p>
              <p className="text-[0.92em] text-slate-500">{joinParts([e.degree, e.major, period(e.startDate, e.endDate)])}</p>
              {e.note.trim() && (
                <p>
                  <Rich text={e.note} />
                </p>
              )}
            </div>
          ))}
        </div>
      );
    case "certifications":
      return (
        <ul className="space-y-0.5">
          {doc.certifications.filter((c) => c.name.trim()).map((c, i) => (
            <li key={i}>
              <span className="font-bold text-slate-900">{c.name}</span>
              {joinParts([c.issuer, c.date]) && <span className="text-slate-500"> — {joinParts([c.issuer, c.date])}</span>}
            </li>
          ))}
        </ul>
      );
    case "extras":
      return (
        <div className={gap}>
          {doc.extras.map((x, i) => (
            <div key={i}>
              {x.title.trim() && <p className="font-bold text-slate-900">{x.title}</p>}
              <Bullets items={x.items} accent={accent} />
            </div>
          ))}
        </div>
      );
  }
}

function Section({ children, k, t, title }: { children: ReactNode; k: ResumeSectionKey; t: ResumeTemplate; title: string }) {
  return (
    <section data-section={k} className={t.style.density === "compact" ? "mt-3" : "mt-5"}>
      <Heading t={t} k={k} title={title} />
      {children}
    </section>
  );
}

export function ResumePreview({
  document: doc,
  templateId,
  className,
}: {
  document: ResumeDocument;
  templateId: ResumeTemplateId;
  className?: string;
}) {
  // 성과 중심 양식은 원본 템플릿을 그대로 옮긴 A4 시트(읽기 전용)로 보인다.
  if (templateId === "performance") return <PerformanceSheet document={doc} className={className} />;
  const t = RESUME_TEMPLATES[templateId];
  const layout = resumeLayout(doc, templateId);
  const b = doc.basics;
  const contact = joinParts([b.email, b.phone, b.location, b.portfolioUrl], "  |  ");
  const links = b.links.filter((l) => l.url.trim());
  const hasSide = layout.side.length > 0;
  // PDF 기준 글자 크기(pt)를 화면 px로 대략 옮긴다(10pt → 14px).
  const fontSize = `${(t.style.baseFontSize * 1.4).toFixed(1)}px`;

  const main = layout.main.map((k) => (
    <Section key={k} k={k} t={t} title={sectionTitle(doc, k)}>
      <SectionBody doc={doc} k={k} t={t} narrow={false} />
    </Section>
  ));

  return (
    <article
      data-template={templateId}
      className={cn("rounded-lg border border-slate-200 bg-white p-5 leading-relaxed text-slate-800 shadow-sm sm:p-8", className)}
      style={{ fontSize }}
    >
      <header
        className="pb-3"
        style={{ borderBottom: t.style.headingStyle === "plain" ? "1px solid #e5e7eb" : `2px solid ${t.style.accent}` }}
      >
        <h2 className="text-[1.9em] leading-tight font-extrabold break-words text-slate-900">
          <Rich text={b.name.trim() || "이름"} />
        </h2>
        {b.headline.trim() && (
          <p className="mt-1 font-bold" style={{ color: t.style.accent }}>
            <Rich text={b.headline} />
            {b.totalExperience.trim() && <span className="ml-2 text-[0.85em] font-normal text-slate-500">총 경력 {b.totalExperience}</span>}
          </p>
        )}
        {contact && <p className="mt-1.5 text-[0.9em] break-words text-slate-500">{contact}</p>}
        {!hasSide && links.length > 0 && (
          <p className="mt-0.5 text-[0.9em] break-all text-slate-500">
            {links.map((l) => joinParts([l.label, l.url], ": ")).join("  |  ")}
          </p>
        )}
      </header>

      {layout.main.length === 0 && !hasSide ? (
        <p className="mt-6 text-center text-slate-400">아직 내용이 없습니다. 왼쪽 편집 폼에서 내용을 채워 주세요.</p>
      ) : hasSide ? (
        <div className="flex flex-col gap-4 sm:flex-row">
          <aside className="rounded-md bg-slate-50 px-3 pb-3 sm:w-[34%] sm:shrink-0">
            {links.length > 0 && (
              <section className="mt-5">
                <h3 className="mb-2 text-[1.15em] font-extrabold text-slate-900" style={{ borderLeft: `3px solid ${t.style.accent}`, paddingLeft: 8 }}>
                  링크
                </h3>
                <ul className="space-y-0.5 text-[0.9em] break-all text-slate-600">
                  {links.map((l, i) => (
                    <li key={i}>{joinParts([l.label, l.url], ": ")}</li>
                  ))}
                </ul>
              </section>
            )}
            {layout.side.map((k) => (
              <Section key={k} k={k} t={t} title={sectionTitle(doc, k)}>
                <SectionBody doc={doc} k={k} t={t} narrow />
              </Section>
            ))}
          </aside>
          <div className="min-w-0 flex-1">{main}</div>
        </div>
      ) : (
        main
      )}
    </article>
  );
}
