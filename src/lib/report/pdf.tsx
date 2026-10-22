/**
 * PDF 보고서 렌더러. ReportModel만 보고 A4 보고서를 만든다(섹션 순서는 ARCHITECTURE §8, 웹 보고서와 동일).
 * Node 런타임 전용 — next.config.ts의 serverExternalPackages에 @react-pdf/renderer가 들어 있어야 한다.
 */
import path from "node:path";
import type { ReactNode } from "react";
import {
  Document,
  Font,
  Page,
  StyleSheet,
  Text,
  View,
  renderToBuffer,
  type Styles,
} from "@react-pdf/renderer";
import type { VerdictTone } from "@/lib/domain/reviewers";
import type { AtsResult, Requirement } from "@/lib/domain/schemas";
import type { CheckedQuote, ReportModel, ReviewerCard, VerdictView } from "./types";

// ---------------------------------------------------------------------------
// 폰트 · 줄바꿈
// ---------------------------------------------------------------------------

const FONT = "NanumGothic";
let fontsRegistered = false;

function registerFonts() {
  if (fontsRegistered) return;
  // Next 서버와 vitest 모두 프로젝트 루트를 cwd로 실행한다(ESM이라 __dirname을 쓰지 않는다).
  const dir = path.join(process.cwd(), "src", "lib", "report", "fonts");
  Font.register({
    family: FONT,
    fonts: [
      { src: path.join(dir, "NanumGothic-Regular.ttf"), fontWeight: 400 },
      { src: path.join(dir, "NanumGothic-Bold.ttf"), fontWeight: 700 },
      { src: path.join(dir, "NanumGothic-ExtraBold.ttf"), fontWeight: 800 },
    ],
  });
  Font.registerHyphenationCallback(splitForWrap);
  fontsRegistered = true;
}

const HANGUL_OR_CJK = /[ᄀ-ᇿ぀-ヿ㄰-㆏㐀-鿿가-힯]/;

/**
 * 영어식 하이픈 분절을 끄고, 너무 긴 '단어'(띄어쓰기 없는 한글, URL 등)만 글자 단위로 끊을 수 있게 한다.
 * 글자 사이의 빈 문자열은 폭 0의 glue가 되어 하이픈 없이 줄바꿈된다.
 * 하이픈 삽입 지점(penalty)은 T 컴포넌트에서 hyphenationPenalty=무한대로 막는다.
 */
export function splitForWrap(word: string): string[] {
  const limit = HANGUL_OR_CJK.test(word) ? 10 : 24;
  const chars = Array.from(word);
  if (chars.length <= limit) return [word];
  const out: string[] = [];
  for (const c of chars) out.push(c, "");
  out.pop();
  return out;
}

const NO_HYPHEN = 10000;

// ---------------------------------------------------------------------------
// 디자인 토큰
// ---------------------------------------------------------------------------

const C = {
  ink: "#111827",
  body: "#1f2937",
  muted: "#6b7280",
  faint: "#9ca3af",
  line: "#e5e7eb",
  panel: "#f8fafc",
  accent: "#1e3a8a",
  accentSoft: "#eef2ff",
  pos: "#047857",
  posSoft: "#ecfdf5",
  neu: "#b45309",
  neuSoft: "#fffbeb",
  neg: "#b91c1c",
  negSoft: "#fef2f2",
  add: "#fef08a",
};

const TONE: Record<VerdictTone, { fg: string; bg: string; bd: string }> = {
  positive: { fg: C.pos, bg: C.posSoft, bd: "#a7f3d0" },
  neutral: { fg: C.neu, bg: C.neuSoft, bd: "#fde68a" },
  negative: { fg: C.neg, bg: C.negSoft, bd: "#fecaca" },
};

const FIT_STATUS = {
  met: { label: "충족", tone: "positive" },
  partial: { label: "부분", tone: "neutral" },
  missing: { label: "미충족", tone: "negative" },
} as const;

const SEVERITY = {
  critical: { label: "치명", tone: "negative" },
  major: { label: "주요", tone: "neutral" },
  minor: { label: "경미", tone: "positive" },
} as const;

const LEVEL = { high: "높음", medium: "중간", low: "낮음" } as const;

const CATEGORY: Record<Requirement["category"], string> = {
  skill: "기술",
  experience: "경력",
  education: "학력",
  domain: "도메인",
  soft: "소프트",
  other: "기타",
};

