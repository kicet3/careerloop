/**
 * 면접 연습 근거 줄 만들기·인용 검증(순수 함수, 클라이언트·서버 공용).
 * 이력서 문서(ResumeDocument)·포트폴리오 텍스트·JD를 id 붙은 짧은 줄(InterviewSourceLine)로 펼친다 — LLM은 이 id로 인용하고,
 * 서버는 인용문이 그 줄에 글자 그대로 있는지 확인한다(verifyCitations). 줄 id 규칙: 이력서 r1…, 포트폴리오 p1…, 공고 j1….
 */
import {
  INTERVIEW_LIMITS,
  INTERVIEW_QUESTION_CATEGORIES,
  normalizeFacet,
  type InterviewCitation,
  type InterviewProgress,
  type InterviewQuestionView,
  type InterviewQuestionCategory,
  type InterviewQuestionsOutput,
  type InterviewSourceDoc,
  type InterviewSourceLine,
} from "@/lib/domain/interview";
import { RESUME_SECTION_LABELS, type ResumeDocument } from "@/lib/domain/resumes";

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
const clean = (s: string) => s.replace(/\s+/g, " ").trim();

/** 이력서 문서 → 근거 줄(r1…). 빈 칸·[ADD: …]만 있는 칸은 뺀다. 순서는 문서 순서(요약 → 핵심 성과 → 경력 → 프로젝트 → 기술 → 기타). */
export function resumeSourceLines(doc: ResumeDocument): InterviewSourceLine[] {
  const out: InterviewSourceLine[] = [];
  const push = (label: string, path: string, raw: string) => {
    const text = clean(raw);
    if (!text || /^\[ADD:[^\]]*\]$/.test(text)) return;
    out.push({ id: `r${out.length + 1}`, doc: "resume", label: clip(label, 200), path, text: clip(text, INTERVIEW_LIMITS.lineChars) });
  };
  if (doc.basics.headline) push("지원 직무", "basics.headline", doc.basics.headline);
  if (doc.basics.tagline) push("한 줄 소개", "basics.tagline", doc.basics.tagline);
  doc.summary
    .split(/\n+/)
    .forEach((line, i) => push(`${RESUME_SECTION_LABELS.summary} ${i + 1}`, `summary.${i}`, line));
  doc.highlights.forEach((h, i) => {
    push(`${RESUME_SECTION_LABELS.highlights} ${i + 1}`, `highlights.${i}.title`, h.title);
    push(`${RESUME_SECTION_LABELS.highlights} ${i + 1} · 근거`, `highlights.${i}.context`, h.context);
  });
  doc.experience.forEach((e, i) => {
    const where = [e.company, e.title].filter(Boolean).join(" ") || `경력 ${i + 1}`;
    push(`경력 · ${where} · 담당 범위`, `experience.${i}.scope`, e.scope);
    e.bullets.forEach((b, j) => push(`경력 · ${where} · 기여 ${j + 1}`, `experience.${i}.bullets.${j}`, b));
  });
  doc.projects.forEach((p, i) => {
    const name = p.name || `프로젝트 ${i + 1}`;
    push(`프로젝트 · ${name} · 역할`, `projects.${i}.role`, p.role);
    push(`프로젝트 · ${name} · 요약`, `projects.${i}.summary`, p.summary);
    push(`프로젝트 · ${name} · 문제`, `projects.${i}.problem`, p.problem);
    push(`프로젝트 · ${name} · 개선`, `projects.${i}.action`, p.action);
    push(`프로젝트 · ${name} · 결과`, `projects.${i}.result`, p.result);
    p.bullets.forEach((b, j) => push(`프로젝트 · ${name} · ${j + 1}`, `projects.${i}.bullets.${j}`, b));
  });
  doc.skills.forEach((s, i) => {
    const items = s.items.join(", ");
    push(`기술 · ${s.category || i + 1}`, `skills.${i}`, [s.detail, items].filter(Boolean).join(" — "));
  });
  doc.extras.forEach((x, i) => x.items.forEach((it, j) => push(`${x.title || "기타"} ${j + 1}`, `extras.${i}.items.${j}`, it)));
  return out;
}

/** 긴 글(포트폴리오·JD) → 문단·줄 단위 근거 줄. 짧은 줄은 다음 줄과 붙이고, 긴 줄은 문장 경계 근처에서 자른다. */
export function textSourceLines(
  doc: Exclude<InterviewSourceDoc, "resume">,
  text: string,
  opts: { maxChars?: number; maxLines?: number } = {},
): { lines: InterviewSourceLine[]; truncated: boolean } {
  const prefix = doc === "portfolio" ? "p" : "j";
  const label = doc === "portfolio" ? "포트폴리오" : "채용 공고";
  const maxChars = opts.maxChars ?? (doc === "portfolio" ? INTERVIEW_LIMITS.portfolioPromptChars : INTERVIEW_LIMITS.jdPromptChars);
  const maxLines = opts.maxLines ?? 400;
  const limit = INTERVIEW_LIMITS.lineChars;
  const chunks: string[] = [];
  let buf = "";
  for (const raw of text.split(/\n+/)) {
    const line = clean(raw);
    if (!line) continue;
    buf = buf ? `${buf} ${line}` : line;
    if (buf.length < 40) continue;
    while (buf.length > limit) {
      const cut = Math.max(buf.lastIndexOf(". ", limit), buf.lastIndexOf("다. ", limit), Math.floor(limit * 0.6));
      chunks.push(buf.slice(0, cut + 1).trim());
      buf = buf.slice(cut + 1).trim();
    }
    chunks.push(buf);
    buf = "";
  }
  if (buf) chunks.push(buf);
  const lines: InterviewSourceLine[] = [];
  let used = 0;
  let truncated = false;
  for (const c of chunks) {
    if (lines.length >= maxLines || used + c.length > maxChars) {
      truncated = true;
      break;
    }
    used += c.length;
    lines.push({ id: `${prefix}${lines.length + 1}`, doc, label: `${label} ${lines.length + 1}`, path: null, text: c });
  }
  return { lines, truncated };
}

