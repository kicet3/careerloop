/**
 * 원본 스킬 호환 Markdown 내보내기: PANEL.md(판정·JD 적합도·문제점·개선 방향성)와 RESUME-IMPROVED.md(개선된 이력서).
 */
import { REVIEWER_IDS } from "@/lib/domain/schemas";
import { REVIEWERS } from "@/lib/domain/reviewers";
import {
  CATEGORY_LABELS,
  CREDIT_LINE,
  DISCLAIMER_TEXT,
  FIT_STATUS_LABELS,
  LEVEL_LABELS,
  PRIORITY_LABELS,
  SEVERITY_LABELS,
  formatReportDate,
} from "./model";
import type { CheckedQuote, ReportModel, ReviewerCard } from "./types";

const UNVERIFIED = " _(원문에서 찾지 못함)_";

/** 표 셀 안에서 줄바꿈·파이프가 표를 깨지 않도록. */
function cell(text: string | null | undefined): string {
  if (!text) return "-";
  return text.replace(/\r?\n+/g, " ").replace(/\|/g, "\\|").trim() || "-";
}

function oneLine(text: string): string {
  return text.replace(/\r?\n+/g, " ").trim();
}

function quoteLine(q: CheckedQuote, indent = ""): string {
  return `${indent}> ${oneLine(q.text)}${q.verified ? "" : UNVERIFIED}`;
}

/** 심사위원별 대표 인용(리더: 가장 치명적인 줄, ATS: 첫 사유, 채용 담당자: 가장 약한 줄). */
function keyQuote(c: ReviewerCard): { quote: CheckedQuote; issue: string } | null {
  const d = c.detail;
  if (d.kind === "reader") return d.worstLine;
  if (d.kind === "ats") return d.reasons[0] ?? null;
  return d.weakestLines[0] ?? null;
}

function header(r: ReportModel, kind: string): string[] {
  const m = r.meta;
  return [
    `# ${kind} — ${m.title}`,
    "",
    `- 지원 직무: ${m.targetRole}`,
    `- 상황: ${m.situationLabel}`,
    `- 진단일: ${formatReportDate(m.createdAt)}`,
    ...(m.resumeFileName ? [`- 이력서 파일: ${m.resumeFileName}`] : []),
    "",
  ];
}