const s = StyleSheet.create({
  // lineHeight 배수는 같은 노드의 fontSize로 계산되므로(상속 전 기본 18pt) 기본 크기를 함께 둔다.
  text: { fontSize: 9.5, lineHeight: 1.55 },
  page: {
    fontFamily: FONT,
    fontSize: 9.5,
    color: C.body,
    paddingTop: 56,
    paddingBottom: 54,
    paddingHorizontal: 44,
  },
  // 주의: render prop을 쓰는 고정 요소와 그 조상에 lineHeight·height를 주면 react-pdf 4.9가 그리지 못한다.
  headerWrap: { position: "absolute", top: 22, left: 44, right: 44 },
  header: {
    flexDirection: "row",
    justifyContent: "space-between",
    borderBottomWidth: 0.5,
    borderBottomColor: C.line,
    paddingBottom: 5,
    fontSize: 7.5,
    color: C.faint,
  },
  footer: {
    position: "absolute",
    bottom: 22,
    left: 44,
    right: 44,
    flexDirection: "row",
    justifyContent: "space-between",
    fontSize: 7.5,
    color: C.faint,
  },
  // 표지
  coverBand: { backgroundColor: C.accent, marginHorizontal: -44, marginTop: -56, paddingHorizontal: 44, paddingTop: 40, paddingBottom: 22 },
  coverKicker: { color: "#c7d2fe", fontSize: 9, fontWeight: 700, letterSpacing: 1 },
  coverTitle: { color: "#ffffff", fontSize: 24, fontWeight: 800, marginTop: 8, lineHeight: 1.3 },
  coverMeta: { color: "#e0e7ff", fontSize: 9.5, marginTop: 10 },
  statRow: { flexDirection: "row", marginTop: 16, marginBottom: 12 },
  statCard: { flex: 1, borderWidth: 0.75, borderColor: C.line, borderRadius: 6, padding: 12, marginRight: 8 },
  statLabel: { fontSize: 8, color: C.muted, fontWeight: 700 },
  statBig: { fontSize: 26, fontWeight: 800, color: C.ink, marginTop: 4, lineHeight: 1.2 },
  statSub: { fontSize: 8, color: C.muted, marginTop: 2 },
  barTrack: { height: 5, backgroundColor: C.line, borderRadius: 3, marginTop: 6 },
  headlineBox: { backgroundColor: C.accentSoft, borderLeftWidth: 3, borderLeftColor: C.accent, padding: 12, marginBottom: 12 },
  headline: { fontSize: 12.5, fontWeight: 700, color: C.ink, lineHeight: 1.5 },
  // 섹션
  section: { marginTop: 18 },
  sectionHead: { flexDirection: "row", alignItems: "center", borderBottomWidth: 1.25, borderBottomColor: C.accent, paddingBottom: 5, marginBottom: 10 },
  sectionNo: { fontSize: 9, fontWeight: 800, color: "#ffffff", backgroundColor: C.accent, borderRadius: 3, paddingHorizontal: 5, paddingVertical: 1, marginRight: 7 },
  sectionTitle: { fontSize: 14.5, fontWeight: 800, color: C.ink },
  h3: { fontSize: 10.5, fontWeight: 700, color: C.ink, marginTop: 10, marginBottom: 4 },
  p: { marginBottom: 4 },
  muted: { color: C.muted },
  small: { fontSize: 8 },
  bold: { fontWeight: 700 },
  // 표
  table: { borderWidth: 0.75, borderColor: C.line, borderRadius: 4 },
  tr: { flexDirection: "row", borderTopWidth: 0.5, borderTopColor: C.line },
  th: { flexDirection: "row", backgroundColor: C.panel },
  thCell: { fontSize: 8, fontWeight: 700, color: C.muted, padding: 6 },
  td: { padding: 6 },
  // 조각
  badge: { fontSize: 7.5, fontWeight: 700, borderRadius: 3, paddingHorizontal: 5, paddingTop: 2.2, paddingBottom: 0.8, alignSelf: "flex-start", textAlign: "center", lineHeight: 1.2 },
  chips: { flexDirection: "row", flexWrap: "wrap", marginTop: 2, marginBottom: 4 },
  chip: { fontSize: 8, lineHeight: 1.2, borderRadius: 3, borderWidth: 0.5, paddingHorizontal: 6, paddingTop: 2.5, paddingBottom: 1, marginRight: 4, marginBottom: 4 },
  quote: { borderLeftWidth: 2, borderLeftColor: C.faint, backgroundColor: C.panel, paddingVertical: 4, paddingHorizontal: 7, marginVertical: 3, color: C.ink },
  card: { borderWidth: 0.75, borderColor: C.line, borderRadius: 5, padding: 10, marginBottom: 8 },
  bulletRow: { flexDirection: "row", marginBottom: 2.5 },
  bulletDot: { width: 10, color: C.accent, fontWeight: 700 },
  note: { borderWidth: 0.75, borderColor: "#fcd34d", backgroundColor: C.neuSoft, borderRadius: 4, padding: 8, marginBottom: 10, fontSize: 8.5, color: "#78350f" },
  // 재작성 이력서
  resumeBox: { borderWidth: 0.75, borderColor: C.line, borderRadius: 5, paddingVertical: 14, paddingHorizontal: 18 },
  mdH1: { fontSize: 15, fontWeight: 800, color: C.ink, marginBottom: 4 },
  mdH2: { fontSize: 11, fontWeight: 800, color: C.accent, marginTop: 10, marginBottom: 3, paddingBottom: 2, borderBottomWidth: 0.5, borderBottomColor: C.line },
  mdH3: { fontSize: 10, fontWeight: 700, color: C.ink, marginTop: 6, marginBottom: 2 },
});

// ---------------------------------------------------------------------------
// 기본 조각
// ---------------------------------------------------------------------------

type St = Styles[string] | (Styles[string] | false | undefined)[];

