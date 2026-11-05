/**
 * 이력서 작성 기준(클라이언트·서버 공용, 순수). 작성·면접 가이드 5장(이력서·경력기술서)·9장(제출 전 점검)을 제품 문구로 다시 쓴 것.
 * - 편집기 팁 패널(components/resumes/ResumeWritingTips.tsx)이 화면 문구로,
 * - AI 초안(resumes/draft.ts)·재작성/방향성 단계(panel/prompts.ts)·심사위원 채팅(chat/reviewer-chat.ts)이 프롬프트 기준으로 같은 내용을 쓴다.
 * 특정인의 사례·원문 문장을 옮기지 않고, 확인 가능한 행동으로 바꿔 적었다.
 */
import type { ResumeDocument } from "@/lib/domain/resumes";

export interface WritingTip {
  title: string;
  body: string;
}

/** 첫 화면에서 바로 보여야 할 네 가지(가이드 5.1). */
export const FIRST_SCREEN_ITEMS = [
  { key: "headline", title: "지원 직무와 한 줄 소개", body: "어떤 일을 하는 사람인지 실제 경험과 이어서 한 문장으로 씁니다." },
  { key: "highlight", title: "직무에 맞는 대표 성과", body: "의미 있는 지표와 내가 한 행동을 함께 보여 줍니다." },
  { key: "experience", title: "최근 경력과 맡은 범위", body: "회사·직무·기간과 담당 범위를 빠르게 확인할 수 있게 둡니다." },
  { key: "project", title: "대표 프로젝트와 근거 위치", body: "더 자세히 볼 내용과 면접에서 물어볼 거리를 알려 줍니다." },
] as const;
export type FirstScreenKey = (typeof FIRST_SCREEN_ITEMS)[number]["key"];

/** 한 줄 소개 빈 틀. 숫자는 확인된 것만 넣는다. */
export const HEADLINE_TEMPLATE = "[지원 직무]로서 [고객·업무의 문제]를 [핵심 행동]으로 개선해 [확인된 결과]를 만든 경험이 있습니다.";

/** 프로젝트마다 반복할 순서(가이드 5.2). */
export const PROJECT_STRUCTURE = ["프로젝트명 · 기간 · 역할", "배경과 목표", "문제와 판단", "실행", "결과와 근거"] as const;

/** 모호한 표현 → 고칠 때 스스로 물을 질문 → 빈 문장 틀(가이드 5.2 표를 다시 씀). */
export const VAGUE_PHRASE_FIXES = [
  { before: "○○ 분석 담당", ask: "무엇을 확인했고 그 결과 어떤 결정을 도왔나요?", frame: "[자료]를 [방법]으로 분석해 [판단·변화]에 기여" },
  { before: "○○ 운영 지원", ask: "어느 범위를 직접 실행했나요?", frame: "[운영 범위]의 [업무]를 맡아 [확인된 결과] 달성" },
  { before: "뛰어난 소통 능력", ask: "누구와 무엇을 어떤 기준으로 합의했나요?", frame: "[서로 다른 요구]를 [합의 기준]으로 조율해 [결과] 도출" },
  { before: "다양한 업무 수행", ask: "그 업무들을 어떤 역량으로 묶을 수 있나요?", frame: "[직무 핵심 업무]를 중심으로 [관련 경험] 요약" },
] as const;

/** 성과 숫자와 함께 확인할 여섯 가지(가이드 5.3). */
export const NUMBER_CHECKS = ["지표 정의", "전후 값", "측정 기간", "대상·모수", "출처", "본인 역할"] as const;

export const NUMBER_PITFALLS: readonly string[] = [
  "횟수는 실행 규모입니다. 그 활동으로 무엇이 달라졌는지 이어 주세요.",
  "10%→12%는 2%p 상승(상대 20% 증가)입니다. %와 %p를 섞지 마세요.",
  "매출·계약액·파이프라인·실현 수익은 서로 다른 값입니다. 하나로 바꿔 쓰지 마세요.",
  "팀 성과와 내 기여를 나누세요. 기여도 %는 산정 기준이 있을 때만 씁니다.",
  "전후 비교만으로 인과가 증명되지는 않습니다. 다른 요인과 측정 한계를 설명할 준비를 하세요.",
  "숫자가 없다면 도입 여부, 재사용된 문서, 재발 없음 확인, 이해관계자 반응처럼 확인 가능한 결과를 쓰세요.",
];

/** 협업·개성은 형용사 대신 장면으로(가이드 5.4). */
export const BEHAVIOR_STRUCTURE = ["상황", "내 행동", "상대·업무의 변화", "지금의 일하는 방식"] as const;

/** 제출 전 12개 체크리스트(가이드 9.2를 행동 중심으로 다시 씀). id는 체크 상태 저장 키라 바꾸지 않는다. */
export const SUBMIT_CHECKLIST = [
  { id: "c1", text: "상단만 봐도 지원 직무와 핵심 경험이 보인다." },
  { id: "c2", text: "기억시키고 싶은 강점을 실제 경험 하나 이상이 뒷받침한다." },
  { id: "c3", text: "대표 성과나 확인 가능한 결과가 첫 화면에 있다." },
  { id: "c4", text: "공고가 요구한 제출 형식과 항목을 채웠다." },
  { id: "c5", text: "주요 수치마다 정의·전후·기간·대상·출처를 설명할 수 있다." },
  { id: "c6", text: "질문받고 싶은 대표 경험에 꼬리 질문 답변을 준비했다." },
  { id: "c7", text: "프로젝트마다 내 역할과 팀 역할이 구분된다." },
  { id: "c8", text: "협업·갈등·적응을 행동으로 보여 주는 사례가 있다." },
  { id: "c9", text: "모든 서류와 면접 준비 자료의 숫자·기간이 서로 같다." },
  { id: "c10", text: "'진행 중'·'예정' 같은 상태가 제출일 기준 사실과 맞다." },
  { id: "c11", text: "불필요한 개인정보, 근거 없는 형용사, 무관한 내용을 정리했다." },
  { id: "c12", text: "최종 출력본의 오탈자·빈칸·잘림·링크를 끝까지 확인했다." },
] as const;
export type SubmitChecklistId = (typeof SUBMIT_CHECKLIST)[number]["id"];

