/**
 * 개발자 포트폴리오 양식(템플릿) 목록(클라이언트·서버 공용, 순수).
 *
 * 국내외 개발자 포트폴리오 작성 가이드(링커리어·원티드·요즘IT·알체라 개발자 포트폴리오 가이드, 해외 케이스 스터디 작성법,
 * DataTalksClub ML 포트폴리오 가이드)에서 자주 쓰는 6가지 형태를 정리했다. 양식마다 구역(섹션)의 순서·제목·작성 지침이 있고,
 * 경험 그래프 포트폴리오(graph-portfolio.ts)는 고른 양식의 구역 순서·제목대로 AI 출력을 받고 Markdown을 그린다.
 *
 * 구역 종류(kind):
 * - text: AI가 쓰는 구역(문단 body + 목록 bullets). 자료에 없으면 지어내지 않고 [ADD: …]로 남긴다.
 * - skills: 서버가 그린다 — 최상위는 대표 기술(coreSkills), 프로젝트는 그 프로젝트 기술(techStack).
 * - links: 서버가 그래프의 주소(Project.url, 공개 GitHub 저장소)로만 붙인다(AI는 주소를 쓰지 않는다).
 * - toc: 서버가 프로젝트 이름으로 목차를 만든다.
 * - contact: 서버가 그린다 — 사용자가 연결한 GitHub 계정 프로필 주소만 붙이고, 그 밖(이메일·블로그)은 [ADD]로 남긴다.
 *   프로젝트 저장소·데모 주소는 넣지 않는다(프로젝트마다 '링크' 구역에 있다).
 * 구역은 before(프로젝트 앞) · project(프로젝트마다) · after(프로젝트 뒤) 세 자리에 놓인다.
 */
import { z } from "zod";

export const PORTFOLIO_TEMPLATE_IDS = ["project-pdf", "notion-web", "career-case", "case-study", "github-readme", "ml-data"] as const;
export type PortfolioTemplateId = (typeof PORTFOLIO_TEMPLATE_IDS)[number];
export const DEFAULT_PORTFOLIO_TEMPLATE_ID: PortfolioTemplateId = "project-pdf";
export const PortfolioTemplateIdSchema = z.enum(PORTFOLIO_TEMPLATE_IDS, { error: "알 수 없는 포트폴리오 양식입니다." });

export type PortfolioSectionKind = "text" | "skills" | "links" | "toc" | "contact";

export interface PortfolioTemplateSection {
  /** 구역 key(영문 소문자). AI 출력의 sections[].key와 맞춘다. 같은 자리(최상위 / 프로젝트) 안에서 겹치지 않는다. */
  key: string;
  /** 본문에 쓰는 제목. */
  heading: string;
  /** AI에게 주는 작성 지침(kind 'text'). 서버가 그리는 구역은 화면 설명용. */
  guide: string;
  kind: PortfolioSectionKind;
  /** 자료가 없으면 생략해도 되는 구역. 필수 구역이 비면 서버가 [ADD: … 보완 필요]를 남긴다. */
  optional?: boolean;
}

export interface PortfolioTemplate {
  id: PortfolioTemplateId;
  /** 화면 이름. */
  name: string;
  /** 한두 문장 설명. */
  description: string;
  /** 누구에게 맞는지(대상). */
  audience: string;
  /** 분량 가이드. */
  length: string;
  /** 이 양식에서만 따로 지킬 작성 규칙(공통 규칙은 PORTFOLIO_COMMON_RULES). */
  rules: readonly string[];
  /** 프로젝트 제목 앞 머리말(예: '사례'). 비우면 번호만. */
  projectLabel?: string;
  before: readonly PortfolioTemplateSection[];
  project: readonly PortfolioTemplateSection[];
  after: readonly PortfolioTemplateSection[];
}

const t = (key: string, heading: string, guide: string, optional = false): PortfolioTemplateSection => ({
  key,
  heading,
  guide,
  kind: "text",
  ...(optional ? { optional: true } : {}),
});
const skills = (heading = "기술 스택", guide = "자료에 연결된 기술(서버가 채운다)"): PortfolioTemplateSection => ({ key: "skills", heading, guide, kind: "skills" });
const links = (heading = "링크", guide = "그래프에 있는 주소·공개 GitHub 저장소(서버가 채운다)", optional = true): PortfolioTemplateSection => ({
  key: "links",
  heading,
  guide,
  kind: "links",
  ...(optional ? { optional: true } : {}),
});