/** 한국어 줄바꿈 규칙(하이픈 금지)을 적용한 Text. */
function T({
  style,
  children,
  ...rest
}: {
  style?: St;
  children?: ReactNode;
  minPresenceAhead?: number;
  wrap?: boolean;
}) {
  return (
    <Text style={[s.text, ...(Array.isArray(style) ? style : [style])].filter(Boolean) as Styles[string][]} hyphenationPenalty={NO_HYPHEN} {...rest}>
      {children}
    </Text>
  );
}

function Badge({ tone, children }: { tone: VerdictTone; children: ReactNode }) {
  return <T style={[s.badge, { color: TONE[tone].fg, backgroundColor: TONE[tone].bg }]}>{children}</T>;
}

function VerdictBadge({ v }: { v: VerdictView }) {
  return <Badge tone={v.tone}>{v.label}</Badge>;
}

function Bullets({ items, color }: { items: string[]; color?: string }) {
  if (items.length === 0) return <T style={s.muted}>없음</T>;
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={s.bulletRow} wrap={false}>
          <T style={[s.bulletDot, color ? { color } : undefined]}>•</T>
          <T style={{ flex: 1 }}>{it}</T>
        </View>
      ))}
    </View>
  );
}

function Chips({ items, tone }: { items: string[]; tone: VerdictTone | "plain" }) {
  if (items.length === 0) return <T style={[s.muted, s.small]}>없음</T>;
  const c = tone === "plain" ? { fg: C.body, bg: "#ffffff", bd: "#d1d5db" } : { ...TONE[tone], bd: TONE[tone].bd };
  return (
    <View style={s.chips}>
      {items.map((k, i) => (
        <T key={i} style={[s.chip, { color: c.fg, backgroundColor: c.bg, borderColor: c.bd }]}>
          {k}
        </T>
      ))}
    </View>
  );
}

function Quote({ q }: { q: CheckedQuote }) {
  return (
    <View style={s.quote} wrap={false}>
      <T>“{q.text.trim().replace(/^([-*•·▪]|\d+[.)])\s+/, "")}”</T>
      {!q.verified && <T style={[s.small, { color: C.neg, marginTop: 2 }]}>원문에서 찾지 못함 — 원문 확인 필요</T>}
    </View>
  );
}

function QuotedIssues({ items }: { items: { quote: CheckedQuote; issue: string }[] }) {
  if (items.length === 0) return <T style={s.muted}>없음</T>;
  return (
    <View>
      {items.map((it, i) => (
        <View key={i} style={{ marginBottom: 5 }} wrap={false}>
          <Quote q={it.quote} />
          <T>{it.issue}</T>
        </View>
      ))}
    </View>
  );
}

function Section({ no, title, children, breakBefore }: { no: number; title: string; children: ReactNode; breakBefore?: boolean }) {
  return (
    <View style={s.section} break={breakBefore}>
      <View style={s.sectionHead} minPresenceAhead={60} wrap={false}>
        <T style={s.sectionNo}>{String(no).padStart(2, "0")}</T>
        <T style={s.sectionTitle}>{title}</T>
      </View>
      {children}
    </View>
  );
}

function H3({ children }: { children: ReactNode }) {
  return (
    <T style={s.h3} minPresenceAhead={70}>
      {children}
    </T>
  );
}

/** 열 너비(flex 비율)를 받는 간단한 표. */
function Table({ cols, rows }: { cols: { label: string; flex: number }[]; rows: ReactNode[][] }) {
  const row = (cells: ReactNode[], r: number) => (
    <View key={r} style={s.tr} wrap={false}>
      {cells.map((cell, i) => (
        <View key={i} style={[s.td, { flex: cols[i].flex }]}>
          {typeof cell === "string" ? <T>{cell}</T> : cell}
        </View>
      ))}
    </View>
  );
  return (
    <View style={s.table}>
      {/* 머리글이 페이지 끝에 홀로 남지 않도록 첫 행과 묶는다 */}
      <View wrap={false}>
        <View style={s.th}>
          {cols.map((c, i) => (
            <T key={i} style={[s.thCell, { flex: c.flex }]}>
              {c.label}
            </T>
          ))}
        </View>
        {rows.length > 0 && row(rows[0], 0)}
      </View>
      {rows.slice(1).map((cells, i) => row(cells, i + 1))}
    </View>
  );
}

// ---------------------------------------------------------------------------
// 포맷 도우미
// ---------------------------------------------------------------------------

function formatDate(d: Date | string | null | undefined): string {
  if (!d) return "";
  const date = d instanceof Date ? d : new Date(d);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", { timeZone: "Asia/Seoul", year: "numeric", month: "long", day: "numeric" }).format(date);
}

function truncate(text: string, max: number): string {
  const chars = Array.from(text);
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : text;
}

function scoreTone(score: number): VerdictTone {
  return score >= 70 ? "positive" : score >= 45 ? "neutral" : "negative";
}

