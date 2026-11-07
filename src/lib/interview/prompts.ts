/**
 * 면접 연습 프롬프트(순수). 작성·면접 가이드 7장의 기준을 지시문으로 다시 썼다:
 * 서류 한 줄마다 질문 묶음(7.6), 대표 프로젝트 5단계(7.1), PIVOT 빈틈 확인(7.2), 곤란한 질문(7.4),
 * 이직 사유·지원 동기(7.5), 결론 → 직접 근거 → 한계로 짧게 답하기(7.3), 질문 유형별 답변 길이(7.7).
 * 자료(이력서·포트폴리오·공고·답변)는 모두 태그로 감싼 데이터다(INJECTION_RULE).
 */
import { CHAT_TAGS } from "@/lib/domain/chat";
import {
  INTERVIEW_CATEGORY_LABELS,
  INTERVIEW_FACET_LABELS,
  INTERVIEW_LIMITS,
  LINE_FACETS,
  MOTIVATION_FACETS,
  PIVOT_FACETS,
  PROJECT_FACETS,
  RECOMMENDED_ANSWER_SECONDS,
  TOUGH_FACETS,
  estimateSpokenSeconds,
  type InterviewQuestionView,
  type InterviewSourceLine,
  type InterviewSourceSnapshot,
} from "@/lib/domain/interview";
import { field, INJECTION_RULE, wrapData } from "@/lib/chat/prompt";
import { sourceLinesToPrompt } from "./source";

const facetList = (facets: readonly string[]) => facets.map((f) => `${f}(${INTERVIEW_FACET_LABELS[f] ?? f})`).join(", ");

// ---------------------------------------------------------------------------
// 질문 생성
// ---------------------------------------------------------------------------

export const INTERVIEW_QUESTIONS_SYSTEM = `너는 한국어 면접 코치이자 이 지원자의 서류를 미리 읽은 면접관이다. 지원자의 이력서(+ 포트폴리오, + 채용 공고)를 근거로 실제 면접에서 나올 예상 질문을 만든다.
근거 자료는 <${CHAT_TAGS.interviewSources}>에 한 줄씩 id를 붙여 준다: 이력서 [r1]…, 포트폴리오 [p1]…, 채용 공고 [j1]….

## 인용 규칙
1. 질문마다 그 질문을 낳은 서류 줄을 citations에 단다: ref는 줄 id(예: r3), quote는 그 줄에서 글자 그대로 옮긴 짧은 부분(10~60자). 번역·요약·맞춤법 수정 금지.
2. line·project·pivot·tough 질문은 이력서(r) 또는 포트폴리오(p) 줄을 최소 1개 인용한다. 인용할 수 없는 질문은 만들지 않는다.
3. motivation 질문은 관련 이력서 줄이나 공고 줄(j)을 인용할 수 있으면 인용하고, job 질문은 비워도 된다.
4. 서류에 없는 사실(회사, 숫자, 기술, 성과)을 질문에 사실처럼 넣지 않는다. 서류에서 빠진 정보는 "~은 무엇이었나요?"처럼 묻는다.

## 질문 구성 (category · facet)
- line(서류 한 줄 질문): 성과·기여 문장 가운데 검증이 필요한 줄을 고르고, 줄마다 다음 관점 중 가장 취약한 2~3개를 묻는다. facet: ${facetList(LINE_FACETS)}.
  모든 줄에 같은 질문을 기계적으로 붙이지 않는다. 숫자가 있는 줄은 측정 방법·다른 요인, 역할이 모호한 줄은 본인 역할을 우선한다.
- project(대표 프로젝트 5단계): 가장 대표적인 프로젝트(또는 경력 성과) 1~2개를 골라 단계마다 하나씩 묻는다. facet: ${facetList(PROJECT_FACETS)}.
  특히 문제 정의에서 현상만 말하고 멈추지 않는지(어느 구간에서 왜 그랬는지 어떻게 확인했는지) 파고든다.
- pivot(빈틈 확인): 대표 경험 하나에 P·I·V·O·T 순서로 묻는다. facet: ${facetList(PIVOT_FACETS)}.
- tough(곤란한 질문): 서류에서 실제로 해당하는 상황만 고른다. facet: ${facetList(TOUGH_FACETS)}. 예: 숫자가 큰 성과 → number, 팀 성과 → team, 공고 요건 중 서류에 없는 기술 → unfamiliar, 결과의 다른 원인 → counter.
- motivation(지원 동기·이직 사유·자기소개): facet ${facetList(MOTIVATION_FACETS)}. intro(자기소개)는 항상 1개. 경력이 있으면 change(이직 사유) 1개. 공고가 있으면 motivation은 공고의 업무와 서류 경험을 잇는 질문으로.
- job(직무 일반): 채용 공고가 없을 때만 지원 직무 기준으로 3~5개(이 직무에서 흔히 확인하는 역량·상황 질문). facet은 null. 공고가 있으면 job 대신 공고 요건(j 줄)과 서류를 잇는 line·tough 질문을 만든다.

## 분량·형식
- 전체 20~32개(최대 ${INTERVIEW_LIMITS.questionsPerSession}개). 대략 line 8~14, project 5~10, pivot 5, tough 2~5, motivation 2~3, job(공고 없을 때) 3~5. 서류가 짧으면 줄인다.
- question은 면접관이 실제로 말할 한 문장(존댓말, ${INTERVIEW_LIMITS.questionChars}자 이내). intent는 이 질문이 확인하려는 것 한 줄.
- followUps: 답변 뒤 이어질 꼬리 질문 1~2개(대안·역할·검증·반례·지원팀 적용 쪽).
- 같은 내용을 다른 말로 반복하지 않는다. 순서는 line → project → pivot → tough → motivation → job.
- notes: 서류에서 비어 있어 면접 전에 확인해 둘 점(최대 5개).

${INJECTION_RULE}
출력은 주어진 JSON 스키마를 정확히 따르는 JSON 하나뿐이다.`;

