/**
 * 테스트 전용 결정적 가짜 LLM. 앱 코드에서는 import할 수 없다(eslint no-restricted-imports).
 * 프롬프트(panel/prompts.ts 형식)에서 이력서·JD 분석·이전 단계 결과를 읽어 스키마에 맞는 한국어 결과를 만든다.
 * 인용은 실제 이력서 줄을 그대로 써서 verifyQuote를 통과한다. 판정은 일부러 섞는다(ATS는 처음 REJECT, 재심사 PASS).
 */
import type {
  AtsResult,
  FitResult,
  GatekeeperResult,
  ImprovementPlan,
  JdAnalysis,
  ReaderId,
  ReaderResult,
  Requirement,
  RewriteResult,
  StageKey,
  StageOutputs,
  SynthesisResult,
} from "@/lib/domain/schemas";
import {
  CHAT_TAGS,
  type GraphChatOutput,
  type GraphImportOutput,
  type GraphQaOutput,
  type GraphRepoImportOutput,
  type GraphQaRerankOutput,
  type ReviewerChatOutput,
} from "@/lib/domain/chat";
import { extractKeywords } from "@/lib/skills/dictionary";
import { emptyResumeDocument, type ResumeDraftOutput } from "@/lib/domain/resumes";
import {
  POLISH_DOCUMENT_TAG,
  POLISH_ITEMS_TAG,
  POLISH_TARGET_TAG,
  type PolishItemChangeOutput,
  type PolishItemOutput,
  type ResumePolishDocOutput,
  type ResumePolishOutput,
} from "@/lib/domain/resume-polish";
import type { GraphPortfolioOutput } from "@/lib/domain/graph-portfolio";
import { getPortfolioTemplate } from "@/lib/domain/portfolio-templates";
import type { InterviewFeedbackOutput, InterviewQuestionsOutput } from "@/lib/domain/interview";
import type { PostingSectionsLlm } from "@/lib/domain/posting-structure";
import type { PostingExtract } from "@/lib/domain/postings";
import { computeMatchScore } from "@/lib/panel/fit-score";
import { extractField, extractJson, extractTag, TAGS } from "@/lib/panel/prompts";
import {
  LlmPermanentError,
  requestLabel,
  type GenerateResult,
  type LlmClient,
  type LlmRequest,
  type LlmTask,
} from "@/lib/llm/types";

export const FAKE_MODEL_NAME = "fake";

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(t);
      reject(signal.reason ?? new Error("aborted"));
    });
  });
}

// ---------------------------------------------------------------------------
// 이력서에서 인용할 줄 고르기
// ---------------------------------------------------------------------------

const BULLET_RE = /^[\s\-–—*•◦▪▫●○■□►▶‣⁃∙·]+/u;

