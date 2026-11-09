/**
 * 회사별 이력서 PDF 렌더러. ResumeDocument + 양식(섹션 순서·스타일 토큰) → A4 PDF.
 * 한글 폰트는 보고서 PDF와 같은 NanumGothic 파일(src/lib/report/fonts, pdf-fonts.ts)을 쓴다. Node 런타임 전용.
 * 섹션 배치(빈 섹션 제외·사이드바)는 웹 미리보기와 같은 resumeLayout을 쓴다. 성과 중심 양식은 pdf-performance.tsx.
 */
import type { ReactNode } from "react";
import { Document, Image, Page, StyleSheet, Text, View, renderToBuffer, type Styles } from "@react-pdf/renderer";
import { SERVICE_CREDIT } from "@/lib/brand";
import {
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeSectionKey,
  type ResumeTemplate,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";
import { isExperienceEmpty, isHighlightEmpty, isProjectEmpty, motivationParagraphs, period, projectStoryLines, RESUME_PHOTO_PT, resumeLayout, sectionTitle, splitAddMarkers } from "./layout";
import { A4, mayExceedPage } from "./pagination";
import { NO_HYPHEN, PDF_FONT, registerResumeFonts } from "./pdf-fonts";
import { PerformancePdfDocument } from "./pdf-performance";

const FONT = PDF_FONT;

const C = { ink: "#111827", body: "#1f2937", muted: "#6b7280", line: "#e5e7eb", side: "#f8fafc", add: "#fef08a" };

function makeStyles(t: ResumeTemplate) {
  const st = t.style;
  const base = st.baseFontSize;
  const compact = st.density === "compact";
  const gap = compact ? 0.6 : 1;
  return StyleSheet.create({
    text: { fontSize: base, lineHeight: compact ? 1.4 : 1.5 },
    page: {
      fontFamily: FONT,
      fontSize: base,
      color: C.body,
      paddingTop: compact ? 32 : 40,
      paddingBottom: compact ? 32 : 40,
      paddingHorizontal: compact ? 34 : 42,
    },
    name: { fontSize: base + 11, fontWeight: 800, color: C.ink, lineHeight: 1.25 },
    headline: { fontSize: base + 1.5, fontWeight: 700, color: st.accent, marginTop: 3 },
    contact: { fontSize: base - 1, color: C.muted, marginTop: 5 },
    // 한 줄 소개: 머리글 선 아래 독립 줄(웹 미리보기 ResumePreview의 tagline 블록과 같은 값).
    tagline: { fontSize: base + 0.5, color: C.body, lineHeight: 1.5 },
    // 머리글 사진(3:4). 웹 미리보기 ResumePreview의 사진 칸과 같은 크기(pt).
    headerRow: { flexDirection: "row", alignItems: "flex-start" },
    headerText: { flex: 1 },
    photo: { width: RESUME_PHOTO_PT.width, height: RESUME_PHOTO_PT.height, marginLeft: 14, objectFit: "cover", borderRadius: 2 },
    headerBand: {
      borderBottomWidth: st.headingStyle === "plain" ? 0.75 : 2,
      borderBottomColor: st.headingStyle === "plain" ? C.line : st.accent,
      paddingBottom: 10 * gap,
      marginBottom: 6 * gap,
    },
    columns: { flexDirection: "row" },
    main: { flex: 1 },
    side: { width: 150, marginRight: 16, backgroundColor: C.side, borderRadius: 4, paddingHorizontal: 9, paddingVertical: 6 },
    section: { marginTop: 12 * gap },
    sectionHead:
      st.headingStyle === "underline"
        ? { borderBottomWidth: 1, borderBottomColor: st.accent, paddingBottom: 2, marginBottom: 6 * gap }
        : st.headingStyle === "bar"
          ? { borderLeftWidth: 3, borderLeftColor: st.accent, paddingLeft: 6, marginBottom: 6 * gap }
          : { marginBottom: 4 * gap },
    sectionTitle: { fontSize: base + 2, fontWeight: 800, color: st.headingStyle === "plain" ? st.accent : C.ink },
    item: { marginBottom: 7 * gap },
    itemHead: { flexDirection: "row", justifyContent: "space-between" },
    itemTitle: { fontWeight: 700, color: C.ink },
    // 행(row) 안에서만 남는 폭을 채운다. 열(column)에서 flex:1을 주면 높이가 0이 되어 다음 줄과 겹친다.
    grow: { flex: 1 },
    itemPeriod: { color: C.muted, fontSize: base - 1, marginLeft: 8 },
    itemSub: { color: C.muted, fontSize: base - 0.5 },
    bulletRow: { flexDirection: "row", marginTop: 1.5 },
    bulletDot: { width: 9, color: st.accent, fontWeight: 700 },
    chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 2 },
    chip: {
      fontSize: base - 1.5,
      lineHeight: 1.2,
      borderRadius: 3,
      borderWidth: 0.5,
      borderColor: st.accent,
      color: st.accent,
      paddingHorizontal: 5,
      paddingTop: 2,
      paddingBottom: 0.8,
      marginRight: 3,
      marginBottom: 3,
    },
    skillCat: { fontWeight: 700, color: C.ink },
    add: { backgroundColor: C.add },
  });
}

