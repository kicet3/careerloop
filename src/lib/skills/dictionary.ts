/**
 * 기술·역량 키워드 사전과 추출·정규화. CareerLoop(src/lib/keywords.ts)에서 가져옴.
 *
 * 가져오면서 고친 점:
 * - 짧은 영어 별칭(Go·Next·Node·REST 등)은 대소문자를 구분한다 — "go to", "next step", "graph node"를 잡지 않는다.
 * - 겹치는 표기는 긴 쪽만 센다 — "자바스크립트"에서 Java를, "React Native"에서 React를 따로 잡지 않는다.
 * - 서로 다른 기술을 한 항목으로 합치던 별칭(PyTorch↔TensorFlow, MySQL↔RDBMS, 메시지 큐↔Kafka)을 나눴다.
 * - 복리후생·일반 문구에서 오탐하던 한국어 별칭("교육", "예약", "보험", "의료", "뷰", "러스트" 등)을 뺐다.
 *   "영업일"은 영업으로 잡지 않는다. "Python3"처럼 숫자가 붙은 버전 표기는 잡는다.
 * - 개발 밖 직군(오피스 도구·디자인·마케팅·영업·기획·데이터 분석 등) 항목을 보탰다.
 * - canonicalSkill: 그래프의 Skill 이름("리액트", "nextjs")을 사전의 정식 명칭으로 맞춘다.
 *
 * 순수 모듈(클라이언트·서버 공용). 새 키워드는 KEYWORD_DICTIONARY에 한 줄 추가하면 된다.
 */

export const KEYWORD_GROUPS = [
  "LLM·에이전트",
  "백엔드",
  "프론트엔드",
  "모바일",
  "데이터·ML",
  "인프라·운영",
  "언어",
  "도구",
  "디자인",
  "마케팅·영업",
  "기획·운영",
  "도메인·역량",
] as const;
export type KeywordGroup = (typeof KEYWORD_GROUPS)[number];

export interface KeywordEntry {
  /** 화면에 보여 줄 정식 명칭(= 정규화 결과). */
  label: string;
  group: KeywordGroup;
  /** 본문에서 대소문자 구분 없이 인식할 표기(정식 명칭 포함). */
  aliases: string[];
  /** 대소문자를 구분해 인식할 표기 — 흔한 영어 단어와 겹치는 짧은 이름. */
  exact: string[];
  /** 별칭 뒤에 이어지면 이 항목으로 보지 않을 말(예: 영업 + "일"). */
  notBefore?: string;
}

interface EntryOptions {
  exact?: string[];
  notBefore?: string;
  /** 정식 명칭 자체를 대소문자 구분 표기로 둔다(Go처럼 명칭이 흔한 단어일 때). */
  labelExact?: boolean;
}

const D = (label: string, group: KeywordGroup, aliases: string[] = [], opts: EntryOptions = {}): KeywordEntry => ({
  label,
  group,
  aliases: opts.labelExact ? aliases : [label, ...aliases],
  exact: opts.labelExact ? [label, ...(opts.exact ?? [])] : (opts.exact ?? []),
  ...(opts.notBefore ? { notBefore: opts.notBefore } : {}),
});

