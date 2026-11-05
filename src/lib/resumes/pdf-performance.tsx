/**
 * 성과 중심 양식 PDF(@react-pdf/renderer). 원본 템플릿(docs/reference/resume-template-performance.html)과
 * 웹 시트(src/components/resumes/performance-sheet.css)의 값을 pt로 옮겼다(1px = 0.75pt, 글자 크기는 원본이 pt).
 *
 * - 빈 칸·빈 항목은 찍지 않는다(원본 인쇄에서 :empty 안내 문구를 숨기는 것과 같다).
 * - 쪽 나눔: 섹션을 '항목 한 줄(왼쪽 라벨 칸 + 오른쪽 항목)'의 묶음으로 그린다. 항목 한 줄은 쪼개지지 않고(wrap=false),
 *   섹션 제목은 언제나 첫 항목과 같은 줄에 있어 제목만 앞 쪽에 남지 않는다(원본 break-inside/after: avoid).
 */
import type { ReactNode } from "react";
import { Document, Page, StyleSheet, Text, View, type Styles } from "@react-pdf/renderer";
import type { ResumeDocument } from "@/lib/domain/resumes";
import { isExperienceEmpty, isProjectEmpty, performanceHeading, splitAddMarkers } from "./layout";
import { NO_HYPHEN, PDF_FONT } from "./pdf-fonts";

const C = {
  ink: "#20262e",
  muted: "#596574",
  accent: "#264e77",
  line: "#d9e0e7",
  intro: "#364352",
  skill: "#42505f",
  add: "#fef08a",
};
const px = (v: number) => v * 0.75;
const mm = (v: number) => (v * 72) / 25.4;

const st = StyleSheet.create({
  page: {
    fontFamily: PDF_FONT,
    fontSize: 10,
    lineHeight: 1.6,
    color: C.ink,
    paddingTop: mm(15),
    paddingBottom: mm(15),
    paddingHorizontal: mm(16),
  },
  header: { paddingBottom: px(17) },
  identityRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-start",
  },
  identityMain: { flex: 1, marginRight: px(25) },
  name: {
    fontSize: 30,
    fontWeight: 800,
    lineHeight: 1.2,
    letterSpacing: -0.8,
    marginBottom: px(8),
  },
  role: { fontSize: 13, lineHeight: 1.45, fontWeight: 700, color: C.accent },
  experience: { fontSize: 9, fontWeight: 400, color: C.muted },
  contact: { maxWidth: px(250), paddingTop: px(3) },
  contactLine: {
    fontSize: 8.5,
    lineHeight: 1.85,
    color: C.muted,
    textAlign: "right",
  },
  intro: { marginTop: px(16), fontSize: 10, lineHeight: 1.7, color: C.intro },

  row: { flexDirection: "row" },
  label: { width: px(78), marginRight: px(20) },
  labelText: {
    fontSize: 9.5,
    lineHeight: 1.6,
    fontWeight: 700,
    color: C.accent,
    paddingTop: px(1),
  },
  content: { flex: 1 },
  sectionFirst: {
    borderTopWidth: 0.75,
    borderTopColor: C.line,
    paddingTop: px(17),
  },
  sectionEnd: { height: px(16) },

  highlightTitle: { fontSize: 10, lineHeight: 1.55, fontWeight: 700 },
  highlightContext: {
    fontSize: 8.5,
    lineHeight: 1.6,
    color: C.muted,
    marginTop: px(1),
  },

  entryHead: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
  },
  entryTitle: {
    flex: 1,
    fontSize: 10.5,
    lineHeight: 1.5,
    fontWeight: 700,
    marginRight: px(18),
  },
  period: { fontSize: 8, color: C.muted, lineHeight: 1.6 },
  entryMeta: {
    fontSize: 8.5,
    color: C.muted,
    marginTop: px(2),
    marginBottom: px(5),
  },
  para: { fontSize: 9.3, lineHeight: 1.62, marginVertical: px(3) },
  bulletRow: {
    flexDirection: "row",
    marginVertical: px(3),
    paddingLeft: px(3),
  },
  bulletDot: { width: px(11), fontSize: 9.3, lineHeight: 1.6 },
  bulletText: { flex: 1, fontSize: 9.3, lineHeight: 1.6 },

  detail: { flexDirection: "row", marginVertical: px(4) },
  dt: {
    width: px(26),
    marginRight: px(8),
    fontSize: 9.3,
    lineHeight: 1.62,
    fontWeight: 700,
    color: C.muted,
  },
  dd: { flex: 1, fontSize: 9.3, lineHeight: 1.62 },
  ddResult: { fontWeight: 700, color: C.ink },
  evidence: { fontSize: 8, color: C.muted, marginTop: px(5) },

  skillName: {
    width: px(92),
    marginRight: px(12),
    fontSize: 9,
    lineHeight: 1.6,
    fontWeight: 700,
  },
  skillDetail: { flex: 1, fontSize: 9, lineHeight: 1.6, color: C.skill },

  eduTitle: { flex: 1, fontSize: 9, lineHeight: 1.6, marginRight: px(18) },

  add: { backgroundColor: C.add },
});