type S = ReturnType<typeof makeStyles>;
type St = Styles[string] | (Styles[string] | false | undefined)[];

function T({ s, style, children }: { s: S; style?: St; children?: ReactNode }) {
  return (
    <Text style={[s.text, ...(Array.isArray(style) ? style : [style])].filter(Boolean) as Styles[string][]} hyphenationPenalty={NO_HYPHEN}>
      {children}
    </Text>
  );
}

/** [ADD: ...] 자리표시를 노란 배경으로 보인다(빈칸을 채워야 한다는 표시). */
function Rich({ s, text, style }: { s: S; text: string; style?: St }) {
  const parts = splitAddMarkers(text);
  if (parts.length <= 1 && !parts[0]?.add) return <T s={s} style={style}>{text}</T>;
  return (
    <T s={s} style={style}>
      {parts.map((p, i) =>
        p.add ? (
          <Text key={i} style={s.add}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </T>
  );
}

function Bullets({ s, items }: { s: S; items: string[] }) {
  const list = items.map((x) => x.trim()).filter(Boolean);
  return (
    <View>
      {list.map((it, i) => (
        <View key={i} style={s.bulletRow} wrap={false}>
          <T s={s} style={s.bulletDot}>
            •
          </T>
          <View style={{ flex: 1 }}>
            <Rich s={s} text={it} />
          </View>
        </View>
      ))}
    </View>
  );
}

const joinParts = (xs: string[], sep = " · ") => xs.map((x) => x.trim()).filter(Boolean).join(sep);

/**
 * 섹션의 항목 하나. 쪽 나눔은 웹 미리보기(src/lib/resumes/pagination.ts)와 같은 규칙:
 * 항목은 쪼개지 않고(wrap=false) 통째로 다음 쪽으로 넘기며, 한 쪽보다 클 수 있는 항목만 줄(불릿) 단위로 나눈다 —
 * @react-pdf는 쪼개지 않는 상자가 한 쪽보다 크면 잘라 버리기 때문이다.
 */
interface Item {
  el: ReactNode;
  /** 한 쪽을 넘을 수 있는 항목 판정에 쓰는 글(어림). */
  texts: string[];
}

/** 양식의 쪽 본문 크기(pt)와 열 폭. 웹 미리보기(ResumePreview geometry)와 같은 값. */
function pageBox(t: ResumeTemplate, narrow: boolean) {
  const compact = t.style.density === "compact";
  const padX = compact ? 34 : 42;
  const padY = compact ? 32 : 40;
  const content = A4.widthPt - padX * 2;
  const width = narrow ? 150 - 18 : t.style.layout === "sidebar" ? content - 150 - 16 : content;
  return { widthPt: width, fontPt: t.style.baseFontSize, lineHeight: compact ? 1.4 : 1.5, pageHeightPt: A4.heightPt - padY * 2 };
}

/** 섹션 제목은 첫 항목과 한 상자로 묶어 같은 쪽에 둔다(첫 항목이 한 쪽을 넘을 수 있으면 제목 뒤 몇 줄만 함께). */
function Section({ s, title, items, box }: { s: S; title: string; items: Item[]; box: ReturnType<typeof pageBox> }) {
  const [first, ...rest] = items;
  const head = (
    <View style={s.sectionHead} wrap={false}>
      <T s={s} style={s.sectionTitle}>
        {title}
      </T>
    </View>
  );
  const firstBig = first ? mayExceedPage(first.texts, { ...box, extraLines: 2 }) : false;
  return (
    <View style={s.section}>
      {first && !firstBig ? (
        <View wrap={false}>
          {head}
          {first.el}
        </View>
      ) : (
        <>
          <View minPresenceAhead={40} wrap={false}>
            {head}
          </View>
          {first ? <View wrap>{first.el}</View> : null}
        </>
      )}
      {rest.map((it, i) => (
        <View key={i} wrap={mayExceedPage(it.texts, box)}>
          {it.el}
        </View>
      ))}
    </View>
  );
}

function sectionItems({ s, doc, k, t, narrow }: { s: S; doc: ResumeDocument; k: ResumeSectionKey; t: ResumeTemplate; narrow: boolean }): Item[] {
  switch (k) {
    case "summary":
      return [{ el: <Rich s={s} text={doc.summary.trim()} />, texts: [doc.summary] }];
    case "highlights":
      // 성과 요약 한 줄 + 상세 성과 불릿.
      return doc.highlights
        .filter((h) => !isHighlightEmpty(h))
        .map((h, i) => ({
          el: (
            <View key={i} style={{ marginBottom: 4 }}>
              {h.title.trim() ? <Rich s={s} style={s.itemTitle} text={h.title} /> : null}
              <Bullets s={s} items={h.details} />
            </View>
          ),
          texts: [h.title, ...h.details],
        }));
    case "experience":
      return doc.experience
        .filter((e) => !isExperienceEmpty(e))
        .map((e, i) => ({
          el: (
            <View key={i} style={s.item}>
              <View style={s.itemHead} wrap={false}>
                <Rich s={s} style={[s.itemTitle, s.grow]} text={joinParts([e.company, e.title], " | ")} />
                <T s={s} style={s.itemPeriod}>
                  {period(e.startDate, e.endDate)}
                </T>
              </View>
              {joinParts([e.department, e.location]) ? <T s={s} style={s.itemSub}>{joinParts([e.department, e.location])}</T> : null}
              {e.scope.trim() ? <Rich s={s} text={e.scope} /> : null}
              <Bullets s={s} items={e.bullets} />
            </View>
          ),
          texts: [joinParts([e.company, e.title]), joinParts([e.department, e.location]), e.scope, ...e.bullets],
        }));
    case "projects":
      return doc.projects
        .filter((p) => !isProjectEmpty(p))
        .map((p, i) => ({
          el: (
            <View key={i} style={s.item}>
              <View style={s.itemHead} wrap={false}>
                <Rich s={s} style={[s.itemTitle, s.grow]} text={joinParts([p.name, p.role], " | ")} />
                <T s={s} style={s.itemPeriod}>
                  {period(p.startDate, p.endDate)}
                </T>
              </View>
              {joinParts([p.company, p.team]) ? <T s={s} style={s.itemSub}>{joinParts([p.company, p.team])}</T> : null}
              {p.summary.trim() ? <Rich s={s} style={s.itemSub} text={p.summary} /> : null}
              <Bullets s={s} items={[...projectStoryLines(p), ...p.bullets]} />
              {p.techs.some((x) => x.trim()) ? (
                <T s={s} style={s.itemSub}>
                  기술: {joinParts(p.techs, ", ")}
                </T>
              ) : null}
            </View>
          ),
          texts: [joinParts([p.name, p.role]), joinParts([p.company, p.team]), p.summary, ...projectStoryLines(p), ...p.bullets, p.techs.join(", ")],
        }));
    case "skills":
      return doc.skills
        .filter((g) => g.items.some((x) => x.trim()) || g.detail.trim())
        .map((g, i) => ({
          texts: [g.category, g.detail, g.items.join(", ")],
          el: t.style.skillChips ? (
            <View key={i} style={{ marginBottom: 4 }}>
              {g.category.trim() ? <T s={s} style={s.skillCat}>{g.category}</T> : null}
              {g.detail.trim() ? <T s={s} style={s.itemSub}>{g.detail}</T> : null}
              <View style={s.chips}>
                {g.items
                  .map((x) => x.trim())
                  .filter(Boolean)
                  .map((x, j) => (
                    <T key={j} s={s} style={s.chip}>
                      {x}
                    </T>
                  ))}
              </View>
            </View>
          ) : (
            <View key={i} style={narrow ? { marginBottom: 3 } : { flexDirection: "row", marginBottom: 2 }}>
              {g.category.trim() ? (
                <T s={s} style={[s.skillCat, narrow ? undefined : { width: 90 }]}>
                  {g.category}
                </T>
              ) : null}
              <View style={{ flex: 1 }}>
                <T s={s}>{joinParts([g.detail, joinParts(g.items, ", ")], " — ")}</T>
              </View>
            </View>
          ),
        }));
    case "education":
      return doc.education
        .filter((e) => e.school.trim() || e.major.trim())
        .map((e, i) => ({
          el: (
            <View key={i} style={s.item}>
              <T s={s} style={s.itemTitle}>
                {e.school}
              </T>
              <T s={s} style={s.itemSub}>
                {joinParts([e.degree, e.major, period(e.startDate, e.endDate)])}
              </T>
              {e.note.trim() ? <Rich s={s} text={e.note} /> : null}
            </View>
          ),
          texts: [e.school, e.major, e.note],
        }));
    case "certifications":
      return doc.certifications
        .filter((c) => c.name.trim())
        .map((c, i) => ({
          el: (
            <View key={i} style={{ marginBottom: 2 }}>
              <T s={s}>
                <Text style={{ fontWeight: 700 }}>{c.name}</Text>
                {joinParts([c.issuer, c.date]) ? ` — ${joinParts([c.issuer, c.date])}` : ""}
              </T>
            </View>
          ),
          texts: [c.name, c.issuer],
        }));
    case "extras":
      return doc.extras
        .filter((x) => x.title.trim() || x.items.some((v) => v.trim()))
        .map((x, i) => ({
          el: (
            <View key={i} style={s.item}>
              {x.title.trim() ? <T s={s} style={s.itemTitle}>{x.title}</T> : null}
              <Bullets s={s} items={x.items} />
            </View>
          ),
          texts: [x.title, ...x.items],
        }));
    case "motivation":
      // 문단마다 항목(긴 지원 동기는 문단 사이에서 쪽이 나뉜다 — 웹 미리보기와 같다).
      return motivationParagraphs(doc.motivation).map((para, i) => ({
        el: (
          <View key={i} style={{ marginBottom: 4 }}>
            <Rich s={s} text={para} />
          </View>
        ),
        texts: [para],
      }));
  }
}

function ResumePdfDocument({ doc, templateId, photo }: { doc: ResumeDocument; templateId: ResumeTemplateId; photo: string | null }) {
  const t = RESUME_TEMPLATES[templateId];
  const s = makeStyles(t);
  const layout = resumeLayout(doc, templateId);
  const b = doc.basics;
  const contact = joinParts([b.email, b.phone, b.location, b.portfolioUrl], "  |  ");
  const links = b.links.filter((l) => l.url.trim());
  const sideLinks = layout.side.length > 0;
  const headline = joinParts([b.headline, b.totalExperience.trim() ? `총 경력 ${b.totalExperience.trim()}` : ""], "  ·  ");
  // 한 줄 소개는 지원 직무 줄이 아니라 머리글 선 아래(사이드바 양식은 본문 열 맨 위)에 따로 둔다.
  const tagline = (top: number) =>
    b.tagline.trim() ? <Rich s={s} style={[s.tagline, { marginTop: top }]} text={b.tagline} /> : null;

  const headerText = (
    <>
      <Rich s={s} style={s.name} text={b.name.trim() || "이름"} />
      {headline ? <Rich s={s} style={s.headline} text={headline} /> : null}
      {contact ? <T s={s} style={s.contact}>{contact}</T> : null}
      {!sideLinks && links.length > 0 ? (
        <T s={s} style={s.contact}>
          {links.map((l) => joinParts([l.label, l.url], ": ")).join("  |  ")}
        </T>
      ) : null}
    </>
  );
  // 사진은 서버가 읽은 data URI만 받는다(공개 주소를 열지 않는다).
  const header = photo ? (
    <View style={s.headerBand} wrap={false}>
      <View style={s.headerRow}>
        <View style={s.headerText}>{headerText}</View>
        {/* eslint-disable-next-line jsx-a11y/alt-text -- react-pdf Image에는 alt가 없다 */}
        <Image style={s.photo} src={photo} />
      </View>
    </View>
  ) : (
    <View style={s.headerBand}>{headerText}</View>
  );

  const mainSections = layout.main.map((k) => (
    <Section key={k} s={s} title={sectionTitle(doc, k)} box={pageBox(t, false)} items={sectionItems({ s, doc, k, t, narrow: false })} />
  ));

  return (
    <Document title={`${b.name || "이력서"} 이력서`} author={b.name || undefined} creator={SERVICE_CREDIT} producer={SERVICE_CREDIT}>
      <Page size="A4" style={s.page} wrap>
        {header}
        {layout.side.length > 0 ? (
          <View style={s.columns}>
            <View style={s.side}>
              {links.length > 0 ? (
                <View style={s.section}>
                  <View style={s.sectionHead}>
                    <T s={s} style={s.sectionTitle}>
                      링크
                    </T>
                  </View>
                  {links.map((l, i) => (
                    <T key={i} s={s} style={s.itemSub}>
                      {joinParts([l.label, l.url], ": ")}
                    </T>
                  ))}
                </View>
              ) : null}
              {layout.side.map((k) => (
                <Section key={k} s={s} title={sectionTitle(doc, k)} box={pageBox(t, true)} items={sectionItems({ s, doc, k, t, narrow: true })} />
              ))}
            </View>
            <View style={s.main}>
              {tagline(0)}
              {mainSections}
            </View>
          </View>
        ) : (
          <>
            {tagline(4 * (t.style.density === "compact" ? 0.6 : 1))}
            {mainSections}
          </>
        )}
      </Page>
    </Document>
  );
}

/**
 * opts.photo: 머리글에 넣을 프로필 사진(data:image/jpeg;base64,… — 서버가 저장소에서 읽은 것만). 없으면 사진 없이.
 */
export async function renderResumePdf(
  doc: ResumeDocument,
  templateId: ResumeTemplateId,
  opts: { photo?: string | null } = {},
): Promise<Uint8Array> {
  registerResumeFonts();
  const photo = opts.photo && /^data:image\/(jpeg|png);base64,/.test(opts.photo) ? opts.photo : null;
  const el =
    templateId === "performance" ? (
      <PerformancePdfDocument doc={doc} photo={photo} />
    ) : (
      <ResumePdfDocument doc={doc} templateId={templateId} photo={photo} />
    );
  const buf = await renderToBuffer(el);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