export const KEYWORD_DICTIONARY: KeywordEntry[] = [
  // LLM · 에이전트
  D("LangGraph", "LLM·에이전트", ["랭그래프"]),
  D("LangChain", "LLM·에이전트", ["랭체인"]),
  D("RAG", "LLM·에이전트", ["검색 증강"]),
  D("GraphRAG", "LLM·에이전트", ["그래프RAG"]),
  D("MCP", "LLM·에이전트", ["Model Context Protocol"]),
  D("Multi-agent", "LLM·에이전트", ["멀티에이전트", "Multi agent", "멀티 에이전트"]),
  D("Tool Calling", "LLM·에이전트", ["Function Calling", "툴 콜링"]),
  D("Fine-tuning", "LLM·에이전트", ["파인튜닝", "Finetuning", "미세조정"]),
  D("LoRA", "LLM·에이전트", ["QLoRA"]),
  D("vLLM", "LLM·에이전트"),
  D("SGLang", "LLM·에이전트"),
  D("Triton", "LLM·에이전트"),
  D("LLM", "LLM·에이전트", ["대규모 언어 모델", "거대 언어 모델"]),
  D("프롬프트 엔지니어링", "LLM·에이전트", ["Prompt Engineering", "프롬프트"]),
  D("LLM 평가", "LLM·에이전트", ["평가셋", "평가 셋"], { exact: ["Eval", "Evals"] }),
  D("가드레일", "LLM·에이전트", ["Guardrail"]),
  D("LLM 서빙", "LLM·에이전트", ["모델 서빙", "Model Serving"]),

  // 백엔드
  D("FastAPI", "백엔드"),
  D("Django", "백엔드", ["장고"]),
  D("Flask", "백엔드"),
  D("Node.js", "백엔드", ["NodeJS"], { exact: ["Node"] }),
  D("NestJS", "백엔드", [], { exact: ["Nest"] }),
  D("Spring", "백엔드", ["스프링", "Spring Boot", "스프링 부트"], { labelExact: true }),
  D("Express", "백엔드", ["Express.js"], { labelExact: true }),
  D("Ruby on Rails", "백엔드", ["Rails"]),
  D("비동기", "백엔드", ["asyncio"]),
  D("REST API", "백엔드", ["RESTful", "API 설계"], { exact: ["REST"] }),
  D("GraphQL", "백엔드"),
  D("WebSocket", "백엔드", ["웹소켓"]),
  D("WebRTC", "백엔드"),
  D("gRPC", "백엔드"),
  D("Kafka", "백엔드", ["카프카"]),
  D("RabbitMQ", "백엔드"),
  D("메시지 큐", "백엔드", ["Message Queue", "메시지큐"]),
  D("MSA", "백엔드", ["마이크로서비스", "Microservice", "Microservices"]),

  // 프론트엔드
  D("React", "프론트엔드", ["리액트", "React.js", "ReactJS"]),
  D("Next.js", "프론트엔드", ["NextJS", "넥스트"], { exact: ["Next"] }),
  D("Vue", "프론트엔드", ["Vue.js", "VueJS"]),
  D("Angular", "프론트엔드", ["앵귤러"]),
  D("Svelte", "프론트엔드"),
  D("HTML/CSS", "프론트엔드", ["HTML", "CSS", "HTML5", "CSS3"]),
  D("Tailwind CSS", "프론트엔드", ["Tailwind"]),
  D("웹 접근성", "프론트엔드", ["Accessibility", "a11y", "웹접근성"]),

  // 모바일
  D("React Native", "모바일", ["리액트 네이티브"], { exact: ["RN"] }),
  D("Flutter", "모바일", ["플러터"]),
  D("iOS", "모바일"),
  D("Android", "모바일", ["안드로이드"]),
  D("Swift", "모바일", ["스위프트"]),

  // 데이터 · ML
  D("SQL", "데이터·ML"),
  D("PostgreSQL", "데이터·ML", ["Postgres", "포스트그레"]),
  D("MySQL", "데이터·ML", ["MariaDB"]),
  D("Oracle DB", "데이터·ML", ["Oracle", "오라클"]),
  D("MongoDB", "데이터·ML", ["몽고DB"]),
  D("Redis", "데이터·ML", ["레디스"]),
  D("Elasticsearch", "데이터·ML", ["OpenSearch", "엘라스틱서치", "엘라스틱"]),
  D("Vector DB", "데이터·ML", ["Weaviate", "Pinecone", "Qdrant", "벡터 DB", "벡터DB"]),
  D("Neo4j", "데이터·ML", ["그래프 DB"]),
  D("데이터 파이프라인", "데이터·ML", ["Data Pipeline", "ETL", "Airflow"]),
  D("Spark", "데이터·ML", ["Apache Spark", "PySpark", "스파크"]),
  D("BigQuery", "데이터·ML", ["빅쿼리"]),
  D("PyTorch", "데이터·ML", ["파이토치"]),
  D("TensorFlow", "데이터·ML", ["텐서플로"]),
  D("머신러닝", "데이터·ML", ["Machine Learning", "기계학습", "머신 러닝"]),
  D("딥러닝", "데이터·ML", ["Deep Learning", "딥 러닝"]),
  D("Vision AI", "데이터·ML", ["Computer Vision", "컴퓨터 비전", "OCR"]),
  D("NLP", "데이터·ML", ["자연어 처리", "자연어처리"]),
  D("추천 시스템", "데이터·ML", ["Recommendation", "추천시스템"]),
  D("데이터 분석", "데이터·ML", ["Data Analysis", "데이터분석", "Data Analytics"]),
  D("통계", "데이터·ML", ["Statistics", "통계학"]),
  D("A/B 테스트", "데이터·ML", ["AB 테스트", "A/B Test", "A/B Testing", "AB테스트", "A/B테스트"]),
  D("Tableau", "데이터·ML", ["태블로"]),
  D("Power BI", "데이터·ML", ["PowerBI"]),
  D("Google Analytics", "데이터·ML", ["GA4", "구글 애널리틱스"]),

  // 인프라 · 운영
  D("Docker", "인프라·운영", ["도커"]),
  D("Kubernetes", "인프라·운영", ["K8s", "K3s", "쿠버네티스"]),
  D("AWS", "인프라·운영", ["Amazon Web Services"]),
  D("GCP", "인프라·운영", ["Google Cloud"]),
  D("Azure", "인프라·운영"),
  D("Terraform", "인프라·운영", ["테라폼"]),
  D("Linux", "인프라·운영", ["리눅스"]),
  D("Git", "인프라·운영", ["GitHub", "GitLab"]),
  D("CI/CD", "인프라·운영", ["CICD", "GitHub Actions", "Jenkins"]),
  D("관측성", "인프라·운영", ["Observability", "모니터링"]),
  D("장애 대응", "인프라·운영", ["incident", "장애대응", "장애 탐지"]),
  D("GPU", "인프라·운영", ["CUDA"]),
  D("TDD", "인프라·운영", ["테스트 자동화", "Test Automation"]),

  // 언어
  D("Python", "언어", ["파이썬"]),
  D("TypeScript", "언어", ["타입스크립트"], { exact: ["TS"] }),
  D("JavaScript", "언어", ["자바스크립트"], { exact: ["JS"] }),
  D("Java", "언어", ["자바"]),
  D("Kotlin", "언어", ["코틀린"]),
  D("C++", "언어"),
  D("C#", "언어"),
  D("Go", "언어", ["Golang", "고랭"], { labelExact: true }),
  D("Rust", "언어"),
  D("PHP", "언어"),
  D("Ruby", "언어", ["루비"]),
  D("Scala", "언어", ["스칼라"]),

  // 도구(오피스·협업)
  D("Excel", "도구", ["엑셀", "MS Excel", "스프레드시트", "Google Sheets", "구글 시트"]),
  D("PowerPoint", "도구", ["파워포인트", "PPT"]),
  D("Word", "도구", ["MS Word"], { labelExact: true }),
  D("Notion", "도구", ["노션"]),
  D("Jira", "도구", ["Confluence", "컨플루언스"]),
  D("Slack", "도구", ["슬랙"]),
  D("SAP", "도구"),
  D("ERP", "도구"),
  D("Salesforce", "도구", ["세일즈포스"]),

  // 디자인
  D("Figma", "디자인", ["피그마"]),
  D("Photoshop", "디자인", ["포토샵"]),
  D("Illustrator", "디자인", ["일러스트레이터"]),
  D("After Effects", "디자인", ["애프터이펙트", "애프터 이펙트"]),
  D("Premiere Pro", "디자인", ["프리미어 프로", "프리미어"]),
  D("Sketch", "디자인", [], { labelExact: true }),
  D("UX 디자인", "디자인", ["UX Design", "UX", "사용자 경험", "UI/UX", "UX/UI"]),
  D("UI 디자인", "디자인", ["UI Design", "UI 설계"]),
  D("디자인 시스템", "디자인", ["Design System"]),
  D("프로토타이핑", "디자인", ["Prototyping", "프로토타입"]),
  D("사용자 리서치", "디자인", ["User Research", "UX 리서치", "사용성 테스트", "유저 리서치"]),
  D("브랜드 디자인", "디자인", ["BX", "브랜딩", "Branding"]),

  // 마케팅 · 영업
  D("마케팅", "마케팅·영업", ["Marketing"]),
  D("퍼포먼스 마케팅", "마케팅·영업", ["퍼포먼스마케팅", "Performance Marketing", "광고 운영", "디지털 광고"]),
  D("콘텐츠 마케팅", "마케팅·영업", ["콘텐츠마케팅", "Content Marketing"]),
  D("CRM", "마케팅·영업", ["고객관계관리"]),
  D("CRM 마케팅", "마케팅·영업", ["CRM마케팅", "그로스 마케팅", "Growth Marketing", "그로스 해킹"]),
  D("SEO", "마케팅·영업", ["검색엔진 최적화", "검색 엔진 최적화"]),
  D("SNS 운영", "마케팅·영업", ["소셜 미디어", "SNS 마케팅", "인스타그램"]),
  D("영업", "마케팅·영업", ["Sales", "세일즈", "B2B 영업", "기술 영업"], { notBefore: "일" }),
  D("고객 관리", "마케팅·영업", ["Account Management", "어카운트 매니지먼트", "고객관리"]),

  // 기획 · 운영
  D("서비스 기획", "기획·운영", ["서비스기획", "기획"]),
  D("사업 기획", "기획·운영", ["사업기획", "사업 개발", "Business Development"], { exact: ["BD"] }),
  D("프로덕트 매니지먼트", "기획·운영", ["Product Manager", "Product Owner", "프로덕트 매니저", "프로덕트 오너"], { exact: ["PM", "PO"] }),
  D("프로젝트 관리", "기획·운영", ["Project Management", "PMP", "일정 관리", "애자일", "Agile", "스크럼", "Scrum"]),
  D("운영 관리", "기획·운영", ["Operations", "서비스 운영", "운영 기획"]),
  D("회계", "기획·운영", ["Accounting", "재무회계", "세무"]),
  D("재무", "기획·운영", ["재무 분석", "FP&A", "재무분석"]),
  D("HR", "기획·운영", ["HRM", "HRD", "인사 관리", "인사관리", "인사 담당", "채용 운영"], { labelExact: true }),
  D("고객 지원", "기획·운영", ["고객 응대", "Customer Support", "고객 상담"]),

  // 도메인 · 역량
  D("금융", "도메인·역량", ["핀테크", "Fintech", "증권", "은행", "보험사"]),
  D("커머스", "도메인·역량", ["이커머스", "E-commerce", "e커머스"]),
  D("여행·항공", "도메인·역량", ["OTA", "항공", "여행 플랫폼"]),
  D("게임", "도메인·역량", ["게임엔진", "Unity", "Unreal", "유니티"]),
  D("EdTech", "도메인·역량", ["에듀테크"]),
  D("헬스케어", "도메인·역량", ["Healthcare", "의료 기기", "디지털 헬스"]),
  D("보안", "도메인·역량", ["Security", "사이버보안", "정보보안"]),
  D("기술 문서화", "도메인·역량", ["테크니컬 라이팅", "문서화", "Technical Writing"]),
  D("영어", "도메인·역량", ["OPIc", "TOEIC", "비즈니스 영어", "영어 회화"]),
];

