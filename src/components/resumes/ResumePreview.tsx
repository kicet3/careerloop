"use client";

/**
 * 이력서 양식 미리보기(HTML). PDF(src/lib/resumes/pdf.tsx)와 같은 섹션 배치·스타일 토큰(pt)·쪽 여백을 쓰고,
 * 내용이 A4 한 장을 넘으면 A4 쪽 카드로 나눠 보인다(쪽 나눔 규칙: src/lib/resumes/pagination.ts).
 *
 * 쪽 나눔: 문서를 '블록'(머리글, 섹션 제목, 경력 한 건의 머리줄·불릿 하나…) 목록으로 만들고, 화면 밖 측정 칸에
 * 쪽 본문 폭으로 그려 높이를 잰 뒤 paginate로 쪽에 나눈다. 내용·양식이 바뀌거나 글꼴을 다 받으면(측정 칸 크기 변화) 다시 잰다.
 * 사용자 입력은 텍스트로만 넣는다(링크도 a 태그로 만들지 않는다).
 */
import { useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from "react";
import { cn } from "@/components/ui/cn";
import {
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeSectionKey,
  type ResumeTemplate,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";
import {
  isExperienceEmpty,
  isProjectEmpty,
  period,
  projectStoryLines,
  RESUME_PHOTO_PT,
  resumeLayout,
  sectionTitle,
  splitAddMarkers,
} from "@/lib/resumes/layout";
import { A4, pageOverflow, paginate, ptToPx, type PageAtom } from "@/lib/resumes/pagination";
import { PerformanceSheet } from "./PerformanceSheet";

const joinParts = (xs: string[], sep = " · ") => xs.map((x) => x.trim()).filter(Boolean).join(sep);

/** PDF(pdf.tsx)와 같은 색. */
const C = { ink: "#111827", body: "#1f2937", muted: "#6b7280", line: "#e5e7eb", side: "#f8fafc" };
const pt = (v: number) => `${v}pt`;

/** 양식별 쪽 여백·간격(pt). pdf.tsx makeStyles와 같은 값. */
function geometry(t: ResumeTemplate) {
  const compact = t.style.density === "compact";
  const padY = compact ? 32 : 40;
  const padX = compact ? 34 : 42;
  const sidebar = t.style.layout === "sidebar";
  const contentWidth = A4.widthPt - padX * 2;
  const side = { width: 150, gap: 16, padX: 9, padY: 6 };
  return {
    base: t.style.baseFontSize,
    lineHeight: compact ? 1.4 : 1.5,
    gap: compact ? 0.6 : 1,
    padY,
    padX,
    sidebar,
    side,
    contentWidth,
    contentHeight: A4.heightPt - padY * 2,
    mainWidth: sidebar ? contentWidth - side.width - side.gap : contentWidth,
    sideInnerWidth: side.width - side.padX * 2,
  };
}
type Geo = ReturnType<typeof geometry>;

interface Atom {
  id: string;
  group: string;
  keepWithNext?: boolean;
  /** 같은 쪽에서 앞 블록과의 간격(pt). */
  gapPt: number;
  node: ReactNode;
}

/** 블록을 차례로 쌓는다. 앞 블록의 아래 여백(margin-bottom)은 다음 블록의 간격으로 넘긴다(PDF는 여백이 겹치지 않는다). */
class Column {
  atoms: Atom[] = [];
  private pending = 0;
  push(id: string, group: string, node: ReactNode, { before = 0, after = 0, keepWithNext = false } = {}) {
    this.atoms.push({ id, group, node, gapPt: this.pending + before, keepWithNext });
    this.pending = after;
  }
  /** 마지막 블록의 아래 여백을 더한다(항목 사이 간격). */
  addAfter(v: number) {
    this.pending += v;
  }
}

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

function styles(t: ResumeTemplate, g: Geo) {
  const accent = t.style.accent;
  const base = g.base;
  const sub: CSSProperties = { color: C.muted, fontSize: pt(base - 0.5) };
  return {
    title: { fontWeight: 700, color: C.ink } satisfies CSSProperties,
    sub,
    period: { color: C.muted, fontSize: pt(base - 1), marginLeft: pt(8), flexShrink: 0, whiteSpace: "nowrap" } satisfies CSSProperties,
    heading: (
      t.style.headingStyle === "underline"
        ? { borderBottom: `1pt solid ${accent}`, paddingBottom: pt(2) }
        : t.style.headingStyle === "bar"
          ? { borderLeft: `3pt solid ${accent}`, paddingLeft: pt(6) }
          : {}
    ) satisfies CSSProperties,
    headingText: { fontSize: pt(base + 2), fontWeight: 800, color: t.style.headingStyle === "plain" ? accent : C.ink } satisfies CSSProperties,
    headingAfter: (t.style.headingStyle === "plain" ? 4 : 6) * g.gap,
    chip: {
      fontSize: pt(base - 1.5),
      lineHeight: 1.2,
      borderRadius: pt(3),
      border: `0.5pt solid ${accent}`,
      color: accent,
      padding: `${pt(2)} ${pt(5)} ${pt(0.8)}`,
      marginRight: pt(3),
      marginBottom: pt(3),
    } satisfies CSSProperties,
  };
}

function Bullet({ text, accent }: { text: string; accent: string }) {
  return (
    <div className="flex">
      <span aria-hidden style={{ width: pt(9), flexShrink: 0, color: accent, fontWeight: 700 }}>
        •
      </span>
      <span className="min-w-0 flex-1">
        <Rich text={text} />
      </span>
    </div>
  );
}

function ItemHead({ title, when, s }: { title: string; when: string; s: ReturnType<typeof styles> }) {
  return (
    <div className="flex items-baseline justify-between">
      <p className="min-w-0 flex-1" style={s.title}>
        <Rich text={title} />
      </p>
      {when && <p style={s.period}>{when}</p>}
    </div>
  );
}

/** 섹션 하나를 블록으로 쌓는다. 묶음(group)은 쪽에서 함께 움직이고, 제목은 첫 항목과 함께 움직인다. */
function pushSection(col: Column, doc: ResumeDocument, k: ResumeSectionKey, t: ResumeTemplate, g: Geo, narrow: boolean) {
  const s = styles(t, g);
  const accent = t.style.accent;
  const gp = g.gap;
  const lines = (xs: string[]) => xs.map((x) => x.trim()).filter(Boolean);
  col.push(
    `${k}:h`,
    `${k}:h`,
    <h3 data-section={k} style={s.heading}>
      <span style={s.headingText}>{sectionTitle(doc, k)}</span>
    </h3>,
    { before: 12 * gp, after: s.headingAfter, keepWithNext: true },
  );
  const bullets = (prefix: string, group: string, items: string[]) =>
    lines(items).forEach((x, j) => col.push(`${prefix}:b${j}`, group, <Bullet text={x} accent={accent} />, { before: 1.5 }));

  switch (k) {
    case "summary": {
      // 문단(줄) 단위 블록: 한 쪽보다 길 때만 줄 사이에서 나뉜다.
      doc.summary
        .trim()
        .split("\n")
        .forEach((line, i) =>
          col.push(
            `summary:${i}`,
            "summary",
            <p>
              <Rich text={line.trim() ? line : " "} />
            </p>,
          ),
        );
      return;
    }
    case "highlights":
      doc.highlights
        .filter((h) => h.title.trim() || h.context.trim())
        .forEach((h, i) => {
          const grp = `highlights:${i}`;
          if (h.title.trim())
            col.push(
              `${grp}:t`,
              grp,
              <p style={s.title}>
                <Rich text={h.title} />
              </p>,
            );
          if (h.context.trim())
            col.push(
              `${grp}:c`,
              grp,
              <p style={s.sub}>
                <Rich text={h.context} />
              </p>,
            );
          col.addAfter(4);
        });
      return;
    case "experience":
      doc.experience
        .filter((e) => !isExperienceEmpty(e))
        .forEach((e, i) => {
          const grp = `experience:${i}`;
          col.push(`${grp}:head`, grp, <ItemHead title={joinParts([e.company, e.title], " | ")} when={period(e.startDate, e.endDate)} s={s} />);
          const where = joinParts([e.department, e.location]);
          if (where) col.push(`${grp}:sub`, grp, <p style={s.sub}>{where}</p>);
          if (e.scope.trim())
            col.push(
              `${grp}:scope`,
              grp,
              <p>
                <Rich text={e.scope} />
              </p>,
            );
          bullets(grp, grp, e.bullets);
          col.addAfter(7 * gp);
        });
      return;
    case "projects":
      doc.projects
        .filter((p) => !isProjectEmpty(p))
        .forEach((p, i) => {
          const grp = `projects:${i}`;
          col.push(`${grp}:head`, grp, <ItemHead title={joinParts([p.name, p.role], " | ")} when={period(p.startDate, p.endDate)} s={s} />);
          const where = joinParts([p.company, p.team]);
          if (where) col.push(`${grp}:sub`, grp, <p style={s.sub}>{where}</p>);
          if (p.summary.trim())
            col.push(
              `${grp}:summary`,
              grp,
              <p style={s.sub}>
                <Rich text={p.summary} />
              </p>,
            );
          bullets(grp, grp, [...projectStoryLines(p), ...p.bullets]);
          if (p.evidence.trim()) col.push(`${grp}:evidence`, grp, <p style={s.sub}>근거: {p.evidence}</p>);
          if (p.techs.some((x) => x.trim())) col.push(`${grp}:techs`, grp, <p style={s.sub}>기술: {joinParts(p.techs, ", ")}</p>);
          col.addAfter(7 * gp);
        });
      return;
    case "skills":
      doc.skills
        .filter((sk) => sk.items.some((x) => x.trim()) || sk.detail.trim())
        .forEach((sk, i) => {
          const id = `skills:${i}`;
          if (t.style.skillChips) {
            col.push(
              id,
              id,
              <div>
                {sk.category.trim() && <p style={s.title}>{sk.category}</p>}
                {sk.detail.trim() && <p style={s.sub}>{sk.detail}</p>}
                <ul className="flex flex-wrap" style={{ marginTop: pt(2) }}>
                  {lines(sk.items).map((x, j) => (
                    <li key={j} style={s.chip}>
                      {x}
                    </li>
                  ))}
                </ul>
              </div>,
              { after: 4 },
            );
          } else {
            col.push(
              id,
              id,
              <div className={narrow ? "" : "flex"}>
                {sk.category.trim() && (
                  <p style={{ ...s.title, ...(narrow ? {} : { width: pt(90), flexShrink: 0 }) }}>{sk.category}</p>
                )}
                <p className="min-w-0 flex-1">{joinParts([sk.detail, joinParts(sk.items, ", ")], " — ")}</p>
              </div>,
              { after: narrow ? 3 : 2 },
            );
          }
        });
      return;
    case "education":
      doc.education
        .filter((e) => e.school.trim() || e.major.trim())
        .forEach((e, i) => {
          const id = `education:${i}`;
          col.push(
            id,
            id,
            <div>
              <p style={s.title}>{e.school}</p>
              <p style={s.sub}>{joinParts([e.degree, e.major, period(e.startDate, e.endDate)])}</p>
              {e.note.trim() && (
                <p>
                  <Rich text={e.note} />
                </p>
              )}
            </div>,
            { after: 7 * gp },
          );
        });
      return;
    case "certifications":
      doc.certifications
        .filter((c) => c.name.trim())
        .forEach((c, i) => {
          const id = `certifications:${i}`;
          col.push(
            id,
            id,
            <p>
              <span style={{ fontWeight: 700 }}>{c.name}</span>
              {joinParts([c.issuer, c.date]) && ` — ${joinParts([c.issuer, c.date])}`}
            </p>,
            { after: 2 },
          );
        });
      return;
    case "extras":
      doc.extras
        .filter((x) => x.title.trim() || x.items.some((v) => v.trim()))
        .forEach((x, i) => {
          const grp = `extras:${i}`;
          if (x.title.trim()) col.push(`${grp}:t`, grp, <p style={s.title}>{x.title}</p>);
          bullets(grp, grp, x.items);
          col.addAfter(7 * gp);
        });
      return;
  }
}

interface Model {
  geo: Geo;
  /** 사이드바 양식의 머리글(두 열 위, 첫 쪽에만). 한 열 양식은 main의 첫 블록이 머리글이다. */
  header: Atom | null;
  /** 머리글 아래 여백(pt, 사이드바 양식). */
  headerAfterPt: number;
  main: Atom[];
  side: Atom[];
}

/** @internal 테스트용으로 내보낸다. */
export function buildModel(doc: ResumeDocument, templateId: ResumeTemplateId, photoUrl: string | null = null): Model {
  const t = RESUME_TEMPLATES[templateId];
  const g = geometry(t);
  const layout = resumeLayout(doc, templateId);
  const b = doc.basics;
  const contact = joinParts([b.email, b.phone, b.location, b.portfolioUrl], "  |  ");
  const links = b.links.filter((l) => l.url.trim());
  const hasSide = g.sidebar && layout.side.length > 0;
  const contactStyle: CSSProperties = { fontSize: pt(g.base - 1), color: C.muted, marginTop: pt(5), overflowWrap: "anywhere" };

  const headerNode = (
    <header
      style={{
        borderBottom: t.style.headingStyle === "plain" ? `0.75pt solid ${C.line}` : `2pt solid ${t.style.accent}`,
        paddingBottom: pt(10 * g.gap),
      }}
    >
      <div style={{ display: "flex", alignItems: "flex-start" }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <h2 style={{ fontSize: pt(g.base + 11), fontWeight: 800, color: C.ink, lineHeight: 1.25, overflowWrap: "anywhere" }}>
            <Rich text={b.name.trim() || "이름"} />
          </h2>
          {(b.headline.trim() || b.totalExperience.trim()) && (
            <p style={{ fontSize: pt(g.base + 1.5), fontWeight: 700, color: t.style.accent, marginTop: pt(3) }}>
              {b.headline.trim() && <Rich text={b.headline} />}
              {b.totalExperience.trim() && (
                <span style={{ marginLeft: b.headline.trim() ? pt(8) : 0, fontSize: "0.85em", fontWeight: 400, color: C.muted }}>
                  총 경력 {b.totalExperience}
                </span>
              )}
            </p>
          )}
          {contact && <p style={contactStyle}>{contact}</p>}
          {!hasSide && links.length > 0 && <p style={contactStyle}>{links.map((l) => joinParts([l.label, l.url], ": ")).join("  |  ")}</p>}
        </div>
        {photoUrl ? (
          // 소유자만 읽는 같은 출처 라우트. PDF는 서버가 같은 사진을 data URI로 넣는다(pdf.tsx).
          // eslint-disable-next-line @next/next/no-img-element
          <img
            src={photoUrl}
            alt="프로필 사진"
            data-resume-photo
            style={{ width: pt(RESUME_PHOTO_PT.width), height: pt(RESUME_PHOTO_PT.height), marginLeft: pt(14), objectFit: "cover", borderRadius: pt(2), flexShrink: 0 }}
          />
        ) : null}
      </div>
    </header>
  );
  const headerAfterPt = 6 * g.gap;

  const main = new Column();
  const side = new Column();
  if (!hasSide) main.push("header", "header", headerNode, { after: headerAfterPt });
  // 한 줄 소개: 지원 직무 줄이 아니라 머리글 선 아래, 첫 섹션 앞의 독립 블록(사이드바 양식은 본문 열 맨 위).
  if (b.tagline.trim()) {
    main.push(
      "tagline",
      "tagline",
      <p data-tagline style={{ fontSize: pt(g.base + 0.5), fontWeight: 400, color: C.body, lineHeight: 1.5, overflowWrap: "anywhere" }}>
        <Rich text={b.tagline} />
      </p>,
      { before: 4 * g.gap },
    );
  }

  if (layout.main.length === 0 && !hasSide && !b.tagline.trim()) {
    main.push(
      "empty",
      "empty",
      <p className="text-center text-slate-400" style={{ marginTop: pt(18) }}>
        아직 내용이 없습니다. 왼쪽 편집 폼에서 내용을 채워 주세요.
      </p>,
    );
  }
  for (const k of layout.main) pushSection(main, doc, k, t, g, false);
  if (hasSide) {
    const s = styles(t, g);
    if (links.length > 0) {
      side.push(
        "links:h",
        "links:h",
        <h3 style={{ borderLeft: `3pt solid ${t.style.accent}`, paddingLeft: pt(6) }}>
          <span style={s.headingText}>링크</span>
        </h3>,
        { before: 12 * g.gap, after: 6 * g.gap, keepWithNext: true },
      );
      links.forEach((l, i) =>
        side.push(`links:${i}`, "links", <p style={{ ...s.sub, overflowWrap: "anywhere" }}>{joinParts([l.label, l.url], ": ")}</p>),
      );
    }
    for (const k of layout.side) pushSection(side, doc, k, t, g, true);
  }
  return { geo: g, header: hasSide ? { id: "header", group: "header", gapPt: 0, node: headerNode } : null, headerAfterPt, main: main.atoms, side: side.atoms };
}

export interface Pages {
  main: string[][];
  side: string[][];
  /** 쪽마다 A4 본문 높이를 넘는 만큼(px). 더 나눌 수 없는 블록 하나가 한 쪽보다 클 때만 0보다 크고, 그만큼 쪽 카드를 늘린다. */
  extra: number[];
}

function samePages(a: Pages | null, b: Pages) {
  return !!a && JSON.stringify(a) === JSON.stringify(b);
}

/** 측정 칸의 블록 높이로 쪽을 나눈다(px). @internal 테스트용으로 내보낸다. */
export function computePages(model: Model, heights: Map<string, number>): Pages {
  const g = model.geo;
  const toPageAtoms = (atoms: Atom[]): PageAtom[] =>
    atoms.map((a) => ({ id: a.id, group: a.group, keepWithNext: a.keepWithNext, gapBefore: ptToPx(a.gapPt), height: heights.get(a.id) ?? 0 }));
  const pageHeight = ptToPx(g.contentHeight);
  const headerHeight = model.header ? (heights.get(model.header.id) ?? 0) + ptToPx(model.headerAfterPt) : 0;
  const mainAtoms = toPageAtoms(model.main);
  const mainOpts = { pageHeight, firstPageHeight: pageHeight - headerHeight };
  const main = paginate(mainAtoms, mainOpts);
  const sideInset = ptToPx(g.side.padY * 2);
  const sideAtoms = toPageAtoms(model.side);
  const sideOpts = { pageHeight: pageHeight - sideInset, firstPageHeight: pageHeight - headerHeight - sideInset };
  const side = model.side.length > 0 ? paginate(sideAtoms, sideOpts) : [];
  const mainOver = pageOverflow(mainAtoms, main, mainOpts);
  const sideOver = model.side.length > 0 ? pageOverflow(sideAtoms, side, sideOpts) : [];
  const extra = Array.from({ length: Math.max(main.length, side.length, 1) }, (_, p) => Math.max(mainOver[p] ?? 0, sideOver[p] ?? 0));
  return { main, side, extra };
}

const noopSubscribe = () => () => {};

/** 입력할 때마다 미리보기를 다시 그리지 않게 잠깐 모았다가 반영한다. */
function useDebounced<T>(value: T, ms: number): T {
  const [v, setV] = useState(value);
  useEffect(() => {
    const id = setTimeout(() => setV(value), ms);
    return () => clearTimeout(id);
  }, [value, ms]);
  return v;
}

function AtomBox({ atom, first, measure }: { atom: Atom; first: boolean; measure?: boolean }) {
  return (
    <div data-measure-atom={measure ? atom.id : undefined} style={{ display: "flow-root", marginTop: first ? 0 : pt(atom.gapPt) }}>
      {atom.node}
    </div>
  );
}

export function ResumePreview({
  document: liveDoc,
  templateId,
  className,
  photoUrl = null,
}: {
  document: ResumeDocument;
  templateId: ResumeTemplateId;
  className?: string;
  /** 머리글 프로필 사진 주소(소유자만 읽는 /api/account/photo). 없으면 사진 없이. */
  photoUrl?: string | null;
}) {
  // 성과 중심 양식은 원본 템플릿을 그대로 옮긴 A4 시트(읽기 전용)로 보인다.
  if (templateId === "performance") return <PerformanceSheet document={liveDoc} className={className} photoUrl={photoUrl} />;
  return <PagedPreview document={liveDoc} templateId={templateId} className={className} photoUrl={photoUrl} />;
}

function PagedPreview({
  document: liveDoc,
  templateId,
  className,
  photoUrl,
}: {
  document: ResumeDocument;
  templateId: ResumeTemplateId;
  className?: string;
  photoUrl: string | null;
}) {
  const doc = useDebounced(liveDoc, 150);
  const model = useMemo(() => buildModel(doc, templateId, photoUrl), [doc, templateId, photoUrl]);
  const g = model.geo;

  // 측정 칸은 브라우저에서만 그린다(서버 렌더·하이드레이션 결과는 같게).
  const mounted = useSyncExternalStore(noopSubscribe, () => true, () => false);
  const [pages, setPages] = useState<Pages | null>(null);
  const [scale, setScale] = useState(0.75);
  const listRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const modelRef = useRef(model);

  // 쪽 폭에 맞춰 줄인다(화면이 A4보다 좁을 때).
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const fit = () => setScale(Math.min(1, Math.max(0.3, el.clientWidth / A4.widthPx)));
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // 측정 칸에서 블록 높이를 재 쪽을 나눈다. 내용이 바뀔 때, 글꼴을 받거나 측정 칸 크기가 바뀔 때 다시 잰다.
  useLayoutEffect(() => {
    modelRef.current = model;
    const root = measureRef.current;
    if (!root) return;
    const measure = () => {
      const heights = new Map<string, number>();
      root.querySelectorAll<HTMLElement>("[data-measure-atom]").forEach((el) => {
        heights.set(el.dataset.measureAtom!, el.getBoundingClientRect().height);
      });
      const next = computePages(modelRef.current, heights);
      setPages((prev) => (samePages(prev, next) ? prev : next));
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(root);
    const fonts = typeof document !== "undefined" ? document.fonts : undefined;
    fonts?.ready.then(measure).catch(() => {});
    fonts?.addEventListener("loadingdone", measure);
    return () => {
      ro.disconnect();
      fonts?.removeEventListener("loadingdone", measure);
    };
  }, [model, mounted]);

  // 아직 재지 않았으면(서버 렌더·첫 그리기) 한 쪽에 모두 둔다. 쪽에 없는 블록(측정 직전 바뀐 내용)은 마지막 쪽에 붙인다.
  const byId = new Map([...model.main, ...model.side].map((a) => [a.id, a]));
  const resolve = (ids: string[][] | undefined, atoms: Atom[]): Atom[][] => {
    const list = (ids && ids.length > 0 ? ids : [atoms.map((a) => a.id)]).map((p) => p.map((id) => byId.get(id)).filter((a): a is Atom => !!a));
    const placed = new Set(list.flat().map((a) => a.id));
    const rest = atoms.filter((a) => !placed.has(a.id));
    if (rest.length > 0) list[list.length - 1]!.push(...rest);
    return list;
  };
  const mainPages = resolve(pages?.main, model.main);
  const sidePages = model.side.length > 0 ? resolve(pages?.side, model.side) : [];
  const count = Math.max(mainPages.length, sidePages.length, 1);
  const measured = mounted && pages !== null;

  // 쪽은 배율 1(측정 칸과 같은 배치)로 그리고 transform으로만 줄인다. zoom은 줄인 크기로 다시 배치해 줄바꿈이 측정과 달라질 수 있다.
  const pageHeightPx = (p: number) => A4.heightPx + (measured ? (pages?.extra[p] ?? 0) : 0);
  const pageStyle: CSSProperties = {
    width: A4.widthPx,
    padding: `${pt(g.padY)} ${pt(g.padX)}`,
    fontSize: pt(g.base),
    lineHeight: g.lineHeight,
    color: C.body,
    overflowWrap: "anywhere",
    wordBreak: "keep-all",
  };
  const stack = (atoms: Atom[]) => atoms.map((a, i) => <AtomBox key={a.id} atom={a} first={i === 0} />);
  const sideBox = (atoms: Atom[] | undefined) => (
    <aside
      style={{
        width: pt(g.side.width),
        marginRight: pt(g.side.gap),
        flexShrink: 0,
        alignSelf: "flex-start",
        borderRadius: pt(4),
        padding: `${pt(g.side.padY)} ${pt(g.side.padX)}`,
        background: atoms && atoms.length > 0 ? C.side : "transparent",
      }}
    >
      {stack(atoms ?? [])}
    </aside>
  );

  return (
    <article
      data-template={templateId}
      data-pages={count}
      className={cn("rounded-lg border border-slate-200 bg-slate-100 p-3 sm:p-4", className)}
    >
      <div ref={listRef} className="flex flex-col items-center gap-2">
        {Array.from({ length: count }, (_, p) => (
          <div key={p} className="flex flex-col items-center gap-1">
            <div
              className="overflow-hidden rounded-sm bg-white shadow-sm ring-1 ring-slate-200"
              style={{ width: A4.widthPx * scale, height: pageHeightPx(p) * scale }}
              aria-label={count > 1 ? `${p + 1}쪽` : undefined}
              data-page={p + 1}
            >
              <div style={{ ...pageStyle, height: pageHeightPx(p), transform: `scale(${scale})`, transformOrigin: "0 0" }}>
                {model.header && p === 0 && <AtomBox atom={model.header} first />}
                {model.header ? (
                  <div className="flex" style={{ marginTop: p === 0 ? pt(model.headerAfterPt) : 0 }}>
                    {sideBox(sidePages[p])}
                    <div className="min-w-0 flex-1">{stack(mainPages[p] ?? [])}</div>
                  </div>
                ) : (
                  stack(mainPages[p] ?? [])
                )}
              </div>
            </div>
            <p className="text-[11px] text-slate-500 tabular-nums">
              {p + 1} / {count}쪽
            </p>
          </div>
        ))}
      </div>

      {/* 측정 칸: 화면 밖에서 쪽 본문 폭으로 블록을 한 줄로 그려 높이를 잰다. */}
      {mounted && (
        <div aria-hidden inert className="pointer-events-none" style={{ position: "fixed", left: -10000, top: 0, width: 0, height: 0, overflow: "hidden" }}>
          <div
            ref={measureRef}
            style={{ width: A4.widthPx, fontSize: pt(g.base), lineHeight: g.lineHeight, color: C.body, overflowWrap: "anywhere", wordBreak: "keep-all" }}
          >
            {model.header && (
              <div style={{ width: pt(g.contentWidth) }}>
                <AtomBox atom={model.header} first measure />
              </div>
            )}
            <div style={{ width: pt(g.mainWidth) }}>
              {model.main.map((a, i) => (
                <AtomBox key={a.id} atom={a} first={i === 0} measure />
              ))}
            </div>
            <div style={{ width: pt(g.sideInnerWidth) }}>
              {model.side.map((a, i) => (
                <AtomBox key={a.id} atom={a} first={i === 0} measure />
              ))}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}