/** 질문 생성 프롬프트(순수). system은 가이드 7장 기준·인용 규칙·INJECTION_RULE, user는 <interview_sources> 등 태그 자료. */
export function buildInterviewQuestionsPrompt(snapshot: InterviewSourceSnapshot): { system: string; user: string } {
  const r = snapshot.resume;
  const hasJd = snapshot.lines.some((l) => l.doc === "posting");
  const company = snapshot.posting?.company || r.company;
  const role = snapshot.posting?.roleTitle || r.roleTitle;
  const portfolioLines = snapshot.lines.filter((l) => l.doc === "portfolio").length;
  const docs = [
    `이력서 ${snapshot.lines.filter((l) => l.doc === "resume").length}줄`,
    `포트폴리오 ${portfolioLines}줄${snapshot.portfolio?.truncated ? "(앞부분만)" : ""}`,
    `채용 공고 ${snapshot.lines.filter((l) => l.doc === "posting").length}줄`,
  ].join(", ");
  const user = [
    "## 면접 정보",
    field("이력서 종류", r.kind === "general" ? "공용 이력서(특정 회사용 아님)" : "지원처별 이력서"),
    field("지원 회사", company || "(정하지 않음)"),
    field("지원 직무", role || "(이력서에서 판단)"),
    field("채용 공고", hasJd ? "있음 — job 질문 대신 공고 요건과 서류를 잇는 질문" : "없음 — job(직무 일반) 질문 3~5개 포함"),
    ...(snapshot.portfolio?.kind === "url" && snapshot.portfolio.url
      ? [
          field(
            "포트폴리오",
            portfolioLines > 0
              ? "링크 + 지원자가 직접 쓴 설명(p 줄은 그 설명이다 — 링크 너머 내용은 읽지 못했으니 추측하지 않는다)"
              : "링크만 있음(내용은 읽지 못했다 — 링크 너머 내용을 추측하지 않는다)",
          ),
        ]
      : []),
    field("근거 줄 수", docs),
    "",
    "## 근거 자료(줄 id로 인용한다)",
    wrapData(CHAT_TAGS.interviewSources, sourceLinesToPrompt(snapshot.lines)),
    "",
    "## 할 일",
    "위 자료로 예상 면접 질문을 만들고 결과 JSON을 낸다.",
  ].join("\n");
  return { system: INTERVIEW_QUESTIONS_SYSTEM, user };
}

// ---------------------------------------------------------------------------
// 답변 피드백
// ---------------------------------------------------------------------------

export const INTERVIEW_FEEDBACK_SYSTEM = `너는 한국어 면접 코치다. 지원자가 예상 질문에 연습 삼아 쓴 답변을 평가하고, 지원자 자신의 사실로만 더 나은 답의 뼈대를 잡아 준다. 위로보다 실제로 나아지는 피드백을 준다.

## 평가 기준 (각 1~5점, 1=부족 5=충분)
- evidence(근거): 주장마다 실제 자료·장면을 댔는가. 질문받은 단계에 가장 직접적인 근거를 먼저 냈는가.
- numbers(수치): 숫자가 있으면 지표 정의·전후 값·기간·대상·측정 방법이 함께 있는가. %와 %p를 섞거나 서로 다른 값을 같은 성과처럼 말하지 않는가. 숫자가 없는 질문이면 확인 가능한 결과를 냈는가.
- ownership(본인 역할): 팀 결과와 본인이 직접 결정·실행한 일이 구분되는가. "우리가"만 있고 "제가"가 없으면 낮게.
- length(길이): 질문 유형에 맞는 길이인가(서버가 잰 말하기 시간을 참고). 질문 하나에 프로젝트 전체를 처음부터 다시 설명하면 낮게.
- structure(구조): 결론 → 가장 직접적인 근거 → 필요한 한계·다음 조치 순서인가. 경험 질문은 상황→과제→행동→결과, 의견 질문은 주장→이유→사례→주장으로 압축됐는가.
- overall(0~100): 다섯 기준과 질문 의도에 답했는지를 종합한 점수. 후하게 주지 않는다.

## 모범 답변 개요(modelAnswer)
1. 지원자의 서류(<${CHAT_TAGS.interviewSources}>)와 이번 답변(<${CHAT_TAGS.interviewAnswer}>)에 있는 사실만 쓴다. 회사·숫자·기간·기술·성과를 지어내지 않는다.
2. 필요한데 모르는 사실은 [ADD: 확인할 내용] 자리표시로 남긴다(예: [ADD: 측정 기간과 대상]).
3. conclusion은 질문에 바로 답하는 첫 문장, points는 근거 순서(최대 4개, 각 point의 ref는 근거 줄 id — 답변에서만 나온 사실이면 null), limitation은 밝힐 한계나 다음 조치(없으면 빈 문자열).

## 그 밖
- strengths(최대 3)·improvements(최대 4)는 이 답변에 대한 구체적인 문장으로. 막연한 조언("더 구체적으로") 금지 — 무엇을 더할지 말한다.
- unsupportedClaims: 답변에 있지만 서류에서 확인되지 않는 주장(틀렸다는 뜻이 아니라 면접 전에 근거를 준비할 것). 없으면 빈 배열.
- followUp: 이 답변을 들은 면접관이 이어서 물을 꼬리 질문 하나(답변의 가장 약한 지점을 파고든다).
- 해설은 한국어, 존댓말로 짧게.

${INJECTION_RULE}
출력은 주어진 JSON 스키마를 정확히 따르는 JSON 하나뿐이다.`;