/** 표 셀에 넣을 한 줄에서 Markdown 줄머리(제목·글머리표·인용)를 뗀다. */
function stripMd(line: string): string {
  return line
    .split("\n")
    .map((l) => l.trim().replace(/^(#{1,6}\s+|[-*+•]\s+|>\s?)/, ""))
    .filter(Boolean)
    .join(" / ");
}

const ADD_RE = /(\[ADD:[^\]]*\])/g;

/** 한 줄 안의 **굵게**와 [ADD: ...] 강조를 Text 조각으로 바꾼다. */
function Inline({ text }: { text: string }) {
  const parts: ReactNode[] = [];
  text.split(ADD_RE).forEach((seg, i) => {
    if (!seg) return;
    if (seg.startsWith("[ADD:")) {
      parts.push(
        <Text key={`a${i}`} style={{ backgroundColor: C.add, color: "#713f12", fontWeight: 700 }}>
          {seg}
        </Text>,
      );
      return;
    }
    seg.split("**").forEach((piece, j) => {
      if (!piece) return;
      const clean = piece.replace(/`/g, "").replace(/(^|\s)[*_]([^*_]+)[*_](?=\s|$)/g, "$1$2");
      parts.push(
        j % 2 === 1 ? (
          <Text key={`b${i}-${j}`} style={{ fontWeight: 700, color: C.ink }}>
            {clean}
          </Text>
        ) : (
          clean
        ),
      );
    });
  });
  return <>{parts}</>;
}

/** 재작성 이력서 Markdown을 줄 단위로 단순 렌더링(제목·글머리표·문단). */
function ResumeMarkdown({ md }: { md: string }) {
  const out: ReactNode[] = [];
  md.replace(/\r\n?/g, "\n")
    .split("\n")
    .forEach((raw, i) => {
      const line = raw.trimEnd();
      const t = line.trim();
      if (!t) return;
      if (/^(-{3,}|\*{3,}|_{3,})$/.test(t)) {
        out.push(<View key={i} style={{ borderBottomWidth: 0.5, borderBottomColor: C.line, marginVertical: 5 }} />);
        return;
      }
      const h = /^(#{1,6})\s+(.*)$/.exec(t);
      if (h) {
        const style = h[1].length === 1 ? s.mdH1 : h[1].length === 2 ? s.mdH2 : s.mdH3;
        out.push(
          <T key={i} style={style} minPresenceAhead={24}>
            <Inline text={h[2]} />
          </T>,
        );
        return;
      }
      const b = /^(\s*)([-*+•]|\d+[.)])\s+(.*)$/.exec(line);
      if (b) {
        const depth = Math.min(Math.floor(b[1].replace(/\t/g, "  ").length / 2), 3);
        const marker = /\d/.test(b[2]) ? b[2] : depth > 0 ? "–" : "•";
        out.push(
          <View key={i} style={[s.bulletRow, { marginLeft: depth * 12 }]} wrap={false}>
            <T style={[s.bulletDot, { width: marker.length > 1 ? 16 : 10 }]}>{marker}</T>
            <T style={{ flex: 1 }}>
              <Inline text={b[3]} />
            </T>
          </View>,
        );
        return;
      }
      out.push(
        <T key={i} style={s.p}>
          <Inline text={t.replace(/^>\s?/, "")} />
        </T>,
      );
    });
  return <View>{out}</View>;
}

// ---------------------------------------------------------------------------
// 섹션
// ---------------------------------------------------------------------------

function Cover({ r }: { r: ReportModel }) {
  const { meta, summary } = r;
  const atsBeforeTone = TONE[summary.atsBefore.tone];
  return (
    <View>
      <View style={s.coverBand}>
        <T style={s.coverKicker}>이력서 심사위원단 · 진단 보고서</T>
        <T style={s.coverTitle}>{meta.title}</T>
        <T style={s.coverMeta}>
          지원 직무 {meta.targetRole} · {meta.situationLabel} · {formatDate(meta.completedAt ?? meta.createdAt)}
        </T>
        {meta.resumeFileName ? <T style={[s.coverMeta, { marginTop: 2 }]}>이력서 파일 {meta.resumeFileName}</T> : null}
      </View>

      <View style={s.statRow}>
        <View style={s.statCard}>
          <T style={s.statLabel}>심사위원 통과</T>
          <T style={s.statBig}>
            {summary.positiveCount}
            <Text style={{ fontSize: 14, color: C.faint }}> / {summary.totalReviewers}</Text>
          </T>
          <View style={{ flexDirection: "row", marginTop: 6 }}>
            {r.reviewers.map((rv) => (
              <View
                key={rv.id}
                style={{ width: 12, height: 12, borderRadius: 6, marginRight: 3, backgroundColor: TONE[rv.verdict.tone].fg }}
              />
            ))}
          </View>
        </View>
        <View style={s.statCard}>
          <T style={s.statLabel}>JD 적합도{r.jd?.analysis.source === "inferred" ? " (추정 요건)" : ""}</T>
          {summary.matchScore === null ? (
            <T style={[s.statBig, { color: C.faint }]}>—</T>
          ) : (
            <>
              <T style={[s.statBig, { color: TONE[scoreTone(summary.matchScore)].fg }]}>
                {summary.matchScore}
                <Text style={{ fontSize: 14, color: C.faint }}> / 100</Text>
              </T>
              <View style={s.barTrack}>
                <View
                  style={{
                    height: 5,
                    borderRadius: 3,
                    width: `${Math.max(2, Math.min(100, summary.matchScore))}%`,
                    backgroundColor: TONE[scoreTone(summary.matchScore)].fg,
                  }}
                />
              </View>
            </>
          )}
        </View>
        <View style={[s.statCard, { marginRight: 0 }]}>
          <T style={s.statLabel}>서류 자동 필터 (전 → 후)</T>
          <View style={{ flexDirection: "row", alignItems: "center", marginTop: 8 }}>
            <T style={{ fontSize: 15, fontWeight: 800, color: atsBeforeTone.fg }}>{summary.atsBefore.label}</T>
            <T style={{ fontSize: 13, color: C.faint, marginHorizontal: 8 }}>→</T>
            {summary.atsAfter ? (
              <T style={{ fontSize: 15, fontWeight: 800, color: TONE[summary.atsAfter.tone].fg }}>{summary.atsAfter.label}</T>
            ) : (
              <T style={{ fontSize: 15, color: C.faint }}>—</T>
            )}
          </View>
          <T style={s.statSub}>재작성본 재심사 기준</T>
        </View>
      </View>

      <View style={s.headlineBox}>
        <T style={[s.small, { color: C.accent, fontWeight: 700, marginBottom: 3 }]}>한 줄 진단</T>
        <T style={s.headline}>{summary.headline}</T>
      </View>

      <View style={{ flexDirection: "row" }}>
        <View style={{ flex: 1, marginRight: 12 }}>
          <H3>실제로 먹히는 강점</H3>
          <Bullets items={summary.strengths} color={C.pos} />
        </View>
        {summary.closestToReject ? (
          <View style={{ flex: 1 }}>
            <H3>가장 거절에 가까웠던 심사위원 — {summary.closestToReject.reviewerName}</H3>
            <T>{summary.closestToReject.why}</T>
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ReviewerTable({ r, no }: { r: ReportModel; no: number }) {
  return (
    <Section no={no} title="심사위원 7명의 한 줄 평">
      <Table
        cols={[
          { label: "심사위원", flex: 1.6 },
          { label: "판정", flex: 1 },
          { label: "한 줄 평", flex: 7.4 },
        ]}
        rows={r.reviewers.map((rv) => [
          <T key="n" style={s.bold}>{rv.name}</T>,
          <VerdictBadge key="v" v={rv.verdict} />,
          rv.oneLiner,
        ])}
      />
    </Section>
  );
}

function JdSection({ r, no }: { r: ReportModel; no: number }) {
  const jd = r.jd;
  if (!jd) {
    return (
      <Section no={no} title="JD 분석 · 적합도 매트릭스" breakBefore>
        <T style={s.muted}>JD 분석 결과가 없습니다.</T>
      </Section>
    );
  }
  const a = jd.analysis;
  return (
    <Section no={no} title="JD 분석 · 적합도 매트릭스" breakBefore>
      {a.source === "inferred" && (
        <T style={s.note}>주의: 채용 공고 없이 직무명만으로 추정한 요건입니다. 실제 공고를 넣으면 더 정확한 매칭을 볼 수 있습니다.</T>
      )}
      <View style={s.card} wrap={false}>
        <T style={[s.bold, { fontSize: 11, color: C.ink }]}>
          {a.roleTitle}
          {a.company ? ` · ${a.company}` : ""}
          <Text style={{ fontWeight: 400, color: C.muted, fontSize: 9 }}>  {a.seniority}</Text>
        </T>
        <T style={{ marginTop: 4 }}>{a.summary}</T>
      </View>

      {a.responsibilities.length > 0 && (
        <>
          <H3>주요 업무</H3>
          <Bullets items={a.responsibilities} />
        </>
      )}

      <H3>ATS 키워드</H3>
      <Chips items={a.keywords} tone="plain" />

      {a.hiddenSignals.length > 0 && (
        <>
          <H3>공고의 숨은 신호</H3>
          <Bullets items={a.hiddenSignals} color={C.neu} />
        </>
      )}

      <View style={{ flexDirection: "row", alignItems: "center", marginTop: 12, marginBottom: 6 }} minPresenceAhead={80}>
        <T style={[s.h3, { marginTop: 0, marginBottom: 0, marginRight: 10 }]}>적합도 매트릭스</T>
        <Badge tone="positive">충족 {jd.counts.met}</Badge>
        <View style={{ width: 4 }} />
        <Badge tone="neutral">부분 {jd.counts.partial}</Badge>
        <View style={{ width: 4 }} />
        <Badge tone="negative">미충족 {jd.counts.missing}</Badge>
      </View>
      <T style={[s.p, { color: C.ink }]}>{jd.fitSummary}</T>
      <Table
        cols={[
          { label: "요건", flex: 3.6 },
          { label: "구분", flex: 1 },
          { label: "상태", flex: 1.1 },
          { label: "근거 · 메모", flex: 5 },
        ]}
        rows={jd.rows.map((row) => {
          const st = row.item ? FIT_STATUS[row.item.status] : null;
          return [
            <View key="r">
              <T style={s.bold}>
                <Text style={{ color: C.faint }}>{row.requirement.id} </Text>
                {row.requirement.text}
              </T>
              {row.requirement.jdQuote ? <T style={[s.small, s.muted]}>공고: “{row.requirement.jdQuote}”</T> : null}
            </View>,
            <View key="c">
              <T style={[s.small, { fontWeight: 700, color: row.priority === "must" ? C.accent : C.muted }]}>
                {row.priority === "must" ? "필수" : "우대"}
              </T>
              <T style={[s.small, s.muted]}>{CATEGORY[row.requirement.category]}</T>
            </View>,
            st ? <Badge key="s" tone={st.tone}>{st.label}</Badge> : <T key="s" style={s.muted}>—</T>,
            <View key="e">
              {row.evidence ? <Quote q={row.evidence} /> : null}
              {row.item ? <T>{row.item.note}</T> : <T style={s.muted}>평가 없음</T>}
            </View>,
          ];
        })}
      />
      {jd.untappedStrengths.length > 0 && (
        <>
          <H3>JD와 아직 연결하지 못한 강점</H3>
          <Bullets items={jd.untappedStrengths} color={C.pos} />
        </>
      )}
    </Section>
  );
}

function MistakesSection({ r, no }: { r: ReportModel; no: number }) {
  return (
    <Section no={no} title="문제점 — 심각도순" breakBefore>
      {r.mistakes.length === 0 && <T style={s.muted}>심사위원들이 공통으로 지적한 문제가 없습니다.</T>}
      {r.mistakes.map((m) => {
        const sev = SEVERITY[m.severity];
        return (
          <View key={m.rank} style={[s.card, { borderLeftWidth: 3, borderLeftColor: TONE[sev.tone].fg }]} wrap={false}>
            <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 3 }}>
              <T style={{ fontSize: 11, fontWeight: 800, color: C.faint, marginRight: 6 }}>#{m.rank}</T>
              <Badge tone={sev.tone}>{sev.label}</Badge>
              <T style={{ flex: 1, fontSize: 10.5, fontWeight: 700, color: C.ink, marginLeft: 6 }}>{m.title}</T>
            </View>
            {m.quote ? <Quote q={m.quote} /> : null}
            <T style={{ marginTop: 2 }}>
              <Text style={s.bold}>왜 떨어지나 </Text>
              {m.why}
            </T>
            <T style={{ marginTop: 2 }}>
              <Text style={[s.bold, { color: C.pos }]}>고칠 방향 </Text>
              {m.fix}
            </T>
            <T style={[s.small, s.muted, { marginTop: 3 }]}>지적: {m.flaggedBy.map((f) => f.name).join(", ")}</T>
          </View>
        );
      })}
    </Section>
  );
}

function PlanSection({ r, no }: { r: ReportModel; no: number }) {
  const p = r.plan;
  return (
    <Section no={no} title="개선 방향성" breakBefore={!!p}>
      {!p ? (
        <T style={s.muted}>개선 방향성 결과가 없습니다.</T>
      ) : (
        <>
          <View style={s.headlineBox} wrap={false}>
            <T style={[s.small, { color: C.accent, fontWeight: 700, marginBottom: 3 }]}>가장 중요한 방향 전환</T>
            <T style={s.headline}>{p.headline}</T>
          </View>
          <H3>포지셔닝</H3>
          <T style={s.p}>{p.positioning}</T>

          <H3>우선순위 (임팩트 × 노력)</H3>
          {p.priorities.map((pr, i) => (
            <View key={i} style={s.card} wrap={false}>
              <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 3 }}>
                <T style={{ fontSize: 11, fontWeight: 800, color: C.accent, marginRight: 6 }}>{i + 1}</T>
                <T style={{ flex: 1, fontSize: 10.5, fontWeight: 700, color: C.ink }}>{pr.title}</T>
                <Badge tone={pr.impact === "high" ? "positive" : pr.impact === "medium" ? "neutral" : "negative"}>
                  임팩트 {LEVEL[pr.impact]}
                </Badge>
                <View style={{ width: 4 }} />
                <Badge tone={pr.effort === "low" ? "positive" : pr.effort === "medium" ? "neutral" : "negative"}>
                  노력 {LEVEL[pr.effort]}
                </Badge>
              </View>
              <T style={[s.muted, { marginBottom: 3 }]}>{pr.why}</T>
              <Bullets items={pr.actions} />
            </View>
          ))}

          <View wrap={false}>
            <H3>오늘 바로 할 퀵윈 (30분 이내)</H3>
            <View style={[s.card, { backgroundColor: C.posSoft, borderColor: "#a7f3d0" }]}>
              <Bullets items={p.quickWins} color={C.pos} />
            </View>
          </View>

          <H3>섹션별 가이드</H3>
          <Table
            cols={[
              { label: "섹션", flex: 1.4 },
              { label: "방향", flex: 6 },
            ]}
            rows={p.sectionGuidance.map((g) => [<T key="s" style={s.bold}>{g.section}</T>, g.direction])}
          />

          <H3>역량 공백과 메우는 법</H3>
          {p.skillGaps.length === 0 ? (
            <T style={s.muted}>이력서 문장으로 못 메울 실제 역량 공백은 보이지 않습니다.</T>
          ) : (
            <Table
              cols={[
                { label: "역량", flex: 2 },
                { label: "메우는 법", flex: 5 },
                { label: "기간", flex: 1.2 },
              ]}
              rows={p.skillGaps.map((g) => [
                <T key="k" style={s.bold}>
                  {g.skill}
                  {g.requirementId ? <Text style={{ color: C.faint, fontWeight: 400 }}> ({g.requirementId})</Text> : null}
                </T>,
                g.howToClose,
                g.timeframe,
              ])}
            />
          )}

          <H3>지원 전략</H3>
          <Bullets items={p.applicationStrategy} />

          <H3>면접 대비</H3>
          {p.interviewPrep.map((q, i) => (
            <View key={i} style={{ marginBottom: 6 }} wrap={false}>
              <T style={[s.bold, { color: C.ink }]}>Q{i + 1}. {q.question}</T>
              <T style={{ marginLeft: 14 }}>
                <Text style={[s.bold, { color: C.accent }]}>답변 각도 </Text>
                {q.angle}
              </T>
            </View>
          ))}
        </>
      )}
    </Section>
  );
}

function RewriteSection({ r, no }: { r: ReportModel; no: number }) {
  const w = r.rewrite;
  return (
    <Section no={no} title="개선된 이력서" breakBefore={!!w}>
      {!w ? (
        <T style={s.muted}>재작성 결과가 없습니다.</T>
      ) : (
        <>
          <T style={[s.small, s.muted, { marginBottom: 6 }]}>
            같은 사실만으로 다시 썼습니다. 노란색 [ADD: …] 자리는 본인만 아는 사실이니 채워 넣으세요.
          </T>
          <View style={s.resumeBox}>
            <ResumeMarkdown md={w.resumeMarkdown} />
          </View>
        </>
      )}
    </Section>
  );
}

function ChangesSection({ r, no }: { r: ReportModel; no: number }) {
  const w = r.rewrite;
  if (!w) return null;
  return (
    <Section no={no} title="변경 내역 · 추가 질문 · 재심사" breakBefore>
      <H3>변경 내역 (전 → 후)</H3>
      {w.changes.length === 0 ? (
        <T style={s.muted}>변경 내역이 없습니다.</T>
      ) : (
        <Table
          cols={[
            { label: "문제", flex: 0.8 },
            { label: "전", flex: 4.5 },
            { label: "후", flex: 4.5 },
          ]}
          rows={w.changes.map((c) => [
            <T key="m" style={[s.muted, s.small]}>{c.mistakeRank ? `#${c.mistakeRank}` : "—"}</T>,
            c.before ? <T key="b" style={{ color: C.muted }}>{stripMd(c.before)}</T> : <T key="b" style={[s.small, { color: C.pos }]}>새로 추가</T>,
            <T key="a" style={{ color: C.ink }}>
              <Inline text={stripMd(c.after)} />
            </T>,
          ])}
        />
      )}

      <H3>[ADD] 채워 넣을 질문</H3>
      {w.addQuestions.length === 0 ? <T style={s.muted}>없음</T> : <Bullets items={w.addQuestions} color={C.neu} />}

      {w.assumptions.length > 0 && (
        <>
          <H3>추정으로 처리한 내용</H3>
          <Bullets items={w.assumptions} color={C.muted} />
        </>
      )}

      <H3>재작성본 서류 자동 필터 재심사</H3>
      <RescreenBlock before={r.summary.atsBefore} after={r.summary.atsAfter} rescreen={w.rescreen} />
    </Section>
  );
}

function RescreenBlock({ before, after, rescreen }: { before: VerdictView; after: VerdictView | null; rescreen: AtsResult | null }) {
  return (
    <View style={s.card} wrap={false}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 4 }}>
        <T style={[s.small, s.muted, { marginRight: 6 }]}>원본</T>
        <VerdictBadge v={before} />
        <T style={{ marginHorizontal: 8, color: C.faint }}>→</T>
        <T style={[s.small, s.muted, { marginRight: 6 }]}>재작성본</T>
        {after ? <VerdictBadge v={after} /> : <T style={s.muted}>재심사 결과 없음</T>}
      </View>
      {rescreen ? (
        <>
          <T style={{ color: C.ink }}>{rescreen.oneLiner}</T>
          <T style={[s.small, s.bold, { marginTop: 5 }]} minPresenceAhead={40}>여전히 빠진 키워드</T>
          <Chips items={rescreen.keywordsMissing} tone="negative" />
        </>
      ) : null}
    </View>
  );
}