const ESCAPE = /[.*+?^${}()|[\]\\]/g;
/** 영숫자로 시작하고 영숫자·. # + / 로만 된 표기 — 앞뒤에 영숫자가 붙으면 다른 단어로 본다. */
const WORDY = /^[A-Za-z0-9][A-Za-z0-9.#+/&-]*( [A-Za-z0-9][A-Za-z0-9.#+/&-]*)*$/;

/** 별칭 하나를 안전한 정규식 소스로. 영문 토큰은 단어 경계를 적용해 오탐을 막는다(공백은 공백 1개 이상). */
export function aliasPattern(alias: string, notBefore?: string): string {
  const escaped = alias.replace(ESCAPE, "\\$&").replace(/ /g, "\\s+");
  const tail = notBefore ? `(?!${notBefore.replace(ESCAPE, "\\$&")})` : "";
  // 뒤에 영문자가 이어지면 다른 단어("Going", "Javascripting")다. 숫자는 버전 표기("Python3", "Vue3")라 허용한다.
  return WORDY.test(alias) ? `(?<![A-Za-z0-9])${escaped}(?![A-Za-z+#])${tail}` : `${escaped}${tail}`;
}

interface Matcher {
  entry: KeywordEntry;
  regex: RegExp;
}

const MATCHERS: Matcher[] = KEYWORD_DICTIONARY.flatMap((entry) => [
  ...entry.aliases.map((a) => ({ entry, regex: new RegExp(aliasPattern(a, entry.notBefore), "gi") })),
  ...entry.exact.map((a) => ({ entry, regex: new RegExp(aliasPattern(a, entry.notBefore), "g") })),
]);

export interface KeywordHit {
  label: string;
  /** 본문에서 처음 나온 위치(문자 인덱스). */
  index: number;
  /** 처음 나온 표기 그대로. */
  text: string;
}

/**
 * 본문에서 사전 키워드를 위치와 함께 뽑는다(처음 나온 순서, 중복 없음).
 * 겹치는 표기는 긴 쪽이 이긴다 — "자바스크립트"는 JavaScript 하나, "React Native"는 React Native 하나.
 */
export function extractKeywordHits(...texts: string[]): KeywordHit[] {
  const haystack = texts.filter(Boolean).join(" \n ");
  if (!haystack.trim()) return [];

  const spans: { start: number; end: number; label: string; text: string }[] = [];
  for (const { entry, regex } of MATCHERS) {
    regex.lastIndex = 0;
    for (const m of haystack.matchAll(regex)) {
      if (m[0].length === 0) continue;
      spans.push({ start: m.index, end: m.index + m[0].length, label: entry.label, text: m[0] });
    }
  }
  // 긴 표기부터 자리를 차지한다. 이미 차지한 구간과 겹치면 버린다.
  spans.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const taken: { start: number; end: number }[] = [];
  const first = new Map<string, KeywordHit>();
  for (const s of spans) {
    if (taken.some((t) => s.start < t.end && t.start < s.end)) continue;
    taken.push(s);
    const prev = first.get(s.label);
    if (!prev || s.start < prev.index) first.set(s.label, { label: s.label, index: s.start, text: s.text });
  }
  return [...first.values()].sort((a, b) => a.index - b.index);
}

/** 자유 텍스트에서 사전에 있는 키워드의 정식 명칭을 처음 나온 순서로 뽑는다. */
export function extractKeywords(...texts: string[]): string[] {
  return extractKeywordHits(...texts).map((h) => h.label);
}

export function keywordGroup(label: string): KeywordGroup | undefined {
  return KEYWORD_DICTIONARY.find((entry) => entry.label === label)?.group;
}

// ---------------------------------------------------------------------------
// 이름 정규화
// ---------------------------------------------------------------------------

/** 비교용 압축 키: 소문자, 공백·마침표·하이픈·밑줄 제거("Next.js" = "next js" = "nextjs"). */
export function compactKey(name: string): string {
  return name.normalize("NFKC").toLowerCase().replace(/[\s._-]+/g, "");
}

const CANONICAL = new Map<string, string>();
for (const entry of KEYWORD_DICTIONARY) {
  // 이름 하나만 볼 때는 문맥 오탐이 없으니 대소문자 구분 표기도 대소문자 없이 맞춘다("go" 스킬 = Go).
  for (const alias of [entry.label, ...entry.aliases, ...entry.exact]) {
    const key = compactKey(alias);
    if (!CANONICAL.has(key)) CANONICAL.set(key, entry.label);
  }
}

/** 끝의 버전·괄호 표기: "React 18", "Python3", "Vue 3.x", "Java (Spring)", "Node.js v20". */
const VERSION_TAIL = /(\s*\(.*\)|\s*v?\d+(\.\d+|\.x)*\+?)$/i;

/**
 * 기술 이름(그래프 Skill 이름·LLM 키워드 등)을 사전의 정식 명칭으로. 사전에 없으면 null.
 * 이름 전체가 별칭과 같아야 한다 — "Google"은 Go가 아니고, "Python·Django"처럼 둘 이상이면 null.
 */
export function canonicalSkill(name: string): string | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  const direct = CANONICAL.get(compactKey(trimmed));
  if (direct) return direct;
  const stripped = trimmed.replace(VERSION_TAIL, "").trim();
  if (stripped && stripped !== trimmed) return CANONICAL.get(compactKey(stripped)) ?? null;
  return null;
}

