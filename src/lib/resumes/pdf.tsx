/**
 * 회사별 이력서 PDF 렌더러. ResumeDocument + 양식(섹션 순서·스타일 토큰) → A4 PDF.
 * 한글 폰트는 보고서 PDF와 같은 NanumGothic 파일(src/lib/report/fonts, pdf-fonts.ts)을 쓴다. Node 런타임 전용.
 * 섹션 배치(빈 섹션 제외·사이드바)는 웹 미리보기와 같은 resumeLayout을 쓴다. 성과 중심 양식은 pdf-performance.tsx.
 */
import type { ReactNode } from "react";
import { Document, Page, StyleSheet, Text, View, renderToBuffer, type Styles } from "@react-pdf/renderer";
import {
  RESUME_TEMPLATES,
  type ResumeDocument,
  type ResumeSectionKey,
  type ResumeTemplate,
  type ResumeTemplateId,
} from "@/lib/domain/resumes";
import { period, projectStoryLines, resumeLayout, sectionTitle, splitAddMarkers } from "./layout";
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

function Section({ s, title, children }: { s: S; title: string; children: ReactNode }) {
  return (
    <View style={s.section}>
      <View style={s.sectionHead} minPresenceAhead={40} wrap={false}>
        <T s={s} style={s.sectionTitle}>
          {title}
        </T>
      </View>
      {children}
    </View>
  );
}

function SectionBody({ s, doc, k, t, narrow }: { s: S; doc: ResumeDocument; k: ResumeSectionKey; t: ResumeTemplate; narrow: boolean }) {
  switch (k) {
    case "summary":
      return <Rich s={s} text={doc.summary.trim()} />;
    case "highlights":
      return (
        <View>
          {doc.highlights
            .filter((h) => h.title.trim() || h.context.trim())
            .map((h, i) => (
              <View key={i} style={{ marginBottom: 4 }} wrap={false}>
                <Rich s={s} style={s.itemTitle} text={h.title} />
                {h.context.trim() ? <Rich s={s} style={s.itemSub} text={h.context} /> : null}
              </View>
            ))}
        </View>
      );
    case "experience":
      return (
        <View>
          {doc.experience.map((e, i) => (
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
          ))}
        </View>
      );
    case "projects":
      return (
        <View>
          {doc.projects.map((p, i) => (
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
              {p.evidence.trim() ? <T s={s} style={s.itemSub}>근거: {p.evidence}</T> : null}
              {p.techs.some((x) => x.trim()) ? (
                <T s={s} style={s.itemSub}>
                  기술: {joinParts(p.techs, ", ")}
                </T>
              ) : null}
            </View>
          ))}
        </View>
      );
    case "skills":
      return (
        <View>
          {doc.skills
            .filter((g) => g.items.some((x) => x.trim()) || g.detail.trim())
            .map((g, i) =>
              t.style.skillChips ? (
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
            )}
        </View>
      );
    case "education":
      return (
        <View>
          {doc.education.filter((e) => e.school.trim() || e.major.trim()).map((e, i) => (
            <View key={i} style={s.item} wrap={false}>
              <T s={s} style={s.itemTitle}>
                {e.school}
              </T>
              <T s={s} style={s.itemSub}>
                {joinParts([e.degree, e.major, period(e.startDate, e.endDate)])}
              </T>
              {e.note.trim() ? <Rich s={s} text={e.note} /> : null}
            </View>
          ))}
        </View>
      );
    case "certifications":
      return (
        <View>
          {doc.certifications.filter((c) => c.name.trim()).map((c, i) => (
            <View key={i} style={{ marginBottom: 2 }} wrap={false}>
              <T s={s}>
                <Text style={{ fontWeight: 700 }}>{c.name}</Text>
                {joinParts([c.issuer, c.date]) ? ` — ${joinParts([c.issuer, c.date])}` : ""}
              </T>
            </View>
          ))}
        </View>
      );
    case "extras":
      return (
        <View>
          {doc.extras.map((x, i) => (
            <View key={i} style={s.item}>
              {x.title.trim() ? <T s={s} style={s.itemTitle}>{x.title}</T> : null}
              <Bullets s={s} items={x.items} />
            </View>
          ))}
        </View>
      );
  }
}

function ResumePdfDocument({ doc, templateId }: { doc: ResumeDocument; templateId: ResumeTemplateId }) {
  const t = RESUME_TEMPLATES[templateId];
  const s = makeStyles(t);
  const layout = resumeLayout(doc, templateId);
  const b = doc.basics;
  const contact = joinParts([b.email, b.phone, b.location, b.portfolioUrl], "  |  ");
  const links = b.links.filter((l) => l.url.trim());
  const sideLinks = layout.side.length > 0;

  const header = (
    <View style={s.headerBand}>
      <Rich s={s} style={s.name} text={b.name.trim() || "이름"} />
      {b.headline.trim() ? (
        <Rich s={s} style={s.headline} text={b.totalExperience.trim() ? `${b.headline}  ·  총 경력 ${b.totalExperience.trim()}` : b.headline} />
      ) : null}
      {contact ? <T s={s} style={s.contact}>{contact}</T> : null}
      {!sideLinks && links.length > 0 ? (
        <T s={s} style={s.contact}>
          {links.map((l) => joinParts([l.label, l.url], ": ")).join("  |  ")}
        </T>
      ) : null}
    </View>
  );

  const mainSections = layout.main.map((k) => (
    <Section key={k} s={s} title={sectionTitle(doc, k)}>
      <SectionBody s={s} doc={doc} k={k} t={t} narrow={false} />
    </Section>
  ));

  return (
    <Document title={`${b.name || "이력서"} 이력서`} author={b.name || undefined} creator="이력서 심사위원단" producer="이력서 심사위원단">
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
                <Section key={k} s={s} title={sectionTitle(doc, k)}>
                  <SectionBody s={s} doc={doc} k={k} t={t} narrow />
                </Section>
              ))}
            </View>
            <View style={s.main}>{mainSections}</View>
          </View>
        ) : (
          mainSections
        )}
      </Page>
    </Document>
  );
}

export async function renderResumePdf(doc: ResumeDocument, templateId: ResumeTemplateId): Promise<Uint8Array> {
  registerResumeFonts();
  const el = templateId === "performance" ? <PerformancePdfDocument doc={doc} /> : <ResumePdfDocument doc={doc} templateId={templateId} />;
  const buf = await renderToBuffer(el);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