export function renderPanelMarkdown(r: ReportModel): string {
  const s = r.summary;
  const out: string[] = [...header(r, "이력서 심사위원단 결과")];

  out.push("## 요약", "", s.headline, "");
  out.push(`- 심사위원 ${s.totalReviewers}명 중 **${s.positiveCount}명 통과**`);
  if (s.matchScore !== null) out.push(`- JD 적합도: **${s.matchScore}점** / 100`);
  out.push(`- 서류 자동 필터: ${s.atsBefore.label} → ${s.atsAfter ? s.atsAfter.label : "재심사 없음"}`);
  out.push("");
  if (s.strengths.length) {
    out.push("**실제로 먹히는 강점**", "", ...s.strengths.map((x) => `- ${oneLine(x)}`), "");
  }
  if (s.closestToReject) {
    out.push(`**가장 거절에 가까웠던 심사위원: ${s.closestToReject.reviewerName}** — ${oneLine(s.closestToReject.why)}`, "");
  }

  // 1. 판정
  out.push("## 심사위원 7명의 판정", "");
  const byId = new Map(r.reviewers.map((c) => [c.id, c]));
  for (const id of REVIEWER_IDS) {
    const c = byId.get(id);
    out.push(
      c
        ? `- **${c.name}** — ${c.verdict.label} (${c.verdict.raw}): ${oneLine(c.oneLiner)}`
        : `- **${REVIEWERS[id].name}** — 미완료`,
    );
    const key = c && keyQuote(c);
    if (key) out.push(quoteLine(key.quote, "  "), `  ${oneLine(key.issue)}`);
  }
  out.push("");

  // 2. JD 적합도
  out.push("## JD 분석과 적합도", "");
  if (!r.jd) {
    out.push("JD 분석이 완료되지 않았습니다.", "");
  } else {
    const a = r.jd.analysis;
    if (a.source === "inferred") out.push("> ⚠ 공고 없이 직무명으로 추정한 요건입니다.", "");
    out.push(`**${a.roleTitle}**${a.company ? ` · ${a.company}` : ""} · ${a.seniority}`, "", oneLine(a.summary), "");
    if (r.jd.fitSummary) out.push(`**적합도 요약:** ${oneLine(r.jd.fitSummary)}`, "");
    const c = r.jd.counts;
    out.push(`충족 ${c.met} · 부분 ${c.partial} · 미충족 ${c.missing}`, "");
    out.push("| ID | 구분 | 요건 | 판정 | 근거(이력서 원문) | 메모 |", "|---|---|---|---|---|---|");
    for (const row of r.jd.rows) {
      const ev = row.evidence ? `${cell(row.evidence.text)}${row.evidence.verified ? "" : " (원문에서 찾지 못함)"}` : "-";
      out.push(
        `| ${cell(row.requirement.id)} | ${PRIORITY_LABELS[row.priority]} · ${CATEGORY_LABELS[row.requirement.category] ?? row.requirement.category} | ${cell(row.requirement.text)} | ${row.item ? FIT_STATUS_LABELS[row.item.status] : "미평가"} | ${ev} | ${cell(row.item?.note)} |`,
      );
    }
    out.push("");
    if (a.keywords.length) out.push(`**핵심 키워드:** ${a.keywords.join(", ")}`, "");
    if (a.hiddenSignals.length) out.push("**공고의 숨은 신호**", "", ...a.hiddenSignals.map((x) => `- ${oneLine(x)}`), "");
    if (r.jd.untappedStrengths.length)
      out.push("**연결하지 못한 강점**", "", ...r.jd.untappedStrengths.map((x) => `- ${oneLine(x)}`), "");
  }

  // 3. 문제점
  out.push("## 문제점 (심각도순)", "");
  if (!r.mistakes.length) {
    out.push("종합 결과가 없습니다.", "");
  } else {
    r.mistakes.forEach((m, i) => {
      out.push(`${i + 1}. **${oneLine(m.title)}** [${SEVERITY_LABELS[m.severity]}]`);
      if (m.quote) out.push(quoteLine(m.quote, "   "));
      out.push(`   - 왜 떨어지나: ${oneLine(m.why)}`);
      out.push(`   - 고칠 방향: ${oneLine(m.fix)}`);
      out.push(`   - 지적: ${m.flaggedBy.map((f) => f.name).join(", ")}`);
    });
    out.push("");
  }

  // 4. 개선 방향성
  out.push("## 개선 방향성", "");
  const p = r.plan;
  if (!p) {
    out.push("개선 방향성이 완료되지 않았습니다.", "");
  } else {
    out.push(`**${oneLine(p.headline)}**`, "", p.positioning.trim(), "");
    if (p.priorities.length) {
      out.push("### 우선순위", "");
      p.priorities.forEach((x, i) => {
        out.push(`${i + 1}. **${oneLine(x.title)}** (임팩트 ${LEVEL_LABELS[x.impact]} · 노력 ${LEVEL_LABELS[x.effort]})`);
        out.push(`   ${oneLine(x.why)}`);
        for (const a of x.actions) out.push(`   - ${oneLine(a)}`);
      });
      out.push("");
    }
    if (p.quickWins.length) out.push("### 오늘 할 퀵윈", "", ...p.quickWins.map((x) => `- [ ] ${oneLine(x)}`), "");
    if (p.sectionGuidance.length)
      out.push("### 섹션별 가이드", "", ...p.sectionGuidance.map((x) => `- **${oneLine(x.section)}**: ${oneLine(x.direction)}`), "");
    if (p.skillGaps.length) {
      out.push("### 역량 공백", "", "| 역량 | 요건 | 메우는 법 | 기간 |", "|---|---|---|---|");
      for (const g of p.skillGaps)
        out.push(`| ${cell(g.skill)} | ${cell(g.requirementId)} | ${cell(g.howToClose)} | ${cell(g.timeframe)} |`);
      out.push("");
    }
    if (p.applicationStrategy.length)
      out.push("### 지원 전략", "", ...p.applicationStrategy.map((x) => `- ${oneLine(x)}`), "");
    if (p.interviewPrep.length) {
      out.push("### 면접 대비", "");
      for (const q of p.interviewPrep) out.push(`- **Q. ${oneLine(q.question)}**`, `  - ${oneLine(q.angle)}`);
      out.push("");
    }
  }

  out.push("---", "", DISCLAIMER_TEXT, "", CREDIT_LINE, "");
  return out.join("\n");
}

export function renderResumeMarkdown(r: ReportModel): string {
  const rw = r.rewrite;
  const out: string[] = [];
  if (!rw) {
    out.push(...header(r, "개선된 이력서"), "이력서 재작성이 완료되지 않았습니다.", "");
  } else {
    out.push(rw.resumeMarkdown.trim(), "");
    if (rw.addQuestions.length) {
      out.push("---", "", "## 채워야 할 정보 ([ADD])", "", ...rw.addQuestions.map((q, i) => `${i + 1}. ${oneLine(q)}`), "");
    }
    if (rw.assumptions.length) {
      out.push("## 추정한 내용", "", ...rw.assumptions.map((x) => `- ${oneLine(x)}`), "");
    }
    const before = r.summary.atsBefore.label;
    const after = rw.rescreen ? REVIEWERS.ats.verdicts[rw.rescreen.verdict]?.label ?? rw.rescreen.verdict : "재심사 없음";
    out.push(`서류 자동 필터: ${before} → ${after}`, "");
  }
  out.push("---", "", CREDIT_LINE, "");
  return out.join("\n");
}