const contact = (heading = "연락처", guide = "연결한 GitHub 프로필(서버가 채운다). 이메일·블로그는 직접 채운다([ADD])"): PortfolioTemplateSection => ({
  key: "contact",
  heading,
  guide,
  kind: "contact",
});

/** 모든 양식에 공통으로 적용하는 작성 규칙(조사 결과의 공통 항목). */
export const PORTFOLIO_COMMON_RULES: readonly string[] = [
  "프로젝트마다 본인 역할·기여도를 분명히 적고 팀 성과와 본인 기여를 구분한다(기여도·인원이 자료에 없으면 [ADD: 팀 인원·기여도]).",
  "기능 나열보다 왜 그렇게 설계했는지(기술 선택 이유·대안·트레이드오프)를 쓴다.",
  "트러블슈팅은 문제 → 원인 → 해결 → 결과 → 배운 점 순서로 쓴다.",
  "성과는 'X를 Y만큼 개선, Z를 통해'(XYZ) 또는 상황·행동·결과(CAR/STAR) 형태로 쓰되 수치는 자료에 적힌 값만 쓴다.",
  "직무에 맞게 강조한다: 백엔드는 API·DB 성능과 안정성, 프론트엔드는 렌더링 성능·사용자 경험·배포, 인프라는 장애 대응·자동화, AI·데이터는 베이스라인 대비 개선.",
  "다이어그램·스크린샷이 필요한 자리는 [ADD: 아키텍처 다이어그램] 처럼 자리만 남긴다.",
  "AI 도구를 활용한 경험이 자료에 있으면 결과를 어떻게 검증했는지도 쓴다.",
  "프로젝트명·기간·수치는 자료(이력서와 같은 출처) 그대로 써서 이력서와 어긋나지 않게 한다. 회사 기밀로 보이는 내용(고객사 실명·내부 매출 등)은 notes에 확인 요청을 남긴다.",
];