// ---------------------------------------------------------------------------
// 문서 점검(순수) — 팁 패널이 '지금 이력서'에 맞춰 보여 줄 신호
// ---------------------------------------------------------------------------

const filled = (s: string | undefined | null) => {
  const t = (s ?? "").replace(/\[ADD:[^\]]*\]/g, "").trim();
  return t.length > 0;
};

/** '참여·지원·담당·수행' 등으로만 끝나 행동이 보이지 않는 문장. */
const VAGUE_END_RE = /(참여|지원|담당|수행|진행|보조|관리)(함|했음|하였음|했습니다|하였습니다|합니다|중)?\s*[.。]?$/;

export interface ResumeTipSignals {
  firstScreen: Record<FirstScreenKey, boolean>;
  /** 모호하게 끝나는 문장(최대 5개, 원문 그대로). */
  vagueLines: string[];
  /** 숫자가 있지만 기간·대상 단서가 없는 문장(최대 5개). */
  numberLinesWithoutContext: string[];
  /** 남은 [ADD: …] 자리표시 수. */
  addPlaceholders: number;
}

function bulletLines(doc: ResumeDocument): string[] {
  return [
    ...doc.highlights.flatMap((h) => [h.title, h.context]),
    ...doc.experience.flatMap((e) => e.bullets),
    ...doc.projects.flatMap((p) => [p.result, p.action, ...p.bullets]),
  ]
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/** 기간·대상 단서(개월·주·분기·연도·명·건·회 등). 없으면 숫자만 있는 문장으로 본다. */
const CONTEXT_RE = /(\d{4}\s*년|\d\s*(개월|주|주간|분기|년|일간|명|건|회|곳|개사)|기간|동안|대상|기준|사용자|고객)/;

export function resumeTipSignals(doc: ResumeDocument): ResumeTipSignals {
  const lines = bulletLines(doc);
  const exp0 = doc.experience[0];
  const proj0 = doc.projects[0];
  const all = JSON.stringify(doc);
  return {
    firstScreen: {
      headline: filled(doc.basics.headline) || filled(doc.summary),
      highlight: doc.highlights.some((h) => filled(h.title)),
      experience: !!exp0 && filled(exp0.company) && (filled(exp0.startDate) || filled(exp0.endDate)) && (filled(exp0.scope) || exp0.bullets.some(filled)),
      project: !!proj0 && filled(proj0.name) && (filled(proj0.result) || filled(proj0.summary) || proj0.bullets.some(filled)),
    },
    vagueLines: lines.filter((l) => VAGUE_END_RE.test(l)).slice(0, 5),
    numberLinesWithoutContext: lines.filter((l) => /\d/.test(l) && /%|배|원|건|시간|분|초/.test(l) && !CONTEXT_RE.test(l)).slice(0, 5),
    addPlaceholders: (all.match(/\[ADD:/g) ?? []).length,
  };
}

// ---------------------------------------------------------------------------
// 프롬프트 기준(초안·재작성·심사위원 채팅 공용). 짧게 유지한다 — 기존 규칙(지어내지 않기·[ADD:])이 우선이다.
// ---------------------------------------------------------------------------

export const RESUME_WRITING_CRITERIA_PROMPT = [
  "이력서 작성 기준(자료에 있는 사실로만 적용한다. 사실이 없으면 지어내지 않고 [ADD: …]로 남긴다):",
  "- 첫 화면에서 ① 지원 직무와 한 줄 소개 ② 직무에 맞는 대표 성과 ③ 최근 경력과 맡은 범위 ④ 대표 프로젝트가 바로 보이게 배치한다.",
  "- 프로젝트는 모두 같은 순서로 쓴다: 이름·기간·역할 → 배경과 목표 → 문제와 판단 → 실행 → 결과와 근거.",
  "- '참여·지원·담당'으로만 끝나는 문장은 무엇을 분석·결정·만들었는지로 바꾼다. 보조 역할을 총괄로 부풀리지 않는다.",
  "- 성과 숫자는 지표 정의·전후 값·측정 기간·대상(모수)·출처·본인 역할 중 자료에 있는 것을 함께 쓴다. %와 %p를 구분하고, 매출·계약액처럼 다른 값을 바꿔 쓰지 않으며, 팀 성과와 개인 기여를 나눈다. 전후 비교를 인과로 단정하지 않는다.",
  "- 숫자가 없으면 도입·재사용·재발 없음 확인처럼 확인 가능한 결과를 쓴다.",
  "- 협업·성격은 형용사 대신 상황 → 내 행동 → 상대·업무의 변화로 보여 준다.",
  "- '진행 중'인 일을 완료형으로 바꾸지 않는다.",
].join("\n");