function ReviewerDetail({ rv }: { rv: ReviewerCard }) {
  const d = rv.detail;
  return (
    <View style={[s.card, { marginBottom: 10 }]}>
      <View style={{ flexDirection: "row", alignItems: "center", marginBottom: 2 }} wrap={false} minPresenceAhead={40}>
        <T style={{ fontSize: 11, fontWeight: 800, color: C.ink, marginRight: 6 }}>{rv.name}</T>
        <VerdictBadge v={rv.verdict} />
      </View>
      <T style={[s.small, s.muted, { marginBottom: 4 }]}>{rv.role}</T>
      <T style={{ color: C.ink, marginBottom: 4 }}>{rv.oneLiner}</T>

      {d.kind === "ats" && (
        <>
          <View style={{ flexDirection: "row", marginBottom: 4 }}>
            <Badge tone={d.result.contactOk ? "positive" : "negative"}>연락처 {d.result.contactOk ? "확인" : "문제"}</Badge>
            <View style={{ width: 4 }} />
            <Badge tone={d.result.titlesAndDatesClear ? "positive" : "negative"}>
              직함·날짜 {d.result.titlesAndDatesClear ? "명확" : "불명확"}
            </Badge>
          </View>
          <T style={[s.small, s.bold]} minPresenceAhead={40}>있는 키워드</T>
          <Chips items={d.result.keywordsPresent} tone="positive" />
          <T style={[s.small, s.bold]} minPresenceAhead={40}>빠진 키워드</T>
          <Chips items={d.result.keywordsMissing} tone="negative" />
          {d.result.parseIssues.length > 0 && (
            <>
              <T style={[s.small, s.bold]} minPresenceAhead={40}>파싱 문제</T>
              <Bullets items={d.result.parseIssues} color={C.neg} />
            </>
          )}
          <T style={[s.small, s.bold, { marginTop: 4 }]} minPresenceAhead={40}>판정 근거</T>
          <QuotedIssues items={d.reasons} />
        </>
      )}

      {d.kind === "gatekeeper" && (
        <>
          <T style={s.p}>
            <Text style={s.bold}>처음 10초 </Text>
            {d.result.firstTenSeconds}
          </T>
          <T style={[s.small, s.bold]} minPresenceAhead={40}>가장 약한 줄</T>
          <QuotedIssues items={d.weakestLines} />
          <T style={[s.small, s.bold, { marginTop: 4 }]} minPresenceAhead={40}>면접에서 물어볼 질문</T>
          <Bullets items={d.result.interviewQuestions} />
        </>
      )}

      {d.kind === "reader" && (
        <>
          <T style={[s.small, s.bold]} minPresenceAhead={40}>가장 치명적인 한 줄</T>
          <QuotedIssues items={[d.worstLine]} />
          {d.result.otherProblems.length > 0 && (
            <>
              <T style={[s.small, s.bold, { marginTop: 2 }]} minPresenceAhead={40}>그 밖의 문제</T>
              <Bullets items={d.result.otherProblems} />
            </>
          )}
        </>
      )}
    </View>
  );
}