type St = Styles[string] | (Styles[string] | false | undefined | null)[];
const flat = (style?: St) => (Array.isArray(style) ? style : [style]).filter(Boolean) as Styles[string][];
const has = (v: string) => v.trim().length > 0;
const join = (xs: string[], sep = " · ") =>
  xs
    .map((x) => x.trim())
    .filter(Boolean)
    .join(sep);
/** 원본처럼 "시작 - 끝". */
const span = (a: string, b: string) => join([a, b], " - ");

/** [ADD: ...] 자리표시는 노란 배경(채워야 할 칸). */
function R({ text, style }: { text: string; style?: St }) {
  const parts = splitAddMarkers(text.trim());
  return (
    <Text style={flat(style)} hyphenationPenalty={NO_HYPHEN}>
      {parts.map((p, i) =>
        p.add ? (
          <Text key={i} style={st.add}>
            {p.text}
          </Text>
        ) : (
          p.text
        ),
      )}
    </Text>
  );
}

/** 섹션의 한 줄: 첫 줄만 위 테두리·라벨을 갖는다. 줄 하나는 쪼개지지 않는다. */
function SectionRow({ label, first, gap, children }: { label: string; first: boolean; gap: number; children: Row }) {
  return (
    <View style={flat([st.row, first ? st.sectionFirst : { marginTop: gap }])} wrap={children.breakable}>
      <View style={st.label}>{first ? <R style={st.labelText} text={label} /> : null}</View>
      <View style={st.content}>{children.el}</View>
    </View>
  );
}

/**
 * 섹션의 항목 한 줄. 보통은 쪼개지 않지만, 한 쪽보다 길 수 있는 항목(글자가 아주 많음)은 쪼갤 수 있게 둔다 —
 * 쪼갤 수 없는 상자가 한 쪽을 넘으면 잘리기 때문이다.
 */
interface Row {
  el: ReactNode;
  breakable: boolean;
}
const BREAKABLE_CHARS = 1600;
const row = (el: ReactNode, ...texts: (string | string[])[]): Row => ({
  el,
  breakable: texts.flat().reduce((n, t) => n + t.length, 0) > BREAKABLE_CHARS,
});

function Section({ label, gap, rows, last }: { label: string; gap: number; rows: Row[]; last: boolean }) {
  if (rows.length === 0) return null;
  return (
    <View>
      {rows.map((r, i) => (
        <SectionRow key={i} label={label} first={i === 0} gap={gap}>
          {r}
        </SectionRow>
      ))}
      {last ? null : <View style={st.sectionEnd} />}
    </View>
  );
}

function EntryHead({ title, when, titleStyle }: { title: string; when: string; titleStyle?: St }) {
  return (
    <View style={st.entryHead}>
      <R style={flat([st.entryTitle, ...(Array.isArray(titleStyle) ? titleStyle : [titleStyle])])} text={title} />
      {has(when) ? <R style={st.period} text={when} /> : null}
    </View>
  );
}