/** 프롬프트용 근거 표: `[r1] (경력 · 토스 · 기여 1) 본문` 한 줄씩(테스트용 가짜 LLM이 같은 형식을 읽는다). */
export function sourceLinesToPrompt(lines: readonly InterviewSourceLine[]): string {
  return lines.map((l) => `[${l.id}] (${l.label.replace(/[()]/g, "")}) ${l.text}`).join("\n");
}

const squash = (s: string) => s.replace(/[\s"'“”‘’`.,·…]+/g, "").toLowerCase();

/** LLM 인용 → 저장 형태. 모르는 ref는 버리고, quote가 그 줄에 (공백·문장부호 무시하고) 있으면 verified(비었으면 줄 본문으로 채우고 verified). 같은 ref는 한 번만. */
export function verifyCitations(
  raw: readonly { ref: string; quote: string }[],
  lines: readonly InterviewSourceLine[],
): InterviewCitation[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const seen = new Set<string>();
  const out: InterviewCitation[] = [];
  for (const c of raw) {
    const ref = c.ref.trim().replace(/^\[|\]$/g, "");
    const line = byId.get(ref);
    if (!line || seen.has(ref)) continue;
    seen.add(ref);
    const quote = clip(clean(c.quote), INTERVIEW_LIMITS.quoteChars);
    const q = squash(quote);
    // quote가 비면 그 줄 본문을 그대로 인용한다(서버가 넣은 원문이므로 확인된 인용).
    if (!q) out.push({ ref, doc: line.doc, quote: clip(line.text, INTERVIEW_LIMITS.quoteChars), verified: true });
    else out.push({ ref, doc: line.doc, quote, verified: squash(line.text).includes(q) });
    if (out.length >= INTERVIEW_LIMITS.citationsPerQuestion) break;
  }
  return out;
}

/** 저장할 질문(store.completeGeneration 입력). */
export interface NewInterviewQuestion {
  category: InterviewQuestionCategory;
  facet: string | null;
  question: string;
  intent: string;
  citations: InterviewCitation[];
  followUps: string[];
}

/**
 * LLM 질문 출력 정리: 빈 질문·중복 질문 제거, facet 정규화, 인용 검증, 길이 자르기.
 * 근거가 필요한 분류(line·project·pivot·tough)는 이력서·포트폴리오 줄의 확인된(verified) 인용이 하나도 없으면 버린다
 * (근거 없는 질문·지어낸 인용을 만들지 않는다). 확인되지 않은 인용은 보조로만 남기고 확인된 인용 뒤에 둔다.
 */
export function normalizeGeneratedQuestions(output: InterviewQuestionsOutput, lines: readonly InterviewSourceLine[]): NewInterviewQuestion[] {
  const needsCitation = new Set<InterviewQuestionCategory>(["line", "project", "pivot", "tough"]);
  const seen = new Set<string>();
  const out: NewInterviewQuestion[] = [];
  for (const q of output.questions) {
    if (!(INTERVIEW_QUESTION_CATEGORIES as readonly string[]).includes(q.category)) continue;
    const question = clip(clean(q.question), INTERVIEW_LIMITS.questionChars);
    const key = squash(question);
    if (!question || seen.has(key)) continue;
    const verified = verifyCitations(q.citations, lines);
    const citations = [...verified.filter((c) => c.verified), ...verified.filter((c) => !c.verified)];
    if (needsCitation.has(q.category) && !citations.some((c) => c.verified && c.doc !== "posting")) continue;
    seen.add(key);
    out.push({
      category: q.category,
      facet: normalizeFacet(q.category, q.facet),
      question,
      intent: clip(clean(q.intent), INTERVIEW_LIMITS.intentChars),
      citations,
      followUps: q.followUps
        .map((f) => clip(clean(f), INTERVIEW_LIMITS.followUpChars))
        .filter(Boolean)
        .slice(0, INTERVIEW_LIMITS.followUpsPerQuestion),
    });
    if (out.length >= INTERVIEW_LIMITS.questionsPerSession) break;
  }
  return out;
}

/** 질문 목록 → 진행률(순수). practiced = 답변을 한 번 이상 한 질문. */
export function computeProgress(questions: readonly Pick<InterviewQuestionView, "category" | "attemptCount" | "bestScore">[]): InterviewProgress {
  const byCategory = Object.fromEntries(INTERVIEW_QUESTION_CATEGORIES.map((c) => [c, { total: 0, practiced: 0 }])) as InterviewProgress["byCategory"];
  let practiced = 0;
  const scores: number[] = [];
  for (const q of questions) {
    const b = byCategory[q.category];
    b.total++;
    if (q.attemptCount > 0) {
      b.practiced++;
      practiced++;
    }
    if (q.bestScore != null) scores.push(q.bestScore);
  }
  return {
    total: questions.length,
    practiced,
    byCategory,
    averageBestScore: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
  };
}
