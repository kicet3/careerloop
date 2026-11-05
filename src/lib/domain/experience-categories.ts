/**
 * 경험 카테고리(클라이언트·서버 공용, 순수): 자기소개서·이력서·포트폴리오에 반복해서 쓰이는 경험 소재 10가지와 최소 입력 기준.
 * 필수 6개는 모두 채워야 체크리스트가 완료되고, 추천 4개는 더 채우면 좋은 것이다. 근거와 판정 규칙은 docs/EXPERIENCE-CATEGORIES.md.
 *
 * - source "auto": 기존 라벨·관계·속성만 보고 판정한다(career, quantified-result). 태그로 달 수 없다. 규칙은 graph/completeness.ts.
 * - source "tag": Project·Experience.categories에 그 id가 있는 노드가 후보이고, minFields를 모두 채운 후보가 있으면 완료다.
 */
import { STORY_TAG_ALIASES, STORY_TAGS, type StoryTag } from "./graph";

export type StoryField = "situation" | "myRole" | "action" | "result" | "learned";
export type ExperienceCategoryId = "career" | "quantified-result" | StoryTag;

export interface ExperienceCategory {
  id: ExperienceCategoryId;
  name: string;
  description: string;
  required: boolean;
  source: "auto" | "tag";
  /** 이 소재가 쓰이는 자소서·이력서 문항. */
  coverLetterItems: string[];
  /** 태그 카테고리의 최소 필드(auto는 [] — 규칙은 completeness.ts). */
  minFields: StoryField[];
  /** 채팅이 사용자에게 물을 질문. */
  guideQuestion: string;
  /** 체크리스트 버튼이 채팅 입력에 미리 채울 사용자 문장. */
  chatStarter: string;
  /** LLM이 한국어로 태그를 줄 때 id로 바꾸는 별칭(auto는 []). */
  aliases: readonly string[];
}

/** STAR 필드의 한국어 이름(화면·힌트·채팅 문구). */
export const STORY_FIELD_NAMES: Record<StoryField, string> = {
  situation: "상황·목표(S·T)",
  myRole: "내 역할",
  action: "내 행동(A)",
  result: "결과(R)",
  learned: "배운 점",
};

const starter = (name: string) => `${name} 경험을 정리하고 싶어요. 필요한 내용을 하나씩 물어봐 주세요.`;

type TagDef = Omit<ExperienceCategory, "id" | "source" | "chatStarter" | "aliases"> & { id: StoryTag };