export function PerformancePdfDocument({ doc }: { doc: ResumeDocument }) {
  const b = doc.basics;
  const contact = [b.email, b.phone, b.portfolioUrl].filter(has);

  const highlightRows = doc.highlights
    .filter((h) => has(h.title) || has(h.context))
    .map((h, i) =>
      row(
        <View key={i}>
          {has(h.title) ? <R style={st.highlightTitle} text={h.title} /> : null}
          {has(h.context) ? <R style={st.highlightContext} text={h.context} /> : null}
        </View>,
      ),
    );

  const experienceRows = doc.experience
    .filter((e) => !isExperienceEmpty(e))
    .map((e, i) =>
      row(
        <View key={i}>
          <EntryHead title={e.company} when={span(e.startDate, e.endDate)} />
          {has(join([e.department, e.title])) ? <R style={st.entryMeta} text={join([e.department, e.title])} /> : null}
          {has(e.scope) ? <R style={st.para} text={e.scope} /> : null}
          {e.bullets.filter(has).map((x, j) => (
            <View key={j} style={st.bulletRow} wrap={false}>
              <Text style={st.bulletDot}>•</Text>
              <R style={st.bulletText} text={x} />
            </View>
          ))}
        </View>,
        e.scope,
        e.bullets,
      ),
    );

  const projectRows = doc.projects
    .filter((p) => !isProjectEmpty(p))
    .map((p, i) => {
      const meta = join([p.company, p.team, has(p.role) ? `내 역할: ${p.role.trim()}` : ""]);
      const details = (
        [
          ["문제", p.problem, false],
          ["행동", p.action, false],
          ["결과", p.result, true],
        ] as const
      ).filter(([, v]) => has(v));
      return row(
        <View key={i}>
          <EntryHead title={p.name} when={span(p.startDate, p.endDate)} />
          {has(meta) ? <R style={[st.entryMeta, { marginBottom: px(7) }]} text={meta} /> : null}
          {has(p.summary) ? <R style={st.para} text={p.summary} /> : null}
          {details.map(([dt, v, result]) => (
            <View key={dt} style={st.detail} wrap={false}>
              <Text style={st.dt}>{dt}</Text>
              <R style={[st.dd, result && st.ddResult]} text={v} />
            </View>
          ))}
          {p.bullets.filter(has).map((x, j) => (
            <View key={j} style={st.bulletRow} wrap={false}>
              <Text style={st.bulletDot}>•</Text>
              <R style={st.bulletText} text={x} />
            </View>
          ))}
          {has(p.evidence) ? <R style={st.evidence} text={`근거: ${p.evidence.trim()}`} /> : null}
        </View>,
        [p.summary, p.problem, p.action, p.result],
        p.bullets,
      );
    });

  const skillRows = doc.skills
    .filter((s) => has(s.category) || has(s.detail) || s.items.some(has))
    .map((s, i) =>
      row(
        <View key={i} style={st.row}>
          <R style={st.skillName} text={s.category} />
          <R style={st.skillDetail} text={has(s.detail) ? s.detail : join(s.items, ", ")} />
        </View>,
      ),
    );

  const educationRows = [
    ...doc.education
      .filter((e) => has(e.school) || has(e.major) || has(e.degree))
      .map((e, i) =>
        row(
          <EntryHead
            key={`e${i}`}
            title={join([join([e.school, e.major], " "), e.degree])}
            when={span(e.startDate, e.endDate)}
            titleStyle={st.eduTitle}
          />,
        ),
      ),
    ...doc.certifications
      .filter((c) => has(c.name))
      .map((c, i) => row(<EntryHead key={`c${i}`} title={join([c.name, c.issuer])} when={c.date} titleStyle={st.eduTitle} />)),
  ];

  const extras = doc.extras
    .filter((x) => has(x.title) || x.items.some(has))
    .map((x) => ({
      label: x.title.trim() || "기타",
      rows: x.items.filter(has).map((v, j) =>
        row(
          <View key={j} style={st.bulletRow} wrap={false}>
            <Text style={st.bulletDot}>•</Text>
            <R style={st.bulletText} text={v} />
          </View>,
        ),
      ),
    }));

  const sections = [
    {
      label: performanceHeading(doc, "highlights"),
      gap: px(9),
      rows: highlightRows,
    },
    {
      label: performanceHeading(doc, "experience"),
      gap: px(15),
      rows: experienceRows,
    },
    {
      label: performanceHeading(doc, "projects"),
      gap: px(16),
      rows: projectRows,
    },
    { label: performanceHeading(doc, "skills"), gap: px(5), rows: skillRows },
    {
      label: performanceHeading(doc, "education"),
      gap: px(7),
      rows: educationRows,
    },
    ...extras.map((x) => ({ label: x.label, gap: 0, rows: x.rows })),
  ].filter((s) => s.rows.length > 0);

  return (
    <Document
      title={`${b.name.trim() || "이력서"} 이력서`}
      author={b.name.trim() || undefined}
      creator="이력서 심사위원단"
      producer="이력서 심사위원단"
    >
      <Page size="A4" style={st.page} wrap>
        <View style={st.header} wrap={false}>
          <View style={st.identityRow}>
            <View style={st.identityMain}>
              {has(b.name) ? <R style={st.name} text={b.name} /> : null}
              {has(b.headline) || has(b.totalExperience) ? (
                <Text style={st.role} hyphenationPenalty={NO_HYPHEN}>
                  {b.headline.trim()}
                  {has(b.totalExperience) ? (
                    <Text style={st.experience}>{`${has(b.headline) ? "   " : ""}총 경력 ${b.totalExperience.trim()}`}</Text>
                  ) : null}
                </Text>
              ) : null}
            </View>
            {contact.length > 0 ? (
              <View style={st.contact}>
                {contact.map((c, i) => (
                  <R key={i} style={st.contactLine} text={c} />
                ))}
              </View>
            ) : null}
          </View>
          {has(doc.summary) ? <R style={st.intro} text={doc.summary} /> : null}
        </View>
        {sections.map((s, i) => (
          <Section key={i} label={s.label} gap={s.gap} rows={s.rows} last={i === sections.length - 1} />
        ))}
      </Page>
    </Document>
  );
}