export const PORTFOLIO_TEMPLATES: readonly PortfolioTemplate[] = [
  {
    id: "project-pdf",
    name: "프로젝트 중심 PDF",
    description: "자기소개·기술 스택·목차 뒤에 프로젝트를 2~3쪽씩 문제 → 해결 → 결과로 정리하는 가장 흔한 국내 기본형.",
    audience: "신입·주니어(기본형)",
    length: "프로젝트 3~4개(대표·최신 순), 프로젝트당 A4 2~3쪽",
    rules: ["자기소개는 3줄 이내로 어떤 문제를 어떤 방식으로 푸는 사람인지 쓴다.", "결과에는 가능하면 전후 비교(Before → After)를 넣는다."],
    before: [
      t("intro", "자기소개", "3줄 이내. 어떤 문제를 어떤 방식으로 푸는 개발자인지, 자료에 있는 사실로만."),
      skills("기술 스택", "대표 기술(숙련도는 자료에 있을 때만, 서버가 채운다)"),
      { key: "toc", heading: "목차", guide: "프로젝트 목록(서버가 채운다)", kind: "toc" },
    ],
    project: [
      t("overview", "개요", "기간·인원·역할·기여도·핵심 기능을 짧게(문단 1~3문장 또는 목록). 인원·기여도가 자료에 없으면 [ADD: 팀 인원·기여도]."),
      skills(),
      t("problem", "문제", "해결하려던 문제와 그 원인(배경·상황). 2~4문장."),
      t("solution", "해결", "bullets 한 항목 한 문장: 무엇을 → 어떻게 → 왜(설계 이유·대안 비교)."),
      t("result", "결과", "bullets: 전후 수치(자료에 있는 값만). 수치가 없으면 산출물·적용 범위를 쓰거나 [ADD: 전후 수치]."),
      t("troubleshooting", "트러블슈팅", "bullets: 문제 → 원인 → 해결 → 결과를 한 항목에. 자료에 없으면 비운다.", true),
      t("learned", "배운 점", "이 프로젝트에서 배운 점 1~2문장(자료에 있을 때만).", true),
      links(),
    ],
    after: [t("retrospective", "회고·성장 방향", "프로젝트들에서 드러난 강점과 앞으로의 성장 방향 2~3문장(자료 근거가 있을 때만).", true)],
  },
  {
    id: "notion-web",
    name: "노션형 웹 포트폴리오",
    description: "About Me·경력 요약·역량 뒤에 프로젝트를 짧은 카드처럼 정리하는 웹 공유용 형식. 결과보다 일하는 방식을 보여 준다.",
    audience: "노션·웹 링크로 공유하는 신입~경력",
    length: "프로젝트 3~5개, 프로젝트당 화면 1~2개 분량(짧게)",
    rules: ["프로젝트 요약은 1~2줄로 짧게 쓴다.", "어떤 방법으로 일했는지(협업·의사결정·도구)를 드러낸다."],
    before: [
      t("about", "About Me", "2~3문장: 어떤 개발자인지, 일하는 방식 중심(자료에 있는 사실로만)."),
      t("career", "경력 요약", "bullets: 소속 · 기간 · 역할 한 줄씩(자료에 있는 것만). 경력이 없으면 비운다.", true),
      skills("역량", "하드 스킬·도구(숙련도는 자료에 있을 때만, 서버가 채운다)"),
    ],
    project: [
      t("summary", "요약", "무엇을 왜 만들었는지 1~2줄."),
      t("role", "역할·기여", "역할·팀 규모·기여도·일한 방식. 자료에 없는 값은 [ADD: 팀 규모·기여도]."),
      skills("사용 기술"),
      t("work", "주요 작업", "bullets: 한 항목 한 문장, 방법 중심(무엇을 어떻게, 왜)."),
      t("results", "성과", "bullets: 정량 성과(자료에 있는 값만), 없으면 산출물·적용 범위."),
      links(),
    ],
    after: [
      t("side", "사이드 프로젝트·블로그·오픈소스", "bullets: 자료에 있는 사이드 활동·글·기여(없으면 비운다).", true),
      t("workstyle", "일하는 방식", "협업·코드 리뷰·문서화 등 자료에서 드러나는 습관 2~3문장.", true),
      t("failure", "실패 회고", "실패하거나 막혔던 경험과 그 뒤 바꾼 점(자료에 있을 때만).", true),
      contact(),
    ],
  },
  {
    id: "career-case",
    name: "경력 기술형",
    description: "요약 뒤에 회사·팀 맥락의 사례를 배경 → 문제 → 분석 → 해결 → 기술 선택 이유 → 결과로 기술하는 경력직 형식.",
    audience: "경력 3년 이상",
    length: "대표 사례 3~5개, 사례당 A4 1~2쪽",
    projectLabel: "사례",
    rules: [
      "사례마다 소속(회사·팀)과 비즈니스 맥락을 함께 쓴다.",
      "기술 선택은 비즈니스 요구·제약과 연결해 설명한다.",
      "요약에는 연차·도메인·대표 성과 2~3개를 쓴다(연차·성과는 자료에 있을 때만).",
    ],
    before: [t("summary", "요약", "연차·도메인·대표 성과 2~3개(bullets 가능). 자료에 없는 연차는 [ADD: 총 경력 연차]."), skills()],
    project: [
      t("context", "배경", "회사·팀·서비스 맥락과 팀 규모, 내 직책(자료에 있는 것만)."),
      t("problem", "문제", "비즈니스·기술 문제 2~3문장."),
      t("analysis", "분석", "원인을 어떻게 찾았는지(지표·로그·실험).", true),
      t("solution", "해결", "bullets: 한 항목 한 문장, 본인이 한 일 중심."),
      t("decision", "기술 선택 이유", "왜 그 기술·설계를 골랐는지, 대안과 트레이드오프."),
      t("result", "결과", "bullets: 비즈니스·기술 지표(자료에 있는 값만)."),
      t("learned", "배운 점", "1~2문장(자료에 있을 때만).", true),
      skills("사용 기술"),
      links(),
    ],
    after: [
      t("architecture", "설계·아키텍처 경험", "bullets: 사례 전반에서 드러난 설계·아키텍처 경험(자료에 있을 때만).", true),
      t("activities", "대외 활동", "bullets: 발표·오픈소스·멘토링 등(자료에 있을 때만).", true),
    ],
  },
  {
    id: "case-study",
    name: "케이스 스터디",
    description: "Problem·Role·Constraints·Approach·Decisions·Result 순서로 의사결정 과정을 보여 주는 글로벌 형식. 기술 스택으로 시작하지 않는다.",
    audience: "해외·글로벌 기업 지원, 의사결정·제품 감각을 보여 주고 싶은 개발자",
    length: "사례 2~4개, 사례당 1~2쪽",
    projectLabel: "Case",
    rules: ["기술 스택으로 시작하지 않고 문제에서 시작한다.", "결정마다 고려한 대안과 트레이드오프를 쓴다.", "결과는 2~4문장으로, 수치는 자료에 있는 값만."],
    before: [t("summary", "소개", "어떤 문제를 푸는 사람인지 1~2문장.", true)],
    project: [
      t("problem", "Problem · 문제", "누구의 어떤 문제였는지, 왜 중요했는지."),
      t("role", "Role · 역할", "내 역할과 책임 범위, 팀 구성(자료에 있는 것만)."),
      t("constraints", "Constraints · 제약", "시간·인력·레거시·성능 등 제약(자료에 있을 때만).", true),
      t("approach", "Approach · 접근", "문제를 어떻게 나누고 접근했는지."),
      t("decisions", "Decisions · 결정과 트레이드오프", "bullets: 결정 → 고려한 대안 → 고른 이유."),
      t("challenges", "Challenges · 어려움", "막혔던 점과 해결(자료에 있을 때만).", true),
      t("result", "Result · 결과", "2~4문장, 수치는 자료에 있는 값만."),
      t("next", "Next step · 다음 단계", "다시 한다면·다음에 할 일(자료에 있을 때만).", true),
      skills("Stack · 기술"),
      links(),
    ],
    after: [],
  },
  {
    id: "github-readme",
    name: "GitHub README형",
    description: "저장소 README처럼 배경·주요 기능·기술 스택·아키텍처·실행 방법·의사결정을 정리하는 형식. 사이드·오픈소스 프로젝트에 맞다.",
    audience: "GitHub 저장소 링크로 보여 주는 사이드·오픈소스 프로젝트",
    length: "프로젝트 1~3개, 프로젝트마다 README 한 장 분량",
    rules: [
      "스크린샷·다이어그램 자리는 [ADD: 스크린샷] · [ADD: 아키텍처 다이어그램]으로 남긴다.",
      "설치·실행 방법이 자료에 없으면 지어내지 말고 [ADD: 설치·실행 명령]으로 남긴다.",
    ],
    before: [],
    project: [
      t("background", "배경·문제", "왜 만들었는지, 어떤 문제를 푸는지 2~3문장."),
      t("features", "주요 기능", "bullets: 기능 한 줄씩(자료에 있는 것만). 화면이 필요하면 [ADD: 스크린샷]."),
      skills(),
      t("architecture", "아키텍처", "구성 요소와 흐름을 글로 요약하고 [ADD: 아키텍처 다이어그램] 자리를 남긴다."),
      t("setup", "설치·실행", "자료에 있는 실행 방법만. 없으면 [ADD: 설치·실행 명령].", true),
      t("usage", "사용 예시", "대표 사용 흐름(자료에 있을 때만).", true),
      t("decisions", "트러블슈팅·기술적 의사결정", "bullets: 문제 → 원인 → 해결 → 결과, 또는 결정 → 이유."),
      t("team", "팀·기여도", "팀 구성과 본인 기여(자료에 없으면 [ADD: 팀 구성·기여도])."),
      links(),
    ],
    after: [],
  },
  {
    id: "ml-data",
    name: "AI·데이터형",
    description: "문제 정의 → 베이스라인 → 데이터 → 평가 설계 → 모델 선택 → 결과 → 서빙 → 재현성 → 한계 순서로 실험 과정을 보여 주는 형식.",
    audience: "ML·AI 엔지니어, 데이터 엔지니어·분석가",
    length: "프로젝트 2~4개, 프로젝트당 A4 2쪽 안팎",
    rules: [
      "결과는 반드시 베이스라인과 비교해 쓴다(베이스라인이 자료에 없으면 [ADD: 베이스라인 성능]).",
      "데이터 누수 점검·평가 지표 선택 이유를 쓴다(자료에 있을 때만).",
    ],
    before: [t("intro", "소개", "어떤 데이터·모델 문제를 푸는 사람인지 2~3문장."), skills()],
    project: [
      t("problem", "문제 정의", "목표·비목표·성공 지표."),
      t("baseline", "베이스라인", "비교 기준(규칙 기반·기존 모델 등)과 그 성능(자료에 있는 값만)."),
      t("data", "데이터·라벨", "출처·규모·라벨링 방식·전처리·누수 점검(자료에 있는 것만)."),
      t("evaluation", "평가 설계", "지표와 검증 방식, 그 지표를 고른 이유."),
      t("model", "모델 선택 근거", "후보 모델과 고른 이유·트레이드오프."),
      t("result", "결과", "bullets: 베이스라인 대비 개선(자료에 있는 값만)."),
      t("serving", "서빙·운영", "배포·모니터링·비용(자료에 있을 때만).", true),
      t("reproducibility", "재현성", "코드·데이터 버전·실험 관리(자료에 있을 때만).", true),
      t("limits", "한계·리스크·다음 단계", "알려진 한계와 다음에 할 일.", true),
      skills("사용 기술"),
      links(),
    ],
    after: [],
  },
];

