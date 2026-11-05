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
import { CHAT_TAGS, type GraphChatOutput, type ReviewerChatOutput } from "@/lib/domain/chat";
import { emptyResumeDocument, type ResumeDraftOutput } from "@/lib/domain/resumes";
import type { PostingFacts } from "@/lib/domain/postings";
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

function fakeAts(ctx: Ctx, rescreen: boolean): AtsResult {
  const { withNumber, plain } = classify(ctx.lines);
  const { present, missing } = keywordSplit(ctx);
  const contactOk = /@|\d{2,4}-\d{3,4}-\d{4}/.test(ctx.resume);
  if (rescreen) {
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
  return {
    verdict: "NO",
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

function fakeFit(ctx: Ctx): FitResult {
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

function fakeGraphChat(user: string): GraphChatOutput {
  const message = (extractTag(user, CHAT_TAGS.latestMessage) ?? "").trim();
  if (!message) {
    return { reply: "어떤 경험을 정리할까요? 회사·프로젝트·맡은 일·결과를 편하게 말씀해 주세요.", ops: [], summary: "", followUpQuestions: [] };
  }
  const firstLine = message.split(/\r?\n/)[0]!.trim();
  const title = firstLine.length > 60 ? `${firstLine.slice(0, 60)}…` : firstLine;
  const skills = [...new Set((message.match(TECH_RE) ?? []).map((t) => t.trim()).filter((t) => t.length >= 2))].slice(0, 3);
  const blank = { ref: "", id: "", label: "" as const, props: [], type: "" as const, from: "", to: "" };
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
  doc.basics.headline = `${role} 지원`.slice(0, 160);
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
 * 공고 페이지 본문(<posting_page>)에서 "회사: …", "직무: …"(모집 직무·포지션·모집 분야), 마감/접수 줄의 날짜·시각을 읽는다.
 * 근거(*Evidence)는 본문 줄을 그대로 쓴다. 회사·직무 줄이 없으면 isJobPosting=false(목록·로그인 페이지 흉내).
 * 근거 검증 실패를 시험하려면 본문에 "[가짜:근거없음]"을 넣는다 — 근거 문구를 본문에 없는 말로 바꾼다.
 */
function fakePostingExtract(user: string): PostingFacts {
  const page = extractTag(user, CHAT_TAGS.postingPage) ?? "";
  const lines = page.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const find = (re: RegExp) => {
    for (const line of lines) {
      const m = re.exec(line);
      if (m) return { line, value: (m[1] ?? "").trim() };
    }
    return null;
  };
  const company = find(/^(?:회사|회사명|기업|기업명)\s*[:：]\s*(.+)$/);
  const role = find(/^(?:직무|모집\s*직무|포지션|모집\s*분야)\s*[:：]\s*(.+)$/);
  const deadlineLine = lines.find((l) => /마감|접수\s*기간|지원\s*기간/.test(l)) ?? "";
  const date = /(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/.exec(deadlineLine);
  const time = /(\d{1,2}):(\d{2})/.exec(deadlineLine);
  const pad = (v: string) => v.padStart(2, "0");
  const fakeEvidence = page.includes("[가짜:근거없음]");
  const blank: PostingFacts = {
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
    note: "공고 본문을 찾지 못했습니다.",
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
    employmentType: has(/인턴/) ? "intern" : has(/계약직/) ? "contract" : has(/정규직/) ? "full_time" : "unknown",
    workType: has(/원격|리모트/) ? "remote" : has(/하이브리드/) ? "hybrid" : "unknown",
    location: find(/^(?:근무지|근무\s*지역|위치)\s*[:：]\s*(.+)$/)?.value.slice(0, 300) ?? "",
    careerLevel: has(/신입/) ? "entry" : has(/경력\s*무관/) ? "any" : has(/경력/) ? "experienced" : "unknown",
    deadline: date ? `${date[1]}-${pad(date[2]!)}-${pad(date[3]!)}` : "",
    deadlineTime: date && time ? `${pad(time[1]!)}:${time[2]}` : "",
    deadlineEvidence: date ? deadlineLine.slice(0, 500) : "",
    rolling: has(/상시\s*채용|채용\s*시\s*마감/),
    note: lines.slice(0, 5).join("\n").slice(0, 2000),
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
    case "posting-extract":
      return fakePostingExtract(user);
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