/** 질문 하나의 피드백에 넣을 근거 줄: 인용 줄 + 같은 항목(경력·프로젝트) 줄 + 포트폴리오 이웃 줄 + 공고 앞부분(동기·직무 질문). 최대 16줄. */
export function feedbackContextLines(
  question: Pick<InterviewQuestionView, "category" | "citations">,
  lines: readonly InterviewSourceLine[],
  max = 16,
): InterviewSourceLine[] {
  const byId = new Map(lines.map((l) => [l.id, l]));
  const picked = new Set<string>();
  const add = (id: string) => {
    if (picked.size < max && byId.has(id)) picked.add(id);
  };
  const prefixOf = (path: string | null) => (path ? path.split(".").slice(0, 2).join(".") : null);
  for (const c of question.citations) add(c.ref);
  for (const c of question.citations) {
    const line = byId.get(c.ref);
    if (!line) continue;
    if (line.doc === "resume") {
      const prefix = prefixOf(line.path);
      if (prefix && /^(experience|projects|highlights)\./.test(prefix)) {
        for (const l of lines) if (l.doc === "resume" && prefixOf(l.path) === prefix) add(l.id);
      }
    } else {
      const n = Number(line.id.slice(1));
      add(`${line.id[0]}${n - 1}`);
      add(`${line.id[0]}${n + 1}`);
    }
  }
  if (question.category === "motivation" || question.category === "job" || question.citations.length === 0) {
    for (const l of lines) if (l.doc === "resume" && /^(basics\.(headline|tagline)|summary\.|highlights\.)/.test(l.path ?? "")) add(l.id);
    for (const l of lines.filter((x) => x.doc === "posting").slice(0, 6)) add(l.id);
  }
  return lines.filter((l) => picked.has(l.id));
}

/** 답변 피드백 프롬프트(순수). 질문·답변·관련 근거 줄(인용 줄 + 같은 항목 줄)만 넣는다. */
export function buildInterviewFeedbackPrompt(input: {
  question: InterviewQuestionView;
  answer: string;
  durationSec: number | null;
  lines: readonly InterviewSourceLine[];
}): { system: string; user: string } {
  const q = input.question;
  const rec = RECOMMENDED_ANSWER_SECONDS[q.category];
  const facet = q.facet ? INTERVIEW_FACET_LABELS[q.facet] ?? q.facet : null;
  const user = [
    "## 질문 정보",
    field("질문 유형", `${INTERVIEW_CATEGORY_LABELS[q.category]}${facet ? ` · ${facet}` : ""}`),
    field("질문 의도", q.intent || "(없음)"),
    field("질문 근거 줄", q.citations.length ? q.citations.map((c) => c.ref).join(", ") : "(없음)"),
    field("권장 답변 길이", `${rec.min}~${rec.max}초`),
    field("서버가 잰 답변 길이", `공백 제외 ${input.answer.replace(/\s+/g, "").length}자, 말하기 약 ${estimateSpokenSeconds(input.answer)}초`),
    ...(input.durationSec != null ? [field("지원자가 적은 답변 시간", `${input.durationSec}초`)] : []),
    "",
    "## 관련 서류 줄(모범 답변의 근거로 id를 쓴다)",
    wrapData(CHAT_TAGS.interviewSources, input.lines.length ? sourceLinesToPrompt(input.lines) : "(관련 서류 줄 없음)"),
    "",
    "## 질문",
    wrapData(CHAT_TAGS.interviewQuestion, q.question),
    "",
    "## 지원자의 답변",
    wrapData(CHAT_TAGS.interviewAnswer, input.answer),
    "",
    "## 할 일",
    "위 기준으로 답변을 평가하고 결과 JSON을 낸다.",
  ].join("\n");
  return { system: INTERVIEW_FEEDBACK_SYSTEM, user };
}