const BY_ID = new Map(PORTFOLIO_TEMPLATES.map((tpl) => [tpl.id, tpl]));

export function isPortfolioTemplateId(v: unknown): v is PortfolioTemplateId {
  return typeof v === "string" && BY_ID.has(v as PortfolioTemplateId);
}

/** id의 양식(모르는 id·없으면 기본 양식). */
export function getPortfolioTemplate(id: string | null | undefined): PortfolioTemplate {
  return (id && BY_ID.get(id as PortfolioTemplateId)) || BY_ID.get(DEFAULT_PORTFOLIO_TEMPLATE_ID)!;
}

/** 최상위 구역(before + after) — AI 출력의 sections[]가 쓰는 자리. */
export function templateTopSections(tpl: PortfolioTemplate): PortfolioTemplateSection[] {
  return [...tpl.before, ...tpl.after];
}

// ---------------------------------------------------------------------------
// 추천
// ---------------------------------------------------------------------------

/** 경험 그래프에서 뽑은 추천 근거(서버가 그래프로 계산한다 — graph-material.ts portfolioTemplateSignals). */
export interface PortfolioTemplateSignals {
  /** 그래프의 기술 이름 전체. */
  skillNames: readonly string[];
  /** 재직(Role) 기간 합(개월). */
  careerMonths: number;
}