const TAG_CATEGORIES: TagDef[] = [
  {
    id: "problem-solving",
    name: "문제 해결·개선(트러블슈팅)",
    description: "문제의 원인을 찾아 직접 바꾸고 전후가 달라진 경험",
    required: true,
    coverLetterItems: ["문제해결·창의", "직무역량", "NCS 문제해결능력"],
    minFields: ["situation", "action", "result"],
    guideQuestion: "가장 집요하게 해결한 문제는 무엇이었나요? 원인을 어떻게 찾았고, 무엇을 바꿨고, 전후가 어떻게 달라졌나요?",
  },
  {
    id: "collaboration",
    name: "협업·갈등 해결",
    description: "팀으로 목표를 이루거나 의견 차이를 조율한 경험",
    required: true,
    coverLetterItems: ["협업·팀워크", "갈등 해결·의사소통", "NCS 대인관계·의사소통"],
    minFields: ["situation", "myRole", "action", "result"],
    guideQuestion: "팀으로 목표를 이뤘거나 의견이 갈렸던 경험이 있나요? 내 역할, 조율 방법, 결과를 알려 주세요.",
  },
  {
    id: "challenge-failure",
    name: "도전·실패 극복",
    description: "높은 목표에 도전했거나 실패한 뒤 다시 시도한 경험",
    required: true,
    coverLetterItems: ["도전·목표 달성", "실패·극복"],
    minFields: ["situation", "action", "result", "learned"],
    guideQuestion: "스스로 높게 잡은 목표나 크게 실패한 경험은 무엇인가요? 어떻게 다시 시도했고 무엇을 배웠나요?",
  },
  {
    id: "motivation",
    name: "지원동기 소재(직무 관심 계기)",
    description: "이 직무에 관심을 갖게 된 계기와 그 뒤 직접 준비한 활동",
    required: true,
    coverLetterItems: ["지원동기", "입사 후 포부의 근거"],
    minFields: ["situation", "action"],
    guideQuestion: "이 직무에 관심을 갖게 된 계기는 무엇이었고, 그 뒤 무엇을 직접 해 보셨나요?",
  },
  {
    id: "leadership",
    name: "리더십·주도성",
    description: "직접 일을 시작하거나 팀을 이끈 경험",
    required: false,
    coverLetterItems: ["리더십·주도성", "인재상"],
    minFields: ["situation", "myRole", "action", "result"],
    guideQuestion: "직접 일을 시작하거나 팀을 이끈 경험이 있나요? 맡은 직책, 규모, 결과는 어땠나요?",
  },
  {
    id: "values",
    name: "성장과정·가치관(장단점 포함)",
    description: "지금의 일하는 태도와 가치관을 만든 사건",
    required: false,
    coverLetterItems: ["성장과정", "가치관", "성격의 장단점"],
    minFields: ["situation", "action", "learned"],
    guideQuestion: "지금의 일하는 태도를 만든 사건이나 사람이 있나요? 그때 어떻게 행동했고 어떤 가치관이 생겼나요?",
  },
  {
    id: "learning",
    name: "자기개발·학습",
    description: "직무를 위해 꾸준히 배우고 결과물을 남긴 경험",
    required: false,
    coverLetterItems: ["자기개발", "직무역량 준비", "NCS 자기개발능력"],
    minFields: ["situation", "action", "result"],
    guideQuestion: "직무를 위해 꾸준히 배운 것이 있나요? 기간, 방법, 결과물을 알려 주세요.",
  },
  {
    id: "responsibility",
    name: "책임감·직업윤리·고객지향",
    description: "끝까지 책임지거나 원칙·고객을 위해 불편을 감수한 경험",
    required: false,
    coverLetterItems: ["책임감·주인의식", "NCS 직업윤리", "고객지향·서비스"],
    minFields: ["situation", "action", "result"],
    guideQuestion: "끝까지 책임지고 해낸 일이나, 원칙 또는 고객을 위해 불편을 감수한 경험이 있나요?",
  },
];

export const EXPERIENCE_CATEGORIES: readonly ExperienceCategory[] = [
  {
    id: "career",
    name: "직무 경험(경력·인턴·프로젝트)",
    description: "지원 직무와 맞닿은 회사 경력이나 프로젝트(기간·역할·한 일)",
    required: true,
    source: "auto",
    coverLetterItems: ["직무역량·전문성", "NCS 경력·경험기술서", "이력서 경력·프로젝트"],
    minFields: [],
    guideQuestion: "지원 직무와 가장 가까운 회사 경험이나 프로젝트를 하나 골라 주세요. 기간, 맡은 역할, 주로 한 일이 무엇이었나요?",
    chatStarter: starter("직무 경험(경력·인턴·프로젝트)"),
    aliases: [],
  },
  {
    id: "quantified-result",
    name: "정량 성과",
    description: "숫자로 말할 수 있는 결과(전후 값, %, 건수, 기간)",
    required: true,
    source: "auto",
    coverLetterItems: ["직무역량", "도전·목표 달성", "이력서 핵심 성과·불릿"],
    minFields: [],
    guideQuestion: "그 경험의 결과를 숫자로 말할 수 있나요? 예: 처리 시간 3일→1일, 전환율 12%→18%, 참여자 40명",
    chatStarter: "경험의 성과를 숫자로 정리하고 싶어요. 어떤 수치를 남기면 좋을지 물어봐 주세요.",
    aliases: [],
  },
  ...TAG_CATEGORIES.map((c) => ({ ...c, source: "tag" as const, chatStarter: starter(c.name), aliases: STORY_TAG_ALIASES[c.id] })),
];

const BY_ID = new Map(EXPERIENCE_CATEGORIES.map((c) => [c.id, c]));

export function experienceCategory(id: ExperienceCategoryId): ExperienceCategory {
  return BY_ID.get(id)!;
}

/** 태그 id → 카테고리 이름(화면 표시). */
export function storyTagName(tag: string): string {
  return (STORY_TAGS as readonly string[]).includes(tag) ? BY_ID.get(tag as StoryTag)!.name : tag;
}