/** 비교 키: 사전에 있으면 정식 명칭, 없으면 압축 키. 그래프 대조·스킬 갭 집계가 같은 기술을 한 줄로 묶는 기준. */
export function skillKey(name: string): string {
  return canonicalSkill(name) ?? compactKey(name);
}

// ---------------------------------------------------------------------------
// 매칭
// ---------------------------------------------------------------------------

export interface KeywordMatch {
  /** 공고가 요구하고 내 역량에도 있는 키워드 */
  matched: string[];
  /** 공고가 요구하지만 내 역량에 없는 키워드 */
  missing: string[];
  /** 0~100. 요구 키워드가 없으면 null */
  score: number | null;
}

/** 공고 요구 키워드와 내 기술 목록을 대조한다. 표기가 달라도(리액트/React) 같은 기술이면 보유로 본다. */
export function matchKeywords(required: string[], skills: string[]): KeywordMatch {
  const owned = new Set(skills.map(skillKey));
  const seen = new Set<string>();
  const unique = required.filter((k) => {
    const key = skillKey(k);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const matched = unique.filter((k) => owned.has(skillKey(k)));
  const missing = unique.filter((k) => !owned.has(skillKey(k)));
  return {
    matched,
    missing,
    score: unique.length === 0 ? null : Math.round((matched.length / unique.length) * 100),
  };
}