function Disclaimer({ r }: { r: ReportModel }) {
  return (
    <View style={{ marginTop: 18, paddingTop: 10, borderTopWidth: 0.75, borderTopColor: C.line }} wrap={false}>
      <T style={[s.small, s.muted]}>
        이 보고서는 언어 모델이 만든 구조화된 두 번째 의견입니다. 면접이나 합격을 보장하지 않으며, 커리어·법률 자문이 아닙니다.
        인용문 중 “원문에서 찾지 못함”으로 표시된 것은 원문과 직접 대조해 주세요.
      </T>
      <T style={[s.small, s.muted, { marginTop: 4 }]}>
        심사 방식은 Alex Chen의 hiring-panel 스킬(MIT 라이선스, github.com/alexyc9381/hiring-panel-skill)을 바탕으로 했습니다.
        {r.meta.model ? ` 모델: ${r.meta.model}.` : ""} 진단 ID: {r.meta.diagnosisId}
      </T>
    </View>
  );
}

function ReportDocument({ r }: { r: ReportModel }) {
  let n = 0;
  const next = () => ++n;
  return (
    <Document
      title={`${r.meta.title} — 이력서 진단 보고서`}
      author="이력서 심사위원단"
      subject={`${r.meta.targetRole} 지원 이력서 진단`}
      creator="이력서 심사위원단"
      producer="이력서 심사위원단"
      language="ko-KR"
    >
      <Page size="A4" style={s.page} wrap>
        <View style={s.headerWrap} fixed render={({ pageNumber }) => (pageNumber === 1 ? null : <HeaderContent r={r} />)} />
        <Cover r={r} />
        <ReviewerTable r={r} no={next()} />
        <JdSection r={r} no={next()} />
        <MistakesSection r={r} no={next()} />
        <PlanSection r={r} no={next()} />
        <RewriteSection r={r} no={next()} />
        {r.rewrite ? <ChangesSection r={r} no={next()} /> : null}
        <Section no={next()} title="심사위원별 상세" breakBefore>
          {r.reviewers.map((rv) => (
            <ReviewerDetail key={rv.id} rv={rv} />
          ))}
        </Section>
        <Disclaimer r={r} />
        <View style={s.footer} fixed>
          <Text>이력서 심사위원단 · {formatDate(r.meta.completedAt ?? r.meta.createdAt)}</Text>
          <Text render={({ pageNumber, totalPages }) => `${pageNumber} / ${totalPages}`} />
        </View>
      </Page>
    </Document>
  );
}

function HeaderContent({ r }: { r: ReportModel }) {
  return (
    <View style={s.header}>
      <Text style={{ maxWidth: "65%" }}>{truncate(r.meta.title, 40)}</Text>
      <Text>{r.meta.targetRole} · 진단 보고서</Text>
    </View>
  );
}

// ---------------------------------------------------------------------------
// 공개 API
// ---------------------------------------------------------------------------

export async function renderReportPdf(r: ReportModel): Promise<Uint8Array> {
  registerFonts();
  const buf = await renderToBuffer(<ReportDocument r={r} />);
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}