/** 인용 후보 줄: 글머리표를 떼고 trim한 원문 줄(원문 부분 문자열이라 검증을 통과한다). */
export function quotableLines(resume: string): string[] {
  const lines = resume
    .split(/\r?\n/)
    .map((l) => l.replace(BULLET_RE, "").trim())
    .filter((l) => l.length >= 6 && !/^#+\s*$/.test(l));
  return lines.length > 0 ? lines : [resume.trim().slice(0, 60) || "(빈 이력서)"];
}

/** 성과 줄처럼 보이는 것(숫자 포함)과 아닌 것을 나눈다. */
function classify(lines: string[]) {
  const withNumber = lines.filter((l) => /\d/.test(l) && l.length > 15);
  const plain = lines.filter((l) => !/\d/.test(l) && l.length > 15);
  return { withNumber, plain };
}

function pick(lines: string[], i: number): string {
  return lines[((i % lines.length) + lines.length) % lines.length];
}

function isKorean(text: string): boolean {
  const hangul = (text.match(/[가-힣]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return hangul >= latin * 0.3;
}

// ---------------------------------------------------------------------------
// 단계별 가짜 출력
// ---------------------------------------------------------------------------

interface Ctx {
  user: string;
  role: string;
  resume: string;
  lines: string[];
  jd: JdAnalysis | null;
}

function requirements(jd: JdAnalysis | null): { req: Requirement; must: boolean }[] {
  if (!jd) return [];
  return [...jd.mustHave.map((req) => ({ req, must: true })), ...jd.niceToHave.map((req) => ({ req, must: false }))];
}

const TECH_RE = /[A-Za-z][A-Za-z0-9+#.]*(?:\s?[A-Z][A-Za-z0-9+#.]*)?/g;

function fakeJd(ctx: Ctx): JdAnalysis {
  const posting = extractTag(ctx.user, TAGS.jobPosting);
  if (posting) {
    const postingLines = posting
      .split(/\r?\n/)
      .map((l) => l.replace(BULLET_RE, "").trim())
      .filter((l) => l.length >= 4);
    const terms = [...new Set((posting.match(TECH_RE) ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))];
    const reqLines = postingLines.filter((l) => l.length >= 8).slice(0, 8);
    const mustLines = reqLines.slice(0, Math.max(1, Math.ceil(reqLines.length * 0.6)));
    const niceLines = reqLines.slice(mustLines.length);
    let n = 0;
    const toReq = (line: string): Requirement => ({
      id: `R${++n}`,
      text: line.length > 40 ? `${line.slice(0, 40)}… 관련 역량` : line,
      category: /년|years?|경력|experience/i.test(line) ? "experience" : /[A-Za-z]/.test(line) ? "skill" : "other",
      jdQuote: line,
    });
    return {
      source: "jd",
      roleTitle: ctx.role,
      company: null,
      seniority: /신입|entry|junior/i.test(posting) ? "신입~주니어" : "주니어~미들(3~5년) (추정)",
      summary: `${ctx.role} 업무를 바로 맡아 결과를 낼 사람을 찾는다. 공고에서 반복되는 요구는 실무 도구 숙련과 측정 가능한 성과다.`,
      mustHave: mustLines.map(toReq),
      niceToHave: niceLines.map(toReq),
      keywords: (terms.length > 0 ? terms : ["커뮤니케이션", "데이터 분석", "프로젝트 관리"]).slice(0, 15),
      responsibilities: postingLines.slice(0, 4),
      hiddenSignals: ["필수와 우대의 경계가 흐려 우대 항목도 사실상 평가될 가능성(추정)"],
    };
  }
  const req = (id: number, text: string, category: Requirement["category"]): Requirement => ({
    id: `R${id}`,
    text,
    category,
    jdQuote: null,
  });
  return {
    source: "inferred",
    roleTitle: ctx.role,
    company: null,
    seniority: "주니어~미들(2~5년) (추정)",
    summary: `공고 없이 직무명으로 추정한 요건이다. ${ctx.role}로서 핵심 업무를 독립적으로 수행하고 결과를 숫자로 보여줄 사람을 원할 것이다.`,
    mustHave: [
      req(1, `${ctx.role} 관련 실무 경험 2년 이상`, "experience"),
      req(2, "핵심 업무 도구·기술 숙련", "skill"),
      req(3, "성과를 수치로 측정하고 개선한 경험", "experience"),
      req(4, "유관 부서와의 협업·커뮤니케이션", "soft"),
    ],
    niceToHave: [req(5, "해당 산업 도메인 이해", "domain"), req(6, "관련 자격증 또는 교육 이수", "education")],
    keywords: ["SQL", "Excel", "협업", "프로젝트 관리", "데이터 분석", "커뮤니케이션"],
    responsibilities: [`${ctx.role} 핵심 업무 수행`, "성과 지표 관리와 보고", "유관 부서 협업"],
    hiddenSignals: ["실제로는 바로 투입 가능한 경력자를 선호할 가능성이 높다(추정)"],
  };
}

function keywordSplit(ctx: Ctx) {
  const lower = ctx.resume.toLowerCase();
  const keywords = ctx.jd?.keywords ?? [];
  return {
    present: keywords.filter((k) => lower.includes(k.toLowerCase())),
    missing: keywords.filter((k) => !lower.includes(k.toLowerCase())),
  };
}

/** 이력서 에이전트의 초안 심사(DRAFT_MODE_NOTE가 붙은 프롬프트). */
function isDraftReview(ctx: Ctx): boolean {
  return ctx.user.includes("## 초안 심사 참고");
}

function fakeAts(ctx: Ctx, rescreen: boolean): AtsResult {
  const { withNumber, plain } = classify(ctx.lines);
  const { present, missing } = keywordSplit(ctx);
  const contactOk = /@|\d{2,4}-\d{3,4}-\d{4}/.test(ctx.resume);
  // 초안 심사: JD 키워드가 모두 있으면 통과(에이전트 수정 루프가 키워드를 채우면 다음 라운드에 통과한다).
  if (rescreen || (isDraftReview(ctx) && missing.length === 0)) {
    return {
      verdict: "PASS",
      oneLiner: "표준 섹션명과 단일 열 구조로 위에서 아래로 읽히고, 핵심 키워드가 경력 줄에 근거와 함께 나온다.",
      reasons: [{ quote: pick(ctx.lines, 0), issue: "상단에서 직무와 연락처가 바로 확인돼 파싱 문제가 없다." }],
      keywordsPresent: present,
      keywordsMissing: missing,
      parseIssues: missing.length > 0 ? ["[ADD: …] 자리표시가 남아 있어 제출 전 채워야 한다"] : [],
      contactOk,
      titlesAndDatesClear: true,
    };
  }
  return {
    verdict: "REJECT",
    oneLiner: `JD 핵심 키워드 ${missing.length}개가 빠졌고 성과 줄에 결과 수치가 부족해 사람 검토로 넘기지 않는다.`,
    reasons: [
      { quote: pick(plain.length ? plain : ctx.lines, 0), issue: "담당 업무만 있고 결과가 없어 JD 요건과 연결되지 않는다." },
      { quote: pick(ctx.lines, 1), issue: "직함·기간 표기가 다른 줄과 형식이 달라 경력 기간 계산이 어렵다." },
      { quote: pick(withNumber.length ? withNumber : ctx.lines, 0), issue: "숫자는 있지만 무엇이 얼마나 바뀌었는지 기준이 없다." },
    ],
    keywordsPresent: present,
    keywordsMissing: missing,
    parseIssues: ["섹션 순서가 표준(요약→경력→기술→학력)과 달라 일부 항목이 다른 섹션으로 읽힐 수 있다"],
    contactOk,
    titlesAndDatesClear: false,
  };
}

function fakeGatekeeper(ctx: Ctx): GatekeeperResult {
  const { plain, withNumber } = classify(ctx.lines);
  const weak = plain.length >= 3 ? plain : ctx.lines;
  const interview = isDraftReview(ctx) && keywordSplit(ctx).missing.length === 0;
  return {
    verdict: interview ? "INTERVIEW" : "NO",
    oneLiner: `${ctx.role} 지원자 중 비교 우위가 상단에서 보이지 않아 다른 지원자를 먼저 부른다.`,
    firstTenSeconds: `첫 화면에서 ${ctx.role}와 직접 연결되는 성과 문장이 없고, 최근 경력의 역할 범위가 모호했다.`,
    interviewQuestions: [
      `"${pick(withNumber.length ? withNumber : ctx.lines, 0).slice(0, 40)}"에서 본인이 직접 한 부분은 무엇인가?`,
      "가장 최근 경력에서 측정한 핵심 지표와 시작·종료 수치는?",
      "팀 규모와 본인의 의사결정 권한은 어디까지였나?",
    ],
    weakestLines: [0, 1, 2].map((i) => ({
      quote: pick(weak, i),
      issue: ["무엇을 했는지만 있고 결과가 없다.", "직무와의 연결이 보이지 않는다.", "검증할 수 있는 숫자나 범위가 없다."][i],
    })),
  };
}

const READER_FAKE: Record<ReaderId, { verdict: ReaderResult["verdict"]; oneLiner: string; issue: string; others: [string, string] }> = {
  manager: {
    verdict: "MAYBE",
    oneLiner: "할 수 있을 것 같지만 첫날부터 맡길 증거는 절반뿐이다.",
    issue: "이 줄만으로는 핵심 업무를 혼자 해 본 적이 있는지 알 수 없다.",
    others: ["사용한 도구의 숙련도가 드러나지 않는다.", "가장 최근 경력의 담당 범위가 불분명하다."],
  },
  rival: {
    verdict: "PASS",
    oneLiner: "같은 자리 지원자들보다 숫자와 규모가 약해 내가 이긴다.",
    issue: "비슷한 경력의 지원자라면 같은 일을 수치로 보여준다.",
    others: ["도메인 경험이 한 회사에 한정돼 있다.", "기술 스택이 공고 키워드와 표기가 다르다."],
  },
  ceo: {
    verdict: "MAYBE",
    oneLiner: "무엇을 바꿨는지는 보이지만 얼마나 바꿨는지가 빠져 있다.",
    issue: "회사에 남긴 결과가 아니라 맡은 업무를 적었다.",
    others: ["매출·비용·시간 중 어느 것에 영향을 줬는지 없다.", "'참여'·'지원' 표현이 많아 주도한 일이 안 보인다."],
  },
  recruiter: {
    verdict: "HIRE",
    oneLiner: "상단만 보면 직무와 연차가 맞아 일단 다음 단계로 넘긴다.",
    issue: "상단 요약이 길어 핵심 직함을 찾는 데 시간이 걸린다.",
    others: ["상단 3분의 1에 대표 성과 숫자가 하나도 없다.", "연락처와 링크 줄이 섞여 있다."],
  },
  teammate: {
    verdict: "HIRE",
    oneLiner: "협업 흔적이 보여 같이 일하기 괜찮아 보인다.",
    issue: "팀 성과 중 본인 몫이 어디까지인지 구분되지 않는다.",
    others: ["갈등이나 이견을 풀어낸 사례가 없다.", "다른 사람을 도운 경험이 한 줄도 없다."],
  },
};

const READER_OFFSET: Record<ReaderId, number> = { manager: 2, rival: 3, ceo: 4, recruiter: 0, teammate: 5 };

function fakeReader(ctx: Ctx, id: ReaderId): ReaderResult {
  const m = READER_FAKE[id];
  const pool = id === "recruiter" ? ctx.lines.slice(0, Math.max(1, Math.ceil(ctx.lines.length / 3))) : ctx.lines;
  return {
    verdict: m.verdict,
    oneLiner: m.oneLiner,
    worstLine: { quote: pick(pool, READER_OFFSET[id]), issue: m.issue },
    otherProblems: [...m.others],
  };
}

const FIT_CYCLE: FitResult["items"][number]["status"][] = ["met", "partial", "missing", "met", "partial"];

/** 초안 심사의 적합도: 요건 문장의 영문 기술 용어가 이력서에 모두 있으면 met, 일부면 partial, 없으면 missing(용어가 없는 요건은 partial). */
function fakeDraftFit(ctx: Ctx): FitResult {
  const reqs = requirements(ctx.jd);
  const lower = ctx.resume.toLowerCase();
  const quotable = ctx.lines.filter((l) => !/^(기술:|#)/.test(l));
  const items = reqs.map(({ req }) => {
    const terms = [...new Set((`${req.text} ${req.jdQuote ?? ""}`.match(TECH_RE) ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))];
    const hit = terms.filter((t) => lower.includes(t.toLowerCase()));
    const status: FitResult["items"][number]["status"] = terms.length === 0 ? "partial" : hit.length === terms.length ? "met" : hit.length > 0 ? "partial" : "missing";
    const line = quotable.find((l) => hit.some((t) => l.toLowerCase().includes(t.toLowerCase()))) ?? quotable[0] ?? null;
    return {
      requirementId: req.id,
      status,
      evidenceQuote: status === "missing" ? null : line,
      note: status === "met" ? "요건을 보여 주는 줄이 있다." : status === "partial" ? "관련 줄은 있으나 요건 전체가 드러나지 않는다." : "이력서에 근거가 없다.",
    };
  });
  return {
    matchScore: computeMatchScore(items.map((it, i) => ({ status: it.status, must: reqs[i].must }))),
    summary: `요건 ${items.filter((i) => i.status === "met").length}/${items.length}개 충족.`,
    items,
    untappedStrengths: [],
  };
}

function fakeFit(ctx: Ctx): FitResult {
  if (isDraftReview(ctx)) return fakeDraftFit(ctx);
  const reqs = requirements(ctx.jd);
  const { withNumber } = classify(ctx.lines);
  const evidence = withNumber.length ? withNumber : ctx.lines;
  const items = reqs.map(({ req }, i) => {
    const status = FIT_CYCLE[i % FIT_CYCLE.length];
    return {
      requirementId: req.id,
      status,
      evidenceQuote: status === "missing" ? null : pick(evidence, i),
      note:
        status === "met"
          ? "요건을 직접 보여주는 경험과 결과가 있다."
          : status === "partial"
            ? "관련 경험은 있으나 수준·기간이 드러나지 않는다. 사용 범위와 결과를 덧붙이면 충족으로 볼 수 있다."
            : "이력서에 근거가 없다. 실제 경험이 있다면 해당 경력 아래에 한 줄로 추가해야 한다.",
    };
  });
  return {
    matchScore: computeMatchScore(items.map((it, i) => ({ status: it.status, must: reqs[i].must }))),
    summary: `필수 요건 일부는 실제 경력 줄로 뒷받침된다. 다만 ${items.filter((i) => i.status === "missing").length}개 요건은 근거가 전혀 없어 점수를 끌어내린다.`,
    items,
    untappedStrengths: [`"${pick(ctx.lines, 1).slice(0, 30)}" 경험을 ${ctx.role} 요건과 연결해 상단으로 올리면 적합도가 오른다.`],
  };
}

function fakeSynthesis(ctx: Ctx): SynthesisResult {
  const { plain, withNumber } = classify(ctx.lines);
  const p = plain.length ? plain : ctx.lines;
  const w = withNumber.length ? withNumber : ctx.lines;
  return {
    headline: "7명 중 2명만 통과 — 경력은 직무와 맞지만 결과 숫자와 키워드가 없어 서류 단계에서 걸린다.",
    strengths: [`${ctx.role}와 직접 관련된 경력이 이력서에 실제로 있다.`],
    mistakes: [
      {
        rank: 1,
        title: "성과 없이 담당 업무만 나열",
        quote: pick(p, 0),
        why: "ATS와 대표 모두 결과를 찾지 못해 지원자 간 비교에서 밀린다.",
        fix: "행동 + 대상 + 결과(숫자) 순서로 다시 쓰고, 모르는 수치는 확인 후 채운다.",
        severity: "critical",
        flaggedBy: ["ats", "ceo", "manager"],
      },
      {
        rank: 2,
        title: "JD 핵심 키워드 누락",
        quote: null,
        why: "자동 필터가 필수 요건 용어를 찾지 못해 사람 검토 전에 탈락한다.",
        fix: "실제로 써 본 도구·기술만 공고 표기 그대로 경력 줄에 넣는다.",
        severity: "critical",
        flaggedBy: ["ats", "rival"],
      },
      {
        rank: 3,
        title: "상단 3분의 1에 대표 성과가 없음",
        quote: pick(ctx.lines, 0),
        why: "30초 안에 판단하는 리크루터와 채용 담당자가 강점을 보지 못한다.",
        fix: "가장 강한 성과 한 줄을 상단 요약 첫 줄로 올린다.",
        severity: "major",
        flaggedBy: ["recruiter", "gatekeeper"],
      },
      {
        rank: 4,
        title: "숫자의 기준이 없음",
        quote: pick(w, 0),
        why: "무엇 대비 얼마나 바뀌었는지 없어 숫자가 검증되지 않는다.",
        fix: "기간·기준값·결과값을 함께 적는다.",
        severity: "major",
        flaggedBy: ["ceo", "gatekeeper"],
      },
      {
        rank: 5,
        title: "본인 몫과 협업 방식이 불분명",
        quote: pick(p, 1),
        why: "팀 성과 중 본인이 한 일이 구분되지 않아 역량을 판단할 수 없다.",
        fix: "본인이 맡은 범위와 함께 일한 대상(팀·부서)을 한 줄에 밝힌다.",
        severity: "minor",
        flaggedBy: ["teammate"],
      },
    ],
    closestToReject: null,
  };
}

function fakeRewrite(ctx: Ctx): RewriteResult {
  const synthesis = extractJson<SynthesisResult>(ctx.user, TAGS.synthesis);
  const ko = isKorean(ctx.resume);
  const lines = ctx.lines;
  const add = ko
    ? ["[ADD: 이 업무로 개선된 수치는? 예: 처리 시간 30% 단축]", "[ADD: 함께 일한 팀 규모와 본인 역할은?]"]
    : ["[ADD: What measurable result did this produce? e.g. cut processing time 30%]", "[ADD: Team size and your exact role?]"];
  const heading = ko
    ? { summary: "## 요약", exp: "## 경력", skills: "## 기술" }
    : { summary: "## Summary", exp: "## Experience", skills: "## Skills" };
  const body = lines.slice(1).map((l, i) => (i === 0 ? `- ${l} — ${add[0]}` : i === 1 ? `- ${l} — ${add[1]}` : `- ${l}`));
  const resumeMarkdown = [
    `# ${lines[0]}`,
    "",
    heading.summary,
    ko ? `${ctx.role} 지원. ${add[0]}` : `Applying for ${ctx.role}. ${add[0]}`,
    "",
    heading.exp,
    ...body,
    "",
    heading.skills,
    ...(ctx.jd?.keywords ?? []).filter((k) => ctx.resume.toLowerCase().includes(k.toLowerCase())).map((k) => `- ${k}`),
  ].join("\n");
  const mistakes = synthesis?.mistakes ?? [];
  return {
    resumeMarkdown,
    changes: [
      { mistakeRank: mistakes[0]?.rank ?? 1, before: pick(lines, 1), after: `${pick(lines, 1)} — ${add[0]}` },
      { mistakeRank: mistakes[2]?.rank ?? null, before: null, after: heading.summary },
      ...mistakes.slice(1).map((m, i) => ({
        mistakeRank: m.rank,
        before: m.quote,
        after: m.quote ? `${m.quote} — ${add[i % 2]}` : m.fix,
      })),
    ],
    addQuestions: ["이 업무로 개선된 수치(기준값과 결과값)는 무엇인가?", "함께 일한 팀 규모와 본인이 맡은 범위는?"],
    assumptions: ["최근 경력을 가장 직무 관련성이 높은 경험으로 보고 상단에 배치했다(추정)."],
  };
}

function fakePlan(ctx: Ctx): ImprovementPlan {
  const synthesis = extractJson<SynthesisResult>(ctx.user, TAGS.synthesis);
  const fit = extractJson<FitResult>(ctx.user, TAGS.fit);
  const reqs = requirements(ctx.jd);
  const gaps = (fit?.items ?? []).filter((i) => i.status !== "met");
  const reqText = (id: string) => reqs.find((r) => r.req.id === id)?.req.text ?? id;
  const top = synthesis?.mistakes[0];
  return {
    headline: `'업무 담당자'가 아니라 '${ctx.role} 결과를 낸 사람'으로 이력서의 중심을 옮긴다.`,
    positioning: `이력서에 이미 있는 실무 경험을 근거로, ${ctx.role}가 해결해야 할 핵심 문제를 직접 다뤄 본 사람으로 내세운다. 가장 강한 경력 한 줄을 상단 요약으로 올리고, 각 경력은 결과 수치로 끝맺는다. 근거가 없는 요건은 숨기지 말고 학습 계획으로 설명한다.`,
    priorities: [
      {
        title: "경력 불릿을 결과 중심으로 다시 쓰기",
        why: `#1(${top?.title ?? "성과 없이 업무 나열"}) — 7명 중 다수가 지적한 가장 큰 탈락 사유다.`,
        actions: ["경력마다 가장 중요한 불릿 2개를 골라 기준값→결과값을 붙인다", "'참여'·'지원' 표현을 본인이 한 행동 동사로 바꾼다"],
        impact: "high",
        effort: "low",
      },
      {
        title: "JD 키워드를 근거와 함께 배치하기",
        why: `#2 키워드 누락 — ${gaps[0] ? `${gaps[0].requirementId}(${reqText(gaps[0].requirementId)})` : "필수 요건"} 근거가 약하다.`,
        actions: ["실제 써 본 도구만 공고 표기 그대로 경력 줄에 넣는다", "기술 섹션을 공고 순서에 맞춰 재정렬한다"],
        impact: "high",
        effort: "low",
      },
      {
        title: "실제 역량 공백 메우기",
        why: "이력서 문장으로는 못 메우는 요건이 있어 다음 지원까지 증거를 만들어야 한다.",
        actions: ["공백 요건 하나를 골라 2주짜리 작은 프로젝트를 만들고 결과를 링크로 남긴다"],
        impact: "medium",
        effort: "high",
      },
    ],
    quickWins: [
      "상단 요약 첫 줄에 가장 강한 성과 한 줄을 올리기",
      "섹션명을 요약/경력/기술/학력 표준 이름으로 바꾸기",
      "날짜 형식을 YYYY.MM ~ YYYY.MM으로 통일하기",
    ],
    sectionGuidance: [
      { section: "상단 요약", direction: `${ctx.role} 지원 이유와 대표 성과 하나를 두 줄 안에 쓴다.` },
      { section: "경력", direction: "각 경력은 직함 · 회사 · 기간 한 줄 + 결과 중심 불릿 3~5개로 정리한다." },
      { section: "기술", direction: "공고 키워드 중 실제로 쓴 것만, 공고 표기 그대로 나열한다." },
    ],
    skillGaps: gaps
      .filter((g) => g.status === "missing")
      .slice(0, 3)
      .map((g) => ({
        skill: reqText(g.requirementId),
        requirementId: g.requirementId,
        howToClose: "해당 역량을 쓰는 작은 프로젝트를 만들어 결과를 정리하고, 현 직장에서 관련 업무를 자원해 맡는다.",
        timeframe: "1~3개월",
      })),
    applicationStrategy: [
      "커버레터 첫 문단에서 가장 큰 공백 요건을 먼저 언급하고 메우는 계획을 밝힌다",
      "대표 성과 하나를 1쪽 사례 문서로 만들어 포트폴리오 링크로 첨부한다",
      ...(ctx.jd?.source === "inferred" ? ["실제 채용 공고를 구해 JD를 넣고 다시 진단한다"] : []),
    ],
    interviewPrep: [
      { question: "가장 큰 성과를 숫자로 설명해 달라", angle: `"${pick(ctx.lines, 2).slice(0, 30)}" 경험의 기준값·결과값·기간으로 답한다.` },
      { question: "이 직무의 핵심 도구를 어느 수준까지 써 봤나", angle: "실제 사용 사례 하나와 그 결과로 답하고, 부족한 부분은 학습 계획으로 보완한다." },
      { question: "팀에서 본인 몫은 무엇이었나", angle: "팀 규모, 본인 담당 범위, 의사결정 하나를 구체적으로 말한다." },
      { question: "이력서의 공백 기간 또는 직무 전환 이유는", angle: "지원 직무와 연결되는 이유와 그동안 쌓은 관련 경험으로 답한다." },
    ],
  };
}

function fakeOutput(stage: StageKey, ctx: Ctx): StageOutputs[StageKey] {
  switch (stage) {
    case "jd":
      return fakeJd(ctx);
    case "ats":
      return fakeAts(ctx, false);
    case "rescreen":
      return fakeAts(ctx, true);
    case "gatekeeper":
      return fakeGatekeeper(ctx);
    case "manager":
    case "rival":
    case "ceo":
    case "recruiter":
    case "teammate":
      return fakeReader(ctx, stage);
    case "fit":
      return fakeFit(ctx);
    case "synthesis":
      return fakeSynthesis(ctx);
    case "rewrite":
      return fakeRewrite(ctx);
    case "plan":
      return fakePlan(ctx);
  }
}

// ---------------------------------------------------------------------------
// 파이프라인 밖 기능(task)의 가짜 출력 — 프롬프트의 CHAT_TAGS 태그에서 자료를 읽는다.
// ---------------------------------------------------------------------------

/**
 * 가짜 answeredFollowups: 최근 메시지에 적힌 `#answered:<id>` 표시를 그대로 낸다(목록에 없는 id도 — 서버가 거르는지 시험한다).
 * 표시가 없으면 [] — 사용자가 답한 것을 알아보는 판단은 실제 LLM의 몫이다.
 */
function fakeAnsweredFollowups(message: string): string[] {
  return [...message.matchAll(/#answered:([\w-]+)/g)].map((m) => m[1]!).slice(0, 15);
}

function fakeGraphChat(user: string): GraphChatOutput {
  const out = fakeGraphChatBody(user);
  return { ...out, answeredFollowups: fakeAnsweredFollowups(extractTag(user, CHAT_TAGS.latestMessage) ?? "") };
}

function fakeGraphChatBody(user: string): GraphChatOutput {
  const message = (extractTag(user, CHAT_TAGS.latestMessage) ?? "").trim();
  if (!message) {
    return { reply: "어떤 경험을 정리할까요? 회사·프로젝트·맡은 일·결과를 편하게 말씀해 주세요.", ops: [], summary: "", followUpQuestions: [] };
  }
  const firstLine = message.split(/\r?\n/)[0]!.trim();
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  const skills = [...new Set((message.match(TECH_RE) ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 3);
  const blank = { ref: "", id: "", label: "" as const, props: [], type: "" as const, from: "", to: "" };
  // 프로젝트 단위 대화: 그 프로젝트의 action을 채우고 기술을 프로젝트에 잇는다. 질문은 체크리스트의 '물을 질문' 하나.
  const focus = extractTag(user, CHAT_TAGS.focusProject);
  const projectId = focus ? /구조화할 프로젝트: \[([^\]]+)\]/.exec(focus)?.[1] : undefined;
  if (projectId) {
    // 남은 후속 질문이 있으면 그 첫 질문을 그대로 묻는다(P6), 없으면 체크리스트의 '물을 질문'.
    const followups = extractTag(user, CHAT_TAGS.followupQuestions);
    const question = (followups ? /^1\. (.+)$/m.exec(followups)?.[1] : undefined) ?? /물을 질문: (.+?) 넣을 곳:/.exec(focus!)?.[1];
    const ops: GraphChatOutput["ops"] = [
      { ...blank, op: "updateNode", id: projectId, label: "Project", props: [{ key: "action", value: message.slice(0, 500) }] },
      ...skills.flatMap((name, i): GraphChatOutput["ops"] => [
        { ...blank, op: "addNode", ref: `new:skill${i}`, label: "Skill", props: [{ key: "name", value: name }] },
        { ...blank, op: "addEdge", type: "USED_SKILL", from: projectId, to: `new:skill${i}` },
      ]),
    ];
    return {
      reply: `말씀하신 내용을 프로젝트의 한 일로 정리했어요.${question ? ` ${question}` : ""}`,
      ops,
      summary: `프로젝트 한 일 보강${skills.length ? `, 기술 ${skills.length}개 연결` : ""}`,
      followUpQuestions: question ? [question] : [],
    };
  }
  const ops: GraphChatOutput["ops"] = [
    {
      ...blank,
      op: "addNode",
      ref: "new:exp",
      label: "Experience",
      props: [
        { key: "title", value: title },
        { key: "description", value: message.slice(0, 500) },
      ],
    },
    { ...blank, op: "addEdge", type: "HAS_EXPERIENCE", from: "me", to: "new:exp" },
    ...skills.flatMap((name, i): GraphChatOutput["ops"] => [
      { ...blank, op: "addNode", ref: `new:skill${i}`, label: "Skill", props: [{ key: "name", value: name }] },
      { ...blank, op: "addEdge", type: "USED_SKILL", from: "new:exp", to: `new:skill${i}` },
    ]),
  ];
  return {
    reply: `말씀하신 내용을 '${title}' 경험으로 정리했어요.${skills.length ? ` 사용한 기술(${skills.join(", ")})도 연결했습니다.` : ""} 확인 후 적용해 주세요.`,
    ops,
    summary: `경험 1개${skills.length ? `, 기술 ${skills.length}개` : ""} 추가`,
    followUpQuestions: ["이 경험은 언제부터 언제까지였나요?", "결과를 숫자로 말할 수 있나요? 예: 처리 시간 30% 단축"],
  };
}

function fakeReviewerChat(user: string): ReviewerChatOutput {
  const resume = extractTag(user, CHAT_TAGS.resume) ?? "";
  const lines = quotableLines(resume);
  const before = resume.trim() ? pick(lines, 1) : null;
  const reviewer = extractField(user, "심사위원") ?? "심사위원";
  return {
    reply: `${reviewer}로서 보면, 지적한 줄은 무엇을 했는지만 있고 결과가 없습니다. 아래처럼 결과를 숫자로 붙이면 제 판단이 달라질 수 있어요.`,
    suggestedEdits: [
      {
        before,
        after: before ? `${before} — [ADD: 이 일로 바뀐 수치는? 예: 처리 시간 30% 단축]` : "[ADD: 대표 성과 한 줄]",
        reason: "결과 수치가 있어야 같은 경력의 다른 지원자와 비교할 수 있다.",
      },
    ],
    followUpQuestions: ["이 업무로 개선된 지표와 기간은 무엇인가요?"],
    verdictOutlook: "수치를 채우면 '보류'에서 '합격' 쪽으로 기울 가능성이 있다(추정).",
  };
}

function fakeResumeDraft(user: string): ResumeDraftOutput {
  const resume = extractTag(user, CHAT_TAGS.resume) ?? "";
  const lines = resume.trim() ? quotableLines(resume) : [];
  const company = extractField(user, "지원 회사") ?? "지원 회사";
  const role = extractField(user, "지원 직무") ?? "지원 직무";
  const doc = emptyResumeDocument();
  doc.basics.name = resume.split(/\r?\n/).map((l) => l.trim()).find(Boolean)?.slice(0, 80) ?? "[ADD: 이름]";
  doc.basics.headline = role.slice(0, 160);
  doc.basics.tagline = `[ADD: 경력으로 보여 줄 ${role} 한 줄 소개]`.slice(0, 200);
  doc.summary = `${company} ${role} 포지션에 지원합니다. [ADD: 대표 성과 한 줄]`;
  doc.experience = [
    {
      company: "[ADD: 회사]",
      department: "",
      title: role.slice(0, 120),
      startDate: "",
      endDate: "",
      location: "",
      scope: "",
      bullets: (lines.length > 1 ? lines.slice(1, 5) : ["[ADD: 주요 업무와 결과]"]).map((l) => l.slice(0, 500)),
    },
  ];
  return {
    document: doc,
    notes: ["가짜 초안: 기존 이력서 줄을 경력 불릿으로 옮겼다."],
    missingInfo: ["회사명과 재직 기간은?", "대표 성과의 수치는?"],
  };
}

/**
 * 가짜 포트폴리오: 그래프 자료의 `프로젝트 [id] 이름` 머리줄마다 프로젝트 하나. 프롬프트의 `포트폴리오 양식: 이름 [id]`로 양식을 읽어
 * 그 양식의 첫 프로젝트 text 구역에 [ADD]를, 마지막 필수 text 구역에 result 속성 줄과 일부러 자료에 없는 수치 줄(999%)을 넣는다
 * (서버의 수치 확인·양식 순서를 시험한다).
 */
function fakePortfolioDraft(user: string): GraphPortfolioOutput {
  const graph = extractTag(user, CHAT_TAGS.careerGraph) ?? "";
  const tpl = getPortfolioTemplate(/포트폴리오 양식: .*\[([a-z-]+)\]/.exec(user)?.[1]);
  const textKeys = tpl.project.filter((s) => s.kind === "text" && !s.optional).map((s) => s.key);
  const blocks = graph.split(/\n=====\n/);
  const projects = blocks.flatMap((b) => {
    const m = /프로젝트 \[([^\]]+)\] (.+)/.exec(b);
    if (!m) return [];
    const result = /- result: (.+)/.exec(b)?.[1]?.trim() ?? "";
    return [
      {
        projectId: m[1]!,
        name: m[2]!.trim(),
        oneLiner: `${m[2]!.trim()} 소개`,
        period: "",
        affiliation: "",
        techStack: [],
        sections: [
          { key: textKeys[0]!, body: "[ADD: 프로젝트 배경]", bullets: [] },
          { key: "unknown-key", body: "양식에 없는 구역", bullets: [] },
          { key: textKeys[textKeys.length - 1]!, body: "", bullets: [...(result ? [result] : []), "전환율 999% 향상"] },
        ],
      },
    ];
  });
  return {
    headline: "그래프로 정리한 프로젝트 포트폴리오",
    coreSkills: [],
    sections: [],
    projects,
    notes: ["가짜 포트폴리오"],
    missingInfo: ["대표 프로젝트의 팀 규모는?"],
  };
}

/** 가짜 구역 추출: "주요 업무"·"자격 요건"·"우대 사항"·"복리후생"·"채용 절차" 제목 아래 줄을 그대로 복사한다. */
const FAKE_SECTION_HEADINGS: [RegExp, keyof PostingSectionsLlm][] = [
  [/^(?:주요|담당)\s*업무|^(?:responsibilities|what you(?:'|’)ll do)$/i, "duties"],
  [/^(?:자격\s*요건|필수\s*(?:요건|사항)|지원\s*자격)|^(?:requirements|qualifications)$/i, "requirements"],
  [/^우대|^(?:nice to have|preferred qualifications)$/i, "preferred"],
  [/^(?:복리\s*후생|복지|혜택)|^(?:benefits|perks)$/i, "benefits"],
  [/^(?:전형\s*절차|채용\s*절차)|^(?:hiring|interview) process$/i, "process"],
  [/^(?:회사\s*소개|기업\s*소개)|^about us$/i, "companyIntro"],
];

function fakeSections(lines: string[], summary: string): PostingSectionsLlm {
  const out: PostingSectionsLlm = {
    companyIndustry: "",
    companySize: "",
    companyIntro: [],
    summary,
    duties: [],
    requirements: [],
    preferred: [],
    techStack: [],
    salary: "",
    workHours: "",
    conditionsOther: [],
    benefits: [],
    process: [],
    documents: [],
    applyMethod: [],
    notes: [],
  };
  type ListKey = "companyIntro" | "duties" | "requirements" | "preferred" | "benefits" | "process";
  let current: ListKey | null = null;
  for (const raw of lines) {
    const line = raw.replace(/^[-•·*\s]+/, "").trim();
    const heading = FAKE_SECTION_HEADINGS.find(([re]) => re.test(line));
    if (heading && line.length <= 20) {
      current = heading[1] as ListKey;
      continue;
    }
    const salary = /^(?:연봉|급여|salary|compensation)\s*[:：]\s*(.+)$/i.exec(line);
    if (salary) {
      out.salary = salary[1]!.slice(0, 120);
      current = null;
      continue;
    }
    if (/[:：]$/.test(line)) {
      current = null;
      continue;
    }
    if (current && line) (out[current] as string[]).push(line.slice(0, 300));
  }
  const listed = [...out.duties, ...out.requirements, ...out.preferred].join("\n");
  // 영문 공고는 라틴 낱말이 모두 기술처럼 잡히므로 비워 둔다(근거 검증이 기술 사전으로 채운다).
  const english = !/[가-힣]/.test(listed);
  out.techStack = english ? [] : [...new Set((listed.match(TECH_RE) ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 30);
  return out;
}

/**
 * 공고 페이지 본문(<posting_page>)에서 "회사: …", "직무: …"(모집 직무·포지션·모집 분야), 마감/접수 줄의 날짜·시각을 읽는다.
 * 근거(*Evidence)는 본문 줄을 그대로 쓴다. 회사·직무 줄이 없으면 isJobPosting=false(목록·로그인 페이지 흉내).
 * 근거 검증 실패를 시험하려면 본문에 "[가짜:근거없음]"을 넣는다 — 근거 문구를 본문에 없는 말로 바꾼다.
 * 구역(sections)은 fakeSections — 구역만 다시 정리하는 요청(PostingSectionsOnlySchema)도 같은 출력에서 sections만 읽힌다.
 */
function fakePostingExtract(user: string): PostingExtract {
  const page = extractTag(user, CHAT_TAGS.postingPage) ?? "";
  const lines = page.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const find = (re: RegExp) => {
    for (const line of lines) {
      const m = re.exec(line);
      if (m) return { line, value: (m[1] ?? "").trim() };
    }
    return null;
  };
  // 영문 공고도 읽는다("Company: …", "Role: …", "Location: …", "Apply by …").
  const company = find(/^(?:회사|회사명|기업|기업명|company)\s*[:：]\s*(.+)$/i);
  const role = find(/^(?:직무|모집\s*직무|포지션|모집\s*분야|role|position|job title)\s*[:：]\s*(.+)$/i);
  const deadlineLine = lines.find((l) => /마감|접수\s*기간|지원\s*기간|deadline|apply by/i.test(l)) ?? "";
  const date = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(deadlineLine);
  const time = /(\d{1,2}):(\d{2})/.exec(deadlineLine);
  const pad = (v: string) => v.padStart(2, "0");
  const fakeEvidence = page.includes("[가짜:근거없음]");
  const blank: PostingExtract = {
    isJobPosting: false,
    company: "",
    companyEvidence: "",
    roleTitle: "",
    roleEvidence: "",
    employmentType: "unknown",
    workType: "unknown",
    location: "",
    careerLevel: "unknown",
    deadline: "",
    deadlineTime: "",
    deadlineEvidence: "",
    rolling: false,
    sections: fakeSections(lines, ""),
  };
  if (!company || !role) return blank;
  const has = (re: RegExp) => re.test(page);
  return {
    ...blank,
    isJobPosting: true,
    company: company.value.slice(0, 200),
    companyEvidence: fakeEvidence ? "본문에 없는 회사 문구" : company.line.slice(0, 500),
    roleTitle: role.value.slice(0, 300),
    roleEvidence: fakeEvidence ? "본문에 없는 직무 문구" : role.line.slice(0, 500),
    employmentType: has(/인턴/) ? "intern" : has(/계약직/) ? "contract" : has(/정규직|full-time/i) ? "full_time" : "unknown",
    workType: has(/원격|리모트/) ? "remote" : has(/하이브리드|hybrid/i) ? "hybrid" : "unknown",
    location: find(/^(?:근무지|근무\s*지역|위치|location)\s*[:：]\s*(.+)$/i)?.value.slice(0, 300) ?? "",
    careerLevel: has(/신입/) ? "entry" : has(/경력\s*무관/) ? "any" : has(/경력/) ? "experienced" : "unknown",
    deadline: date ? `${date[1]}-${pad(date[2]!)}-${pad(date[3]!)}` : "",
    deadlineTime: date && time ? `${pad(time[1]!)}:${time[2]}` : "",
    deadlineEvidence: date ? deadlineLine.slice(0, 500) : "",
    rolling: has(/상시\s*채용|채용\s*시\s*마감/),
    sections: fakeSections(lines, `${company.value} ${role.value} 포지션입니다.`.replace(/\d+/g, "").slice(0, 300)),
  };
}

/** 가짜 번역에서 바꾸는 영어 낱말(대소문자 무시, 낱말 단위). 숫자·고유명사는 그대로 남는다. */
const FAKE_KO_WORDS: [RegExp, string][] = [
  [/\bsenior\b/gi, "시니어"],
  [/\bbackend\b/gi, "백엔드"],
  [/\bfrontend\b/gi, "프론트엔드"],
  [/\bengineer\b/gi, "엔지니어"],
  [/\bremote\b/gi, "원격"],
  [/\bseoul\b/gi, "서울"],
  [/\bexperience\b/gi, "경험"],
  [/\byears\b/gi, "년"],
];

/** 가짜 번역: 아는 낱말만 바꾸고, 한글이 하나도 없으면 앞에 '(번역) '을 붙인다(개수·순서·숫자·이름은 그대로). */
function fakeKo(text: string): string {
  if (!text) return text;
  let out = text;
  for (const [re, ko] of FAKE_KO_WORDS) out = out.replace(re, ko);
  return /[가-힣]/.test(out) ? out : `(번역) ${out}`;
}

/** 가짜 공고 번역(task 'posting-translate'): <posting_page>의 JSON 값을 같은 키·같은 개수로 fakeKo. */
function fakePostingTranslate(user: string): unknown {
  const raw = extractTag(user, CHAT_TAGS.postingPage) ?? "{}";
  const input = JSON.parse(raw) as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(input)) {
    out[k] = Array.isArray(v) ? v.map((x) => fakeKo(String(x))) : fakeKo(String(v ?? ""));
  }
  return out;
}

/**
 * 가짜 문서 가져오기: <resume>/<portfolio>에서 "회사: …", "직무: …", "프로젝트: …", "성과: …" 줄과 사전 기술을 읽어 변경안을 만든다.
 * 문서에 "[가짜:지어냄]"이 있으면 문서에 없는 회사·수치를, "[가짜:삭제]"가 있으면 deleteNode를 섞는다(서버 검증 시험용).
 */
function fakeGraphImport(user: string): GraphImportOutput {
  const doc = extractTag(user, CHAT_TAGS.resume) ?? extractTag(user, CHAT_TAGS.portfolio) ?? "";
  const lines = doc.split(/\r?\n/).map((l) => l.replace(BULLET_RE, "").trim());
  const value = (re: RegExp) => lines.map((l) => re.exec(l)?.[1]?.trim()).filter((v): v is string => Boolean(v));
  const blank = { ref: "", id: "", label: "" as const, props: [], type: "" as const, from: "", to: "" };
  const ops: GraphImportOutput["ops"] = [];
  const company = value(/^(?:회사|회사명)\s*[:：]\s*(.+)$/)[0];
  const role = value(/^(?:직무|직함)\s*[:：]\s*(.+)$/)[0];
  const projects = value(/^프로젝트\s*[:：]\s*(.+)$/).slice(0, 5);
  const achievements = value(/^성과\s*[:：]\s*(.+)$/).slice(0, 5);
  if (company) {
    ops.push({ ...blank, op: "addNode", ref: "new:company", label: "Company", props: [{ key: "name", value: company.slice(0, 120) }] });
    ops.push({ ...blank, op: "addEdge", type: "WORKED_AT", from: "me", to: "new:company" });
  }
  if (role) {
    ops.push({ ...blank, op: "addNode", ref: "new:role", label: "Role", props: [{ key: "title", value: role.slice(0, 120) }] });
    ops.push({ ...blank, op: "addEdge", type: "HAD_ROLE", from: "me", to: "new:role" });
    if (company) ops.push({ ...blank, op: "addEdge", type: "AT_COMPANY", from: "new:role", to: "new:company" });
  }
  projects.forEach((name, i) => {
    ops.push({ ...blank, op: "addNode", ref: `new:p${i}`, label: "Project", props: [{ key: "name", value: name.slice(0, 120) }] });
    ops.push({ ...blank, op: "addEdge", type: "WORKED_ON", from: role ? "new:role" : "me", to: `new:p${i}` });
  });
  achievements.forEach((text, i) => {
    ops.push({
      ...blank,
      op: "addNode",
      ref: `new:a${i}`,
      label: "Achievement",
      props: [
        { key: "summary", value: text.slice(0, 300) },
        { key: "value", value: (text.match(/[\d.,]+\s*[%％배명건원시간분초]*(?:\s*(?:→|->|에서)\s*[\d.,]+\s*[%％배명건원시간분초]*)?/)?.[0] ?? text).slice(0, 80) },
      ],
    });
    ops.push({ ...blank, op: "addEdge", type: "ACHIEVED", from: projects.length ? "new:p0" : "me", to: `new:a${i}` });
  });
  extractKeywords(doc)
    .slice(0, 6)
    .forEach((name, i) => {
      ops.push({ ...blank, op: "addNode", ref: `new:s${i}`, label: "Skill", props: [{ key: "name", value: name }] });
      ops.push(
        projects.length
          ? { ...blank, op: "addEdge", type: "USED_SKILL", from: "new:p0", to: `new:s${i}` }
          : { ...blank, op: "addEdge", type: "HAS_SKILL", from: "me", to: `new:s${i}` },
      );
    });
  if (doc.includes("[가짜:지어냄]")) {
    ops.push({ ...blank, op: "addNode", ref: "new:fake", label: "Company", props: [{ key: "name", value: "지어낸주식회사" }] });
    ops.push({ ...blank, op: "addEdge", type: "WORKED_AT", from: "me", to: "new:fake" });
    ops.push({ ...blank, op: "addNode", ref: "new:fakea", label: "Achievement", props: [{ key: "summary", value: "매출 증가" }, { key: "value", value: "987%" }] });
    ops.push({ ...blank, op: "addEdge", type: "ACHIEVED", from: "me", to: "new:fakea" });
  }
  if (doc.includes("[가짜:삭제]")) ops.push({ ...blank, op: "deleteNode", id: "n_any" });
  return {
    reply: `문서에서 ${[company && "회사", role && "직무", projects.length && "프로젝트", achievements.length && "성과"].filter(Boolean).join("·") || "기술"}을(를) 정리했어요. 확인 후 적용해 주세요.`,
    ops,
    summary: `문서에서 ${ops.filter((o) => o.op === "addNode").length}개 항목 추출`,
    followUpQuestions: ["이 직무의 재직 기간은 언제부터 언제까지였나요?"],
  };
}

/**
 * 가짜 GitHub 저장소 가져오기: <focus_project>의 프로젝트 id에 <github_repo>의 설명(summary)·첫 커밋 메시지(action)·첫 커밋 달(startDate)을
 * 채우고, 사전 기술을 이 프로젝트에 잇는다. 후속 질문 5개. 저장소 글에 "[가짜:지어냄]"이 있으면 저장소에 없는 기술·수치 성과를,
 * "[가짜:삭제]"가 있으면 deleteNode를, "[가짜:범위밖:<id>]"가 있으면 그 노드의 updateNode를 섞는다(서버 검증 시험용).
 */
function fakeGraphRepoImport(user: string): GraphRepoImportOutput {
  const brief = extractTag(user, CHAT_TAGS.githubRepo) ?? "";
  const focus = extractTag(user, CHAT_TAGS.focusProject) ?? "";
  const projectId = /구조화할 프로젝트: \[([^\]]+)\]/.exec(focus)?.[1] ?? extractField(user, "구조화할 프로젝트 id") ?? "";
  const blank = { ref: "", id: "", label: "" as const, props: [], type: "" as const, from: "", to: "" };
  const ops: GraphRepoImportOutput["ops"] = [];
  const description = /^설명: (.+)$/m.exec(brief)?.[1];
  const firstCommit = /^- (\d{4}-\d{2})-\d{2} (.+)$/m.exec(brief);
  const started = /첫 커밋 (\d{4}-\d{2})/.exec(brief)?.[1] ?? firstCommit?.[1];
  const props = [
    ...(description ? [{ key: "summary", value: description.slice(0, 300) }] : []),
    ...(firstCommit ? [{ key: "action", value: firstCommit[2]!.slice(0, 300) }] : []),
    ...(started ? [{ key: "startDate", value: started }] : []),
  ];
  if (projectId && props.length) ops.push({ ...blank, op: "updateNode", id: projectId, label: "Project", props });
  extractKeywords(brief)
    .slice(0, 6)
    .forEach((name, i) => {
      ops.push({ ...blank, op: "addNode", ref: `new:s${i}`, label: "Skill", props: [{ key: "name", value: name }] });
      ops.push({ ...blank, op: "addEdge", type: "USED_SKILL", from: projectId, to: `new:s${i}` });
    });
  if (brief.includes("[가짜:지어냄]")) {
    ops.push({ ...blank, op: "addNode", ref: "new:fakeskill", label: "Skill", props: [{ key: "name", value: "Haskell" }] });
    ops.push({ ...blank, op: "addEdge", type: "USED_SKILL", from: projectId, to: "new:fakeskill" });
    ops.push({ ...blank, op: "addNode", ref: "new:fakea", label: "Achievement", props: [{ key: "summary", value: "매출 증가" }, { key: "value", value: "987%" }] });
    ops.push({ ...blank, op: "addEdge", type: "ACHIEVED", from: projectId, to: "new:fakea" });
  }
  if (brief.includes("[가짜:삭제]")) ops.push({ ...blank, op: "deleteNode", id: projectId || "n_any" });
  const outside = /\[가짜:범위밖:([A-Za-z0-9_-]+)\]/.exec(brief)?.[1];
  if (outside) ops.push({ ...blank, op: "updateNode", id: outside, label: "Project", props: [{ key: "summary", value: "저장소에서 고침" }] });
  return {
    reply: "저장소 정보로 프로젝트 요약·한 일·기술을 정리했어요. 저장소만으로 알 수 없는 것을 몇 가지 여쭤볼게요.",
    ops,
    summary: `저장소에서 ${ops.filter((o) => o.op === "addNode").length}개 항목 추출`,
    followUpQuestions: [
      "이 프로젝트에서 맡은 역할과 기여 비중은 어느 정도였나요?",
      "이 프로젝트를 시작한 배경이나 풀려던 문제는 무엇이었나요?",
      "결과를 숫자로 말할 수 있나요? 예: 사용자 수, 처리 시간",
      "팀 구성과 기간이 저장소 기록과 맞나요?",
      "이 프로젝트에서 배운 점은 무엇인가요?",
    ],
  };
}

/** 출처 표(<graph_sources>)의 "[n] 라벨 · 이름" 줄. */
function sourceLines(user: string): { n: number; text: string }[] {
  const body = extractTag(user, CHAT_TAGS.graphSources) ?? "";
  return [...body.matchAll(/^\[(\d{1,2})\]\s+(.+)$/gm)].map((m) => ({ n: Number(m[1]), text: m[2]!.trim() }));
}

/**
 * 가짜 그래프 답변: 출처 [1]·[2]를 인용한다. 출처가 없거나 "직접 맞는 항목을 찾지 못해" 안내가 있으면 insufficient.
 * 질문에 "[가짜:잘못된인용]"이 있으면 없는 번호 [99]도 인용한다(서버 인용 검증 시험용).
 */
function fakeGraphQa(user: string): GraphQaOutput {
  const sources = sourceLines(user);
  const body = extractTag(user, CHAT_TAGS.graphSources) ?? "";
  const question = extractTag(user, CHAT_TAGS.latestMessage) ?? "";
  if (sources.length === 0 || body.includes("직접 맞는 항목을 찾지 못해")) {
    return {
      answer: "그래프에 아직 이 질문에 답할 정보가 없습니다.",
      usedSources: [],
      insufficient: true,
      missingInfo: ["질문과 관련된 경험·프로젝트"],
    };
  }
  const [a, b] = sources;
  const bogus = question.includes("[가짜:잘못된인용]") ? " 그리고 다른 사실도 있습니다 [99]." : "";
  return {
    answer: `그래프에 따르면 ${a!.text}입니다 [${a!.n}].${b ? ` 관련해서 ${b.text}도 있습니다 [${b.n}].` : ""}${bogus}`,
    usedSources: [a!.n, ...(b ? [b.n] : [])],
    insufficient: false,
    missingInfo: [],
  };
}

/** 에이전트 대화록의 근거 블록: [ev_…] 머리줄 + 본문 첫 줄. */
export function agentEvidence(user: string): { id: string; handle: string | null; kind: string; first: string }[] {
  const out: { id: string; handle: string | null; kind: string; first: string }[] = [];
  for (const m of user.matchAll(/<evidence>\n\[(ev_[A-Za-z0-9_-]{22})\](?: (N\d+|C\d+))? · ([^\n·]+)[^\n]*\n([^\n]*)/g)) {
    out.push({ id: m[1]!, handle: m[2] ?? null, kind: m[3]!.trim(), first: m[4]!.trim() });
  }
  return out;
}

/**
 * 가짜 경험 질문하기 에이전트: 1스텝은 resolve_entity + search_chunks, 그다음(또는 마지막 스텝)은 받은 근거 앞 2개를 그대로 옮긴 fact로 답한다.
 * 근거가 없으면 gap 한 개(insufficient).
 */
function fakeGraphAgentStep(user: string, finalOnly: boolean): unknown {
  const question = (extractTag(user, CHAT_TAGS.question) ?? "").trim();
  const evidence = agentEvidence(user).filter((e) => e.kind !== "스키마(정적 문서, 근거 아님)");
  const started = /\n스텝 \d+/.test(user);
  if (!finalOnly && !started) {
    return {
      action: "call_tools",
      thought: "엔티티 연결과 문서 검색",
      calls: [
        { tool: "resolve_entity", args: { text: question.slice(0, 100) || "경험" } },
        { tool: "search_chunks", args: { query: question.slice(0, 300) || "경험" } },
      ],
    };
  }
  const picked = evidence.slice(0, 2);
  const answer =
    picked.length > 0
      ? {
          segments: picked.map((e) => ({ text: e.first.slice(0, 300) || "근거", kind: "fact", evidenceIds: [e.id] })),
          insufficient: false,
          missingInfo: [],
        }
      : { segments: [{ text: "그래프에 아직 이 질문에 답할 정보가 없습니다.", kind: "gap", evidenceIds: [] }], insufficient: true, missingInfo: ["질문과 관련된 경험"] };
  return { action: "final", answer };
}

/** 가짜 리랭크: 후보 순서를 관련도로(앞 3개 3, 다음 3개 2, 나머지 1). */
function fakeGraphQaRerank(user: string): GraphQaRerankOutput {
  const body = extractTag(user, CHAT_TAGS.graphSources) ?? "";
  const ids = [...body.matchAll(/^\[(c\d{1,2})\]/gm)].map((m) => m[1]!);
  return { ratings: ids.slice(0, 20).map((id, i) => ({ id, relevance: i < 3 ? 3 : i < 6 ? 2 : 1 })) };
}

/** `[r1] (라벨) 본문` 줄 → { id, text }. */
function interviewLines(user: string): { id: string; text: string }[] {
  const body = extractTag(user, CHAT_TAGS.interviewSources) ?? "";
  return [...body.matchAll(/^\[([rpj]\d{1,4})\](?: \([^)]*\))? (.+)$/gm)].map((m) => ({ id: m[1]!, text: m[2]!.trim() }));
}

/** 가짜 면접 질문: 근거 줄 앞 3개에 서류 한 줄 질문, 첫 줄에 PIVOT O 질문, 지원 동기 1개. 인용은 줄 앞 20자. */
function fakeInterviewQuestions(user: string): InterviewQuestionsOutput {
  const lines = interviewLines(user).filter((l) => l.id.startsWith("r") || l.id.startsWith("p"));
  const cite = (l: { id: string; text: string }) => [{ ref: l.id, quote: l.text.slice(0, 20) }];
  const questions: InterviewQuestionsOutput["questions"] = lines.slice(0, 3).map((l) => ({
    category: "line",
    facet: "why",
    question: `"${l.text.slice(0, 30)}" — 왜 이 일이 필요했나요?`,
    intent: "필요성과 배경을 설명할 수 있는지",
    citations: cite(l),
    followUps: ["목표와 지표는 누가 정했나요?"],
  }));
  if (lines[0]) {
    questions.push({
      category: "pivot",
      facet: "O",
      question: "이 중 본인이 직접 결정·실행한 부분은 어디까지인가요?",
      intent: "본인 역할과 팀 역할의 경계",
      citations: cite(lines[0]),
      followUps: [],
    });
  }
  questions.push({ category: "motivation", facet: "motivation", question: "왜 이 직무에 지원했나요?", intent: "경험과 지원 직무의 연결", citations: [], followUps: [] });
  return { questions, notes: lines.length ? [] : ["근거로 쓸 서류 내용이 없습니다."] };
}

/** 가짜 답변 피드백: 답변 길이로 점수를 정하고, 첫 근거 줄을 모범 답변 근거로 쓴다. */
function fakeInterviewFeedback(user: string): InterviewFeedbackOutput {
  const answer = extractTag(user, CHAT_TAGS.interviewAnswer) ?? "";
  const first = interviewLines(user)[0];
  const hasNumber = /\d/.test(answer);
  const c = (score: number, comment: string) => ({ score, comment });
  return {
    overall: Math.min(100, 40 + Math.round(answer.length / 10)),
    criteria: {
      evidence: c(answer.length > 80 ? 4 : 2, "근거를 하나 이상 들었는지"),
      numbers: c(hasNumber ? 4 : 2, hasNumber ? "수치가 있습니다." : "수치가 없습니다."),
      ownership: c(/제가|저는|직접/.test(answer) ? 4 : 2, "본인 역할 표현"),
      length: c(answer.length > 400 ? 2 : 4, "길이"),
      structure: c(3, "결론 → 근거 → 한계"),
    },
    strengths: ["질문에 바로 답했습니다."],
    improvements: hasNumber ? [] : ["측정 기간·대상과 전후 값을 더하세요."],
    unsupportedClaims: [],
    modelAnswer: {
      conclusion: "[ADD: 질문에 바로 답하는 한 문장]",
      points: first ? [{ text: first.text.slice(0, 60), ref: first.id }] : [{ text: "[ADD: 가장 직접적인 근거]", ref: null }],
      limitation: "",
    },
    followUp: "그 결과는 어떻게 측정했나요?",
  };
}


// ---------------------------------------------------------------------------
// 그래프 이력서 에이전트(resume-agent-plan · -write · -revise) — <career_graph>의 E… 근거 줄을 읽는다.
// ---------------------------------------------------------------------------

interface FakeEvidence {
  ref: string;
  label: string;
  name: string;
  path: string;
  period: string;
  props: Record<string, string>;
  techs: string[];
  line: string;
}

/** "E1 [프로젝트] 이름 (나 → …) 2021.03 ~ 현재 | key: value | 기술: A, B" */
function evidenceLines(user: string): FakeEvidence[] {
  const body = extractTag(user, CHAT_TAGS.careerGraph) ?? "";
  const out: FakeEvidence[] = [];
  for (const line of body.split(/\r?\n/)) {
    const [head, ...rest] = line.trim().split(" | ");
    const m = /^(E\d+) \[([^\]]+)\] (.+?) \((.*)\)(?: (.+))?$/.exec(head ?? "");
    if (!m) continue;
    const props: Record<string, string> = {};
    let techs: string[] = [];
    for (const part of rest) {
      const kv = /^([a-zA-Z가-힣]+): (.*)$/.exec(part.trim());
      if (!kv) continue;
      if (kv[1] === "기술") techs = kv[2]!.split(", ").filter(Boolean);
      else props[kv[1]!] = kv[2]!;
    }
    out.push({ ref: m[1]!, label: m[2]!, name: m[3]!, path: m[4]!, period: (m[5] ?? "").trim(), props, techs, line: line.trim() });
  }
  return out;
}

const periodParts = (p: string): [string, string] => {
  const [a, b] = p.split(" ~ ");
  return [(a ?? "").trim(), (b ?? "").trim()];
};
const companyOfPath = (path: string) => /([^→]+)\(회사\)/.exec(path)?.[1]?.trim() ?? "";

function fakeAgentPlan(user: string): unknown {
  const ev = evidenceLines(user);
  const jd = extractJson<JdAnalysis>(user, TAGS.jdAnalysis);
  const cand = extractTag(user, CHAT_TAGS.requirementCandidates) ?? "";
  const candidates = new Map<string, string[]>();
  for (const line of cand.split(/\r?\n/)) {
    const m = /^(R\d+) .*— 후보: (.*?) · 기술 대조/.exec(line);
    if (m) candidates.set(m[1]!, m[2] === "없음" ? [] : m[2]!.split(", ").filter(Boolean));
  }
  const reqs = jd ? [...jd.mustHave, ...jd.niceToHave] : [];
  const projects = ev.filter((e) => e.label === "프로젝트");
  // 대표 프로젝트는 하나만 고른다(나머지는 수정 단계의 근거 재검색으로 들어오게 — 루프 시험).
  const main = projects.find((p) => (candidates.get(reqs[0]?.id ?? "") ?? []).includes(p.ref)) ?? projects[0];
  const requirementMap = reqs.map((r) => {
    const refs = (candidates.get(r.id) ?? []).slice(0, 6);
    return { requirementId: r.id, status: refs.length ? ("strong" as const) : ("gap" as const), refs, angle: r.text.slice(0, 200) };
  });
  return {
    positioning: `${jd?.roleTitle ?? "지원 직무"} 요건을 실제 프로젝트로 보여 주는 지원자`,
    headline: (jd?.roleTitle ?? "지원 직무").slice(0, 60),
    requirementMap,
    include: {
      experience: ev.filter((e) => e.label === "직무").map((e) => ({ ref: e.ref, emphasis: "high" as const })),
      projects: main ? [{ ref: main.ref, why: "필수 요건 근거", requirementIds: reqs.filter((r) => (candidates.get(r.id) ?? []).includes(main.ref)).map((r) => r.id) }] : [],
      extras: [],
    },
    exclude: projects.filter((p) => p !== main).map((p) => ({ ref: p.ref, reason: "대표 프로젝트 하나로 줄임" })),
    keywordPlan: [],
    sectionEmphasis: ["경력 첫 불릿에 필수 요건"],
    gapQuestions: requirementMap.filter((r) => r.status === "gap").map((r) => ({ requirementId: r.requirementId, question: `${r.angle} 경험이 있나요?` })),
  };
}

function fakeAgentBody(user: string): unknown {
  const ev = evidenceLines(user);
  const plan = extractJson<{ include: { experience: { ref: string }[]; projects: { ref: string; requirementIds: string[] }[] } }>(user, CHAT_TAGS.resumePlan);
  const byRef = new Map(ev.map((e) => [e.ref, e]));
  const roles = (plan?.include.experience ?? []).map((e) => byRef.get(e.ref)).filter((e): e is FakeEvidence => !!e);
  const achievements = ev.filter((e) => e.label === "성과");
  const citations: { path: string; refs: string[]; requirementIds: string[] }[] = [];
  const experience = roles.map((r, i) => {
    const [start, end] = periodParts(r.period);
    const mine = achievements.filter((a) => a.path.includes(`${r.name}(직무)`));
    const company = ev.find((e) => e.label === "회사" && e.name === companyOfPath(r.path));
    citations.push({ path: `experience[${i}]`, refs: [r.ref, ...(company ? [company.ref] : []), ...mine.map((a) => a.ref)], requirementIds: [] });
    // 첫 경력에는 일부러 근거에 없는 수치 줄을 하나 넣는다(서버 사실 검증이 [ADD: 수치 확인]으로 바꾸는지 시험).
    const bullets = [...mine.map((a) => a.name), ...(i === 0 ? ["장애 대응 시간을 99% 줄였다"] : [])];
    return { company: companyOfPath(r.path), department: r.props.department ?? "", title: r.name, startDate: start, endDate: end, location: "", scope: r.props.summary ?? "", bullets };
  });
  const projects = (plan?.include.projects ?? []).flatMap((p, i) => {
    const e = byRef.get(p.ref);
    if (!e) return [];
    const [start, end] = periodParts(e.period);
    citations.push({ path: `projects[${i}]`, refs: [e.ref], requirementIds: p.requirementIds });
    return [
      {
        name: e.name,
        company: companyOfPath(e.path),
        team: "",
        role: e.props.myRole ?? "",
        startDate: start,
        endDate: end,
        summary: e.props.summary ?? "",
        problem: e.props.situation ?? "",
        action: e.props.action ?? "",
        result: e.props.result ?? "",
        evidence: "",
        bullets: [],
        techs: e.techs,
      },
    ];
  });
  const education = ev.filter((e) => e.label === "학력").map((e, i) => {
    citations.push({ path: `education[${i}]`, refs: [e.ref], requirementIds: [] });
    const [start, end] = periodParts(e.period);
    return { school: e.name, degree: e.props.degree ?? "", major: e.props.major ?? "", startDate: start, endDate: end, note: "" };
  });
  return { experience, projects, education, certifications: [], extras: [], citations, notes: ["JD 대응: 가짜 초안"] };
}

function fakeAgentTop(user: string): unknown {
  const ev = evidenceLines(user);
  const plan = extractJson<{ headline: string; positioning: string; include: { projects: { ref: string }[] } }>(user, CHAT_TAGS.resumePlan);
  const main = ev.find((e) => e.ref === plan?.include.projects[0]?.ref);
  const achievements = ev.filter((e) => e.label === "성과" && /\d/.test(e.name)).slice(0, 2);
  const citations: { path: string; refs: string[]; requirementIds: string[] }[] = [];
  if (main) citations.push({ path: "summary", refs: [main.ref], requirementIds: [] });
  achievements.forEach((a, i) => citations.push({ path: `highlights[${i}]`, refs: [a.ref], requirementIds: [] }));
  if (main) citations.push({ path: "skills[0]", refs: [main.ref], requirementIds: [] });
  return {
    basics: { headline: plan?.headline ?? "", tagline: main ? `${main.name}을(를) 맡은 개발자` : "", totalExperience: "" },
    summary: main ? `${main.name}에서 ${main.props.action ?? main.name}` : "",
    highlights: achievements.map((a) => ({ title: a.name, context: "" })),
    skills: main ? [{ category: "기술", detail: "", items: main.techs }] : [],
    citations,
    missingInfo: [],
  };
}

function fakeAgentRevise(user: string): unknown {
  const ev = evidenceLines(user);
  const fb = extractJson<{ atsKeywordsMissing: string[]; issues: { id: string; reviewer: string; issue: string }[] }>(user, CHAT_TAGS.reviewerFeedback);
  const ops: unknown[] = [];
  const questions: { requirementId: string | null; question: string }[] = [];
  const atsIssue = fb?.issues.find((i) => i.reviewer === "ats" && i.issue.startsWith("JD 키워드"))?.id;
  const used = new Set<string>();
  const inserted: string[] = [];
  // 기술 노드 줄보다 프로젝트·경험 줄을 먼저 근거로 쓴다.
  const ranked = [...ev].sort((a, b) => Number(a.label === "기술") - Number(b.label === "기술"));
  for (const kw of fb?.atsKeywordsMissing ?? []) {
    if (inserted.some((t) => t.toLowerCase().includes(kw.toLowerCase()))) continue;
    const hit = ranked.find((e) => !used.has(e.ref) && e.line.toLowerCase().includes(kw.toLowerCase()));
    if (!hit) {
      questions.push({ requirementId: null, question: `${kw} 경험이 있나요?` });
      continue;
    }
    used.add(hit.ref);
    const text = Object.values(hit.props).find((v) => v.toLowerCase().includes(kw.toLowerCase())) ?? `${hit.name} (${hit.techs.join(", ")})`;
    inserted.push(text);
    ops.push({ op: "insert", path: "experience[0].bullets[0]", value: text.slice(0, 480), refs: [hit.ref], section: "", order: [], project: null, skills: null, citations: [], issueIds: atsIssue ? [atsIssue] : [], reason: `${kw} 근거 추가` });
  }
  return { ops, questions, summary: ops.length ? "ATS 누락 키워드를 근거 줄로 채웠다." : "근거 안에서 고칠 지적이 없다." };
}

/**
 * 가짜 이력서 다듬기: <polish_target>의 글로 대안 2개(짧게 / 수치 자리표시)를 낸다. 그래프 근거 [1]이 있으면 그 이름을 셋째 대안에 쓴다.
 * 요청에 "[가짜:수치]"가 있으면 근거에 없는 숫자(73%)를 넣는다(서버 사실 검증 시험용).
 * 요청에 "[가짜:묶음]" 또는 "한번에 채워"가 있고 <polish_items>(대상 칸이 든 항목)가 있으면 그 항목의 이름·문제·행동·결과·기술을 한 번에 채운다(itemChanges).
 * 요청에 "[가짜:평어]"가 있으면 평어체('~했다')로 끝나는 대안·안내를 낸다(둘째 대안 '개발자다.'는 자동으로 바꿀 수 없는 꼴 — 서버 문체 정리 시험용).
 */
function fakeResumePolish(user: string): ResumePolishOutput {
  const target = (extractTag(user, POLISH_TARGET_TAG) ?? "").trim();
  const message = extractTag(user, CHAT_TAGS.latestMessage) ?? "";
  const base = target && target !== "(비어 있음)" ? target : "[ADD: 이 칸에 쓸 경험]";
  const first = base.split(/(?<=[.!?。])\s+|\n/)[0]!.replace(/[.。]$/, "");
  const short = first.length > 40 ? `${first.slice(0, 40).trimEnd()}` : `${first} (요약)`;
  const suggestions = [
    { text: short, reason: "핵심만 남겨 한눈에 읽힌다." },
    { text: `${first} — [ADD: 수치 확인 — 개선 전후 지표]`, reason: "결과 수치 자리를 앞에 두었다." },
  ];
  const source = sourceLines(user)[0];
  if (source) suggestions.push({ text: `${first} (${source.text.split(" · ").at(-1)!.slice(0, 40)})`, reason: "그래프 근거를 함께 적었다." });
  if (message.includes("[가짜:수치]")) suggestions[0] = { text: `${first}, 처리 시간 73% 단축`, reason: "수치를 강조했다." };
  const plain = message.includes("[가짜:평어]");
  if (plain) {
    suggestions[0] = { text: "정산 흐름을 다시 설계했다. [ADD: 수치 확인 — 처리 시간을 줄였다]", reason: "행동을 앞에 두었다." };
    suggestions[1] = { text: "정산 배치를 맡은 백엔드 개발자다.", reason: "역할을 앞에 두었다." };
  }
  const grouped = extractTag(user, POLISH_ITEMS_TAG) !== null && wantsGrouped(message);
  return {
    scope: "on_topic",
    scopeReason: "",
    reply: plain ? "요청에 맞춰 문장을 다시 썼다." : "요청에 맞춰 이렇게 바꿔 볼 수 있어요.",
    suggestions: suggestions.slice(0, 3),
    followUpQuestion: "이 일로 바뀐 지표와 기간을 알려 주실 수 있나요?",
    itemChanges: grouped ? fakeProjectChanges(user, message) : [],
    itemReason: grouped ? "프로젝트 이름·문제·행동·결과를 한 번에 채웠다." : "",
  };
}

const wantsGrouped = (message: string) => message.includes("[가짜:묶음]") || /한\s?번에\s?채워/.test(message);
const wantsAdd = (message: string) => message.includes("[가짜:추가]") || /프로젝트\s?추가/.test(message);

/** 그래프 근거·도구 결과에서 처음 보이는 프로젝트(이름 — 요약). 없으면 null. */
function fakeGraphProject(user: string): { name: string; summary: string } | null {
  const sources = extractTag(user, CHAT_TAGS.graphSources) ?? "";
  const tools = extractTag(user, CHAT_TAGS.toolResults) ?? "";
  const tool = /^N\d+ · (?:Project|프로젝트) · ([^\n—]+?)(?: — ([^\n]*))?$/m.exec(tools);
  if (tool) return { name: tool[1]!.trim(), summary: (tool[2] ?? "").trim() };
  const src = /^\[\d+\] 프로젝트 · ([^\n]+)$/m.exec(sources);
  return src ? { name: src[1]!.trim(), summary: "" } : null;
}

/** 가짜 프로젝트 칸 묶음: 이름(그래프 프로젝트가 있으면 그 이름)·문제·행동·결과·기술. "[가짜:수치]"면 결과에 근거 없는 73%. */
function fakeProjectChanges(user: string, message: string): PolishItemChangeOutput[] {
  const project = fakeGraphProject(user);
  return [
    { field: "name", value: project?.name ?? "[ADD: 프로젝트 이름]" },
    { field: "problem", value: "월말 정산 배치가 늦어 다음 날 업무가 밀렸다" },
    { field: "action", value: "배치를 이벤트 기반으로 나눠 다시 설계했다" },
    { field: "result", value: message.includes("[가짜:수치]") ? "정산 시간을 73% 줄였다" : "[ADD: 수치 확인 — 정산 시간 전후]" },
    { field: "techs", value: "Kafka\nRust" },
  ];
}

/**
 * 가짜 다듬기 도구 스텝(task 'resume-polish-step'). 요청에 표식이 있을 때만 도구를 부른다(없으면 바로 최종 답 — 호출 1회):
 *   - "[가짜:JD]" → get_jd_analysis {}
 *   - "[가짜:그래프:검색어]" → search_graph {query: 검색어}, 결과에 N1이 있으면 다음 스텝에 get_node {id: "N1"}
 *   - "[가짜:노드:값]" → get_node {id: 값}(격리·인자 검증 시험 — 실제 노드 id·남의 handle)
 *   - "[가짜:도구반복]" → 매 스텝 list_nodes를 부른다(스텝 상한·최종 답 강제 시험)
 *   - "[가짜:추가]"·"프로젝트 추가"(근거에 프로젝트가 없을 때) → search_graph {query: 요청 글}
 * 이미 부른 도구는 다시 부르지 않는다(<tool_results>의 "#n 도구 →" 줄로 판단).
 */
function fakeResumePolishStep(user: string): unknown {
  const message = extractTag(user, CHAT_TAGS.latestMessage) ?? "";
  const results = extractTag(user, CHAT_TAGS.toolResults) ?? "";
  const called = (tool: string) => new RegExp(`#\\d+ ${tool} →`).test(results);
  const calls: { tool: string; args: Record<string, unknown> }[] = [];
  if (message.includes("[가짜:도구반복]")) calls.push({ tool: "list_nodes", args: { label: "Project", limit: 3 } });
  if (message.includes("[가짜:JD]") && !called("get_jd_analysis")) calls.push({ tool: "get_jd_analysis", args: {} });
  const q = /\[가짜:그래프:([^\]]+)\]/.exec(message)?.[1];
  if (q && !called("search_graph")) calls.push({ tool: "search_graph", args: { query: q } });
  else if (q && /^N1 · /m.test(results) && !called("get_node")) calls.push({ tool: "get_node", args: { id: "N1" } });
  // 새 프로젝트 추가 요청이면 그 경험을 그래프에서 찾는다(이미 근거·도구 결과가 있으면 다시 찾지 않는다).
  if (!q && wantsAdd(message) && !called("search_graph") && !fakeGraphProject(user)) {
    calls.push({ tool: "search_graph", args: { query: message.replace(/\[가짜:[^\]]*\]/g, " ").trim().slice(0, 200) || "프로젝트" } });
  }
  const raw = /\[가짜:노드:([^\]]+)\]/.exec(message)?.[1];
  if (raw && !called("get_node")) calls.push({ tool: "get_node", args: { id: raw } });
  if (calls.length > 0) return { action: "call_tools", thought: "", calls: calls.slice(0, 3) };
  return { action: "final", answer: extractTag(user, POLISH_DOCUMENT_TAG) !== null ? fakeResumePolishDoc(user) : fakeResumePolish(user) };
}

/**
 * 가짜 전체 이력서 다듬기: <polish_document> 표의 글이 있는 칸 앞쪽 2개에 제안을 내고, 서버 거르기를 시험하려고
 * 다듬을 수 없는 칸(basics.email·motivation)과 없는 칸(experience[9].bullets[0]) 제안을 섞는다.
 * 질문에 "[가짜:수치]"가 있으면 답변·첫 제안에 근거 없는 숫자(73%)를 넣는다.
 * 질문에 "[가짜:평어]"가 있으면 첫 제안과 답변을 평어체('~했다·~이다')로 끝낸다(서버 문체 정리 시험용).
 */
function fakeResumePolishDoc(user: string): ResumePolishDocOutput {
  const table = extractTag(user, POLISH_DOCUMENT_TAG) ?? "";
  const message = extractTag(user, CHAT_TAGS.latestMessage) ?? "";
  const fields = [...table.matchAll(/^- \[([^\]]+)\] ([^(\n]+?) \(최대 \d+자\): (.+)$/gm)]
    .map((m) => ({ path: m[1]!, label: m[2]!, text: m[3]!.trim() }))
    .filter((f) => f.text !== "(비어 있음)");
  const fake = message.includes("[가짜:수치]");
  const plain = message.includes("[가짜:평어]");
  const suggestions = fields.slice(0, 2).map((f, i) => ({
    path: f.path,
    after:
      i === 0 && plain
        ? "정산 흐름을 다시 설계했다. [ADD: 수치 확인 — 처리 시간을 줄였다]"
        : i === 0 && fake
          ? `${f.text.replace(/[.。]$/, "")}, 처리 시간 73% 단축`
          : `${f.text.replace(/[.。]$/, "")} — [ADD: 수치 확인 — 개선 전후 지표]`,
    reason: `${f.label}에 결과 자리를 더했다.`,
  }));
  suggestions.push(
    { path: "basics.email", after: "fake@example.com", reason: "연락처" },
    { path: "motivation", after: "지원 동기를 대신 썼다", reason: "동기" },
    { path: "experience[9].bullets[0]", after: "없는 칸", reason: "없는 칸" },
  );
  const weakest = fields[0]?.label ?? "요약";
  // 항목 제안: "[가짜:묶음]"이면 첫 프로젝트(projects[0])의 여러 칸을 한 번에, "[가짜:추가]"면 그래프·도구 결과의 프로젝트를 새로 더한다.
  const itemsTable = extractTag(user, POLISH_ITEMS_TAG) ?? "";
  const items: PolishItemOutput[] = [];
  if (wantsGrouped(message) && /^- \[projects\[0\]\]/m.test(itemsTable)) {
    items.push({ kind: "edit", section: "projects", index: 0, changes: fakeProjectChanges(user, message), reason: "프로젝트 칸을 한 번에 채웠다." });
  }
  const project = fakeGraphProject(user);
  if (wantsAdd(message) && project) {
    items.push({
      kind: "add",
      section: "projects",
      index: -1,
      changes: [
        { field: "name", value: project.name },
        { field: "summary", value: project.summary || `${project.name} 프로젝트` },
        { field: "startDate", value: "2023.01" },
        { field: "techs", value: "Go\nKafka\nRust" },
        { field: "result", value: message.includes("[가짜:수치]") ? "정산 시간을 73% 줄였다" : "" },
      ],
      reason: "경험 그래프에 있는 프로젝트를 더했다.",
    });
  }
  return {
    scope: "on_topic",
    scopeReason: "",
    answer: plain
      ? `가장 약한 부분은 ${weakest}이다. 결과 수치가 빠져 있다.`
      : fake
        ? `가장 약한 부분은 ${weakest}입니다. 응답 시간을 73% 줄인 경험이 강점입니다.`
        : `가장 약한 부분은 ${weakest}입니다. 결과 수치가 빠져 있어요.`,
    suggestions,
    items,
    followUpQuestion: "가장 자랑하고 싶은 성과의 지표를 알려 주실 수 있나요?",
  };
}

// ---------------------------------------------------------------------------
// 구역별 에이전트(파이프라인 v2: resume-agent-brief · -section · -compose · -critique · -motivation)
// ---------------------------------------------------------------------------

/** 총괄 작전: v1 가짜 전략 + 경력·프로젝트 둘 다 같은 요건을 주 책임으로 낸다(서버의 중복 강등 시험). 소유·분량은 서버가 채운다. */
function fakeAgentBrief(user: string): unknown {
  const plan = fakeAgentPlan(user) as { requirementMap: { requirementId: string; status: string }[]; positioning: string };
  const strong = plan.requirementMap.filter((r) => r.status !== "gap").map((r) => r.requirementId);
  const budget = { items: 4, linesPerItem: 5, chars: 5000 };
  const company = (extractField(user, "지원 회사") ?? "").includes("공용") ? null : { companyAngle: "공고의 핵심 업무와 이어지는 경험", linkRefs: [] };
  return {
    ...plan,
    pageTarget: 2,
    assignments: [
      { section: "experience", primaryRequirementIds: strong, secondaryRequirementIds: [], refs: [], angle: "경력 첫 줄에 필수 요건", keywords: [], budget },
      { section: "projects", primaryRequirementIds: strong, secondaryRequirementIds: [], refs: [], angle: "대표 프로젝트로 증명", keywords: [], budget },
    ],
    evidenceOwner: [],
    motivation: company,
    summaryAngle: plan.positioning,
  };
}

/** 구역 에이전트: '- 작성 구역: …' 줄로 구역을 고른다. 총괄 피드백(<orchestrator_feedback>)의 keywords는 근거 줄을 찾아 경력에 넣는다. */
function fakeAgentSection(user: string): unknown {
  const section = (extractField(user, "작성 구역") ?? "").trim();
  const ev = evidenceLines(user);
  const plan = extractJson<{ include: { experience: { ref: string }[]; projects: { ref: string; requirementIds: string[] }[] } }>(user, CHAT_TAGS.resumePlan);
  const feedback = extractJson<{ keywords?: string[] }>(user, "orchestrator_feedback");
  const byRef = new Map(ev.map((e) => [e.ref, e]));
  const citations: { path: string; refs: string[]; requirementIds: string[] }[] = [];
  const common = { citations, notes: [], missingInfo: [], needEvidence: [], coveredRequirementIds: [] };
  if (section === "experience") {
    const roles = (plan?.include.experience ?? []).map((e) => byRef.get(e.ref)).filter((e): e is FakeEvidence => !!e && !/다른 구역 담당/.test(e.line));
    const achievements = ev.filter((e) => e.label === "성과" && !/다른 구역 담당/.test(e.line));
    const experience = roles.map((r, i) => {
      const [start, end] = periodParts(r.period);
      const mine = achievements.filter((a) => a.path.includes(`${r.name}(직무)`));
      const company = ev.find((e) => e.label === "회사" && e.name === companyOfPath(r.path));
      citations.push({ path: `experience[${i}]`, refs: [r.ref, ...(company ? [company.ref] : []), ...mine.map((a) => a.ref)], requirementIds: [] });
      const bullets = [...mine.map((a) => a.name), ...(i === 0 ? ["장애 대응 시간을 99% 줄였다"] : [])];
      return { company: companyOfPath(r.path), department: r.props.department ?? "", title: r.name, startDate: start, endDate: end, location: "", scope: r.props.summary ?? "", bullets };
    });
    const ranked = [...ev].filter((e) => !/다른 구역 담당/.test(e.line)).sort((a, b) => Number(a.label === "기술") - Number(b.label === "기술"));
    const inserted: string[] = [];
    for (const kw of feedback?.keywords ?? []) {
      if (!experience[0] || inserted.some((t) => t.toLowerCase().includes(kw.toLowerCase()))) continue;
      const hit = ranked.find((e) => e.line.toLowerCase().includes(kw.toLowerCase()));
      if (!hit) continue;
      const text = Object.values(hit.props).find((v) => v.toLowerCase().includes(kw.toLowerCase())) ?? `${hit.name} (${hit.techs.join(", ")})`;
      inserted.push(text);
      experience[0].bullets.unshift(text.slice(0, 480));
      citations.forEach((c) => {
        const m = /^experience\[0\]\.bullets\[(\d+)\]$/.exec(c.path);
        if (m) c.path = `experience[0].bullets[${Number(m[1]) + 1}]`;
      });
      citations.push({ path: "experience[0].bullets[0]", refs: [hit.ref], requirementIds: [] });
    }
    return { experience, ...common };
  }
  if (section === "projects") {
    // 총괄 피드백의 누락 키워드가 든 프로젝트 근거(전체 줄)가 있으면 대표 프로젝트로 더한다.
    const picks = [...(plan?.include.projects ?? [])];
    for (const kw of feedback?.keywords ?? []) {
      const hit = ev.find((e) => e.label === "프로젝트" && !/다른 구역 담당/.test(e.line) && e.line.toLowerCase().includes(kw.toLowerCase()));
      if (hit && !picks.some((p) => p.ref === hit.ref)) picks.push({ ref: hit.ref, requirementIds: [] });
    }
    const projects = picks.flatMap((p, i) => {
      const e = byRef.get(p.ref);
      if (!e) return [];
      const [start, end] = periodParts(e.period);
      citations.push({ path: `projects[${i}]`, refs: [e.ref], requirementIds: p.requirementIds });
      return [{ name: e.name, company: companyOfPath(e.path), team: "", role: e.props.myRole ?? "", startDate: start, endDate: end, summary: e.props.summary ?? "", problem: e.props.situation ?? "", action: e.props.action ?? "", result: e.props.result ?? "", evidence: "", bullets: [], techs: e.techs }];
    });
    return { projects, ...common };
  }
  if (section === "extras") {
    const education = ev.filter((e) => e.label === "학력").map((e, i) => {
      citations.push({ path: `education[${i}]`, refs: [e.ref], requirementIds: [] });
      const [start, end] = periodParts(e.period);
      return { school: e.name, degree: e.props.degree ?? "", major: e.props.major ?? "", startDate: start, endDate: end, note: "" };
    });
    return { extras: [], education, certifications: [], ...common };
  }
  if (section === "highlights") {
    const achievements = ev.filter((e) => e.label === "성과" && /\d/.test(e.name) && !/다른 구역 담당/.test(e.line)).slice(0, 2);
    achievements.forEach((a, i) => citations.push({ path: `highlights[${i}]`, refs: [a.ref], requirementIds: [] }));
    return { highlights: achievements.map((a) => ({ title: `핵심 성과 — ${a.name}`, context: "" })), ...common };
  }
  if (section === "skills") {
    const main = ev.find((e) => e.ref === plan?.include.projects[0]?.ref);
    if (main) citations.push({ path: "skills[0]", refs: [main.ref], requirementIds: [] });
    return { skills: main ? [{ category: "기술", detail: "", items: main.techs }] : [], ...common };
  }
  return { experience: [], ...common };
}

/** 총괄 조립의 상단: 본문에 인용된 첫 프로젝트(없으면 첫 근거)로 요약·태그라인. */
function fakeAgentCompose(user: string): unknown {
  const ev = evidenceLines(user);
  const plan = extractJson<{ headline: string; allowedRefs: string[] }>(user, CHAT_TAGS.resumePlan);
  const allowed = new Set(plan?.allowedRefs ?? []);
  const main = ev.find((e) => e.label === "프로젝트" && allowed.has(e.ref)) ?? ev.find((e) => allowed.has(e.ref));
  return {
    headline: plan?.headline ?? "",
    tagline: main ? `${main.name}을(를) 맡은 개발자` : "",
    summary: main ? `${main.name}에서 ${main.props.action ?? main.name}` : "",
    citations: main ? [{ path: "summary", refs: [main.ref], requirementIds: [] }] : [],
  };
}

/** 총괄 피드백: 서버 1차 배정(routed)을 그대로 revise로 낸다. */
function fakeAgentCritique(user: string): unknown {
  const fb = extractJson<{ routed: { section: string; issueIds: string[]; requirementIds: string[]; keywords: string[] }[] }>(user, CHAT_TAGS.reviewerFeedback);
  const sections = (fb?.routed ?? []).slice(0, 6).map((r) => ({
    section: r.section,
    score: 60,
    decision: "revise" as const,
    instructions: r.keywords.length ? [`누락 키워드 ${r.keywords.join(", ")}를 근거 줄로 넣어라`] : ["지적을 근거 안에서 반영하라"],
    issueIds: r.issueIds.slice(0, 12),
    requirementIds: r.requirementIds.slice(0, 8),
    keepPaths: [],
    targetChars: null,
    evidenceQueries: [],
  }));
  return { sections, crossSection: [], summary: sections.length ? "누락 키워드와 요건 공백을 근거 줄로 채우게 했다." : "고칠 곳이 없다." };
}

/** 지원 동기 초안(구역 에이전트): 근거 있는 문장 + 지어낸 동기 문장 + 근거 없는 숫자 문장 + 자리표시(서버 검증 시험). */
function fakeMotivationDraft(user: string): unknown {
  const jd = extractTag(user, TAGS.jobPosting) ?? "";
  const resume = (extractTag(user, CHAT_TAGS.resume) ?? "").split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const quote = jd.split(/\r?\n/).map((l) => l.replace(/^[-•\s]+/, "").trim()).find((l) => l.length >= 4) ?? "";
  return {
    draft: [
      "어릴 때부터 이 회사를 동경해 왔습니다.",
      quote ? `공고의 '${quote.slice(0, 60)}' 요건은 제가 이력서에 쓴 '${(resume[0] ?? "경험").slice(0, 40)}'과 이어집니다.` : `제가 이력서에 쓴 '${(resume[0] ?? "경험").slice(0, 40)}'을 이 직무에서 이어가고 싶습니다.`,
      "그 경험으로 결제 지연을 45% 줄였습니다.",
      "[ADD: 이 회사여야 하는 이유] 입사 후에는 공고 업무에 기여하고 싶습니다.",
    ].join(" "),
    usedPoints: [1],
    usedRefs: [],
  };
}

function fakeAgentMotivation(user: string): unknown {
  return user.includes("지원 동기 초안 작성(구역 에이전트)") ? fakeMotivationDraft(user) : fakeMotivationSuggest(user);
}

function fakeAgentWrite(user: string): unknown {
  return user.includes("이력서 본문(경력·프로젝트") ? fakeAgentBody(user) : fakeAgentTop(user);
}

/**
 * 가짜 지원 동기 추천: 공고(<job_posting>)의 첫 줄을 인용하고, 그래프(<career_graph>)의 `- [id] 이름` 줄 앞쪽 2개를 이어지는 경험으로 고른다.
 * 서버 거르기를 시험하려고 일부러 섞는다: 공고에 없는 인용 1개, 그래프에 없는 노드 1개, 자료에 없는 숫자 1개, 완성 문단 1개.
 * 초안(draft)도 섞는다: 근거 있는 문장, 지어낸 동기 문장('어릴 때부터 … 감명'), 근거 없는 숫자 문장(45%), 자리표시.
 */
function fakeMotivationSuggest(user: string): unknown {
  const jd = extractTag(user, TAGS.jobPosting) ?? "";
  const graph = extractTag(user, CHAT_TAGS.careerGraph) ?? "";
  const quote = jd.split(/\r?\n/).map((l) => l.replace(/^[-•\s]+/, "").trim()).find((l) => l.length >= 4) ?? "";
  const nodes = [
    ...[...graph.matchAll(/^- \[([^\]]+)\] ([^(\n]+)/gm)].map((m) => ({ nodeId: m[1]!, name: m[2]!.trim() })),
    // 에이전트 pack 형식("E1 [프로젝트] 이름 (경로) …") — nodeId 자리에 E… ref를 쓴다.
    ...[...graph.matchAll(/^(E\d+) \[[^\]]+\] (.+?) \(/gm)].map((m) => ({ nodeId: m[1]!, name: m[2]!.trim() })),
  ];
  return {
    companyPoints: [
      ...(quote ? [{ point: "공고가 강조하는 업무", jdQuote: quote.slice(0, 200) }] : []),
      { point: "공고에 없는 가치", jdQuote: "공고 원문에 없는 문장입니다" },
    ],
    linkedExperiences: [
      ...nodes.slice(0, 2).map((n) => ({ nodeId: n.nodeId, name: n.name.slice(0, 120), why: "공고 업무와 같은 종류의 일" })),
      { nodeId: "n-unknown", name: "지어낸 경험", why: "그래프에 없는 노드" },
    ],
    outline: [
      { heading: "지원 계기", guide: "회사를 알게 된 계기와 관심을 가진 이유를 적어 보세요" },
      { heading: "이어지는 경험", guide: "위 경험 중 하나로 공고 업무와 이어지는 점을 적어 보세요" },
      { heading: "완성 문단", guide: "저는 귀사의 비전에 깊이 공감하여 지원하게 되었습니다. 입사 후 최선을 다하겠습니다." },
    ],
    questions: ["회사를 처음 알게 된 계기는 무엇인가요?", "매출을 777% 늘린 경험이 있나요?"],
    cautions: ["회사 칭찬만 나열하지 마세요"],
    draft: [
      "어릴 때부터 이 서비스를 써 오며 깊이 감명을 받았습니다.",
      quote ? `공고의 '${quote.slice(0, 60)}' 요건은 제가 해 온 ${nodes[0]?.name ?? "일"}의 일과 이어집니다.` : `제가 해 온 ${nodes[0]?.name ?? "일"}의 일을 이 직무에서 이어가고 싶습니다.`,
      "그 경험으로 결제 지연을 45% 줄였습니다.",
      "[ADD: 이 회사여야 하는 이유] 입사 후에는 공고 업무에 기여하고 싶습니다.",
    ].join(" "),
  };
}

function fakeJdTips(user: string): unknown {
  const jd = extractTag(user, TAGS.jobPosting) ?? "";
  const graph = extractTag(user, CHAT_TAGS.careerGraph) ?? "";
  const lines = jd.split(/\r?\n/).map((l) => l.replace(/^[-•\s]+/, "").trim()).filter((l) => l.length >= 4);
  const nodes = [...graph.matchAll(/^- \[([^\]]+)\] ([^(\n]+)/gm)].map((m) => m[1]!);
  const words = [...new Set(jd.match(/[A-Za-z][A-Za-z0-9.+#]{1,30}/g) ?? [])];
  return {
    summary: [
      ...lines.slice(0, 3).map((l, i) => ({ kind: i === 0 ? "duty" : "required", text: l.slice(0, 200) })),
      { kind: "preferred", text: "공고에 없는 경력 7년 이상" },
    ],
    sections: [
      { section: "first", tips: lines.slice(0, 2).map((l) => ({ tip: `한 줄 소개에 '${l.slice(0, 40)}' 경험을 드러내세요`, jdQuote: l.slice(0, 200) })) },
      {
        section: "highlights",
        tips: [
          ...(lines[0] ? [{ tip: "공고 요건과 이어지는 대표 성과를 맨 위에 두세요", jdQuote: lines[0].slice(0, 200) }] : []),
          { tip: "처리량을 4500% 늘린 성과를 쓰세요", jdQuote: lines[0]?.slice(0, 200) ?? "" },
          { tip: "공고에 없는 인용의 팁", jdQuote: "공고 원문에 없는 문장입니다" },
        ],
      },
    ],
    keywords: [...words.slice(0, 5), "공고에없는키워드"],
    experiences: [...nodes.slice(0, 2).map((nodeId) => ({ nodeId, section: "projects", why: "공고 요건과 같은 종류의 일" })), { nodeId: "n-unknown", section: "projects", why: "그래프에 없는 노드" }],
  };
}

function fakeTaskOutput(task: LlmTask, user: string): unknown {
  switch (task) {
    case "graph-chat":
      return fakeGraphChat(user);
    case "reviewer-chat":
      return fakeReviewerChat(user);
    case "resume-draft":
      return fakeResumeDraft(user);
    case "portfolio-draft":
      return fakePortfolioDraft(user);
    case "posting-extract":
      return fakePostingExtract(user);
    case "posting-translate":
      return fakePostingTranslate(user);
    case "graph-import":
      return fakeGraphImport(user);
    case "graph-repo-import":
      return fakeGraphRepoImport(user);
    case "graph-qa":
      return fakeGraphQa(user);
    case "graph-qa-rerank":
      return fakeGraphQaRerank(user);
    case "graph-agent-step":
      return fakeGraphAgentStep(user, false);
    case "graph-agent-final":
      return fakeGraphAgentStep(user, true);
    case "graph-agent-entail":
      return { supported: true };
    case "interview-questions":
      return fakeInterviewQuestions(user);
    case "interview-feedback":
      return fakeInterviewFeedback(user);
    case "resume-agent-plan":
      return fakeAgentPlan(user);
    case "resume-agent-write":
      return fakeAgentWrite(user);
    case "resume-agent-revise":
      return fakeAgentRevise(user);
    case "resume-agent-brief":
      return fakeAgentBrief(user);
    case "resume-agent-section":
      return fakeAgentSection(user);
    case "resume-agent-compose":
      return fakeAgentCompose(user);
    case "resume-agent-critique":
      return fakeAgentCritique(user);
    case "resume-agent-motivation":
      return fakeAgentMotivation(user);
    case "resume-polish":
      // 전체 이력서 모드(칸 표 <polish_document>가 있다)와 칸 모드를 같은 task로 부른다.
      return extractTag(user, POLISH_DOCUMENT_TAG) !== null ? fakeResumePolishDoc(user) : fakeResumePolish(user);
    case "resume-polish-step":
      return fakeResumePolishStep(user);
    case "resume-motivation-suggest":
      return fakeMotivationSuggest(user);
    case "resume-jd-tips":
      return fakeJdTips(user);
    case "portfolio-share-chat":
      // 공개 포트폴리오 챗봇: 첫 구역을 근거로 짧게 답한다(테스트는 보통 자체 가짜 클라이언트로 프롬프트를 확인한다).
      return { scope: "on_topic", scopeReason: "", answer: "포트폴리오의 첫 구역에 적힌 내용입니다.", citations: ["s1"], notInPortfolio: false };
    case "resume-agent-jd":
    case "resume-agent-review":
      // 패널 단계 재사용 호출의 사용량 구분(usageTask)일 뿐 task로는 오지 않는다.
      return null;
  }
}

export class FakeLlmClient implements LlmClient {
  readonly name = "fake";
  private readonly delay: number;

  /** delayMs: 호출마다 기다릴 시간(기본 0). 동시성·취소 테스트에서 쓴다. */
  constructor(opts?: { delayMs?: number }) {
    this.delay = opts?.delayMs ?? 0;
  }

  async generate<T>(req: LlmRequest<T>): Promise<GenerateResult<T>> {
    await sleep(this.delay, req.signal);
    if (req.task !== undefined) return this.result(req, fakeTaskOutput(req.task, req.user));
    const resume = extractTag(req.user, TAGS.resume) ?? "";
    const ctx: Ctx = {
      user: req.user,
      role: extractField(req.user, "지원 직무") ?? "지원 직무",
      resume,
      lines: quotableLines(resume),
      jd: extractJson<JdAnalysis>(req.user, TAGS.jdAnalysis),
    };
    return this.result(req, fakeOutput(req.stage, ctx));
  }

  private result<T>(req: LlmRequest<T>, raw: unknown): GenerateResult<T> {
    const parsed = req.schema.safeParse(raw);
    if (!parsed.success) {
      throw new LlmPermanentError(`가짜 출력이 스키마와 맞지 않습니다 (${requestLabel(req)})`, "invalid_output");
    }
    const inputTokens = Math.ceil((req.system.length + req.user.length) / 3);
    return {
      output: parsed.data,
      usage: { inputTokens, outputTokens: 800, cacheReadTokens: 0, cacheWriteTokens: 0 },
      model: FAKE_MODEL_NAME,
    };
  }
}