export interface PortfolioTemplateRecommendation {
  id: PortfolioTemplateId;
  reason: string;
}

/**
 * 모델링·학습 계열 기술(AI·데이터형의 베이스라인·평가 설계 구역을 채울 만한 경험). LLM API·LangChain·RAG처럼 'AI 활용' 도구와
 * pandas·numpy·Spark·Airflow처럼 일반 개발자도 흔히 쓰는 데이터 도구는 세지 않는다.
 */
const ML_SKILL_RE =
  /(pytorch|tensorflow|keras|jax\b|scikit|sklearn|xgboost|lightgbm|catboost|hugging\s*face|transformers|mlflow|kubeflow|onnx|opencv|yolo|bert\b|computer vision|머신\s*러닝|딥\s*러닝|machine learning|deep learning|data science|데이터\s*사이언스|추천\s*시스템|컴퓨터\s*비전|모델\s*학습|fine[\s-]*tuning|파인\s*튜닝)/i;

/** 모델링·학습 계열(ML) 기술 수. */
export function countMlSkills(names: readonly string[]): number {
  return new Set(names.map((n) => n.trim().toLowerCase()).filter((n) => n && ML_SKILL_RE.test(n))).size;
}

/**
 * 그래프에 맞는 기본 양식: 모델링·학습 기술이 3개 이상이면 AI·데이터형, 재직 기간(겹침 제외 합)이 3년 이상이면 경력 기술형, 그 밖은 프로젝트 중심 PDF.
 */
export function recommendPortfolioTemplate(s: PortfolioTemplateSignals): PortfolioTemplateRecommendation {
  const ml = countMlSkills(s.skillNames);
  if (ml >= 3) {
    return { id: "ml-data", reason: `경험 그래프에 모델링·학습 기술이 ${ml}개 있습니다.` };
  }
  if (s.careerMonths >= 36) {
    return { id: "career-case", reason: `재직 기간이 ${Math.floor(s.careerMonths / 12)}년 이상입니다.` };
  }
  return { id: DEFAULT_PORTFOLIO_TEMPLATE_ID, reason: "가장 널리 쓰는 기본형입니다." };
}
