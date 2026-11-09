/**
 * 이력서 문장 끝 경어체 통일(순수): 생성된 문장은 '~했습니다/~합니다/~입니다'로 끝낸다(평어체 '~했다/~한다/~이다' 금지).
 * - HONORIFIC_RULE: 모든 생성 프롬프트(단일 초안·에이전트 v1/v2·심사위원 채팅 작성 기준·포트폴리오)에 들어가는 규칙 문구.
 * - detectPlainEndings: 문장 끝(마침표·느낌표·물음표·줄바꿈·문자열 끝 바로 앞)의 평어체 종결만 찾는다. 단어 중간의 '다'(다양·다수),
 *   따옴표·[ADD: …] 안, 영어, '바다'처럼 명사로 끝나는 줄은 건드리지 않는다.
 * - normalizeHonorific: 확실한 경우만 결정적으로 바꾸고(했다→했습니다, 한다→합니다, 이다→입니다, 있다→있습니다 …),
 *   판단할 수 없는 평어체 문장(예: '개발자다.', 'ㄹ' 받침 '만들다.')은 바꾸지 않고 leftovers로 돌려준다(호출부가 notes·심사 지적으로 넘긴다).
 * - normalizeDocumentHonorific: ResumeDocument의 서술 칸에만 적용한다(이름·직무명·회사·링크·날짜·기술명은 건드리지 않는다).
 * Python 워커(worker/app/honorific.py)가 같은 규칙을 옮겼다 — 바꾸면 honorific.test.ts로 fixture(worker/tests/fixtures/honorific.json)를 다시 만든다.
 */
import type { ResumeDocument } from "@/lib/domain/resumes";

/** 프롬프트 규칙(틀림/맞음 예시 포함). scope는 '문장으로 끝나는 줄'이 무엇인지(문서마다 칸 이름이 다르다). */
export function honorificRuleFor(scope: string): string {
  return `문체: 문장으로 끝나는 줄(${scope})은 모두 경어체 '~했습니다/~합니다/~입니다'로 끝낸다. 평어체 '~했다/~한다/~이다/~였다/~있다'로 끝내지 않는다. 예: (틀림) '정산 배치 시간을 40% 줄였다.' → (맞음) '정산 배치 시간을 40% 줄였습니다.' / (틀림) '주문 API를 설계하고 운영한다.' → (맞음) '주문 API를 설계하고 운영합니다.' / (틀림) '결제 도메인 3년 차 백엔드 개발자이다.' → (맞음) '결제 도메인 3년 차 백엔드 개발자입니다.' 'API 응답 40% 개선'처럼 명사로 끝나는 개조식 줄은 그대로 둘 수 있다. 문체만 맞추고 뜻·수치·고유명사·[ADD: …] 자리표시는 바꾸지 않는다.`;
}

/** 이력서 생성 프롬프트 규칙(단일 초안·에이전트 v1/v2·심사위원 채팅 — writing-guide.ts 작성 기준에 들어간다). */
export const HONORIFIC_RULE = honorificRuleFor("요약·한 줄 소개·핵심 성과 상세·경력 담당 범위와 불릿·프로젝트 요약·문제·개선·결과·직무 역량 설명·수상·기타 설명·지원 동기");

/** 짧은 규칙(지원 동기 초안처럼 이미 '~습니다'를 정한 프롬프트에 덧붙인다). */
export const HONORIFIC_ENDING_HINT = "문장 끝은 경어체('~했습니다/~합니다/~입니다')로 쓰고 평어체('~했다/~한다/~이다')로 끝내지 않는다.";

const HANGUL_FIRST = 0xac00;
const HANGUL_LAST = 0xd7a3;
/** 받침 번호(유니코드 한글 음절 종성 인덱스). */
const JONG_NONE = 0;
const JONG_N = 4; // ㄴ
const JONG_L = 8; // ㄹ
const JONG_B = 17; // ㅂ
const JONG_SS = 20; // ㅆ

const isSyllable = (ch: string | undefined): ch is string => !!ch && ch.charCodeAt(0) >= HANGUL_FIRST && ch.charCodeAt(0) <= HANGUL_LAST;
const jong = (ch: string) => (ch.charCodeAt(0) - HANGUL_FIRST) % 28;
const withJong = (ch: string, j: number) => String.fromCharCode(ch.charCodeAt(0) - jong(ch) + j);

/** 문장 끝 '다': 앞의 한글 덩어리 + '다' 뒤에 (공백) 마침표·느낌표·물음표·말줄임·줄바꿈·문자열 끝. 닫는 괄호·따옴표가 바로 붙으면 문장 끝으로 보지 않는다. */
const ENDING_RE = /([가-힣]*)다(?=[ \t]*(?:[.!?。…]|\r?\n|$))/g;
/** 건드리지 않는 구간: [ADD: …] 자리표시, 따옴표 안. */
const PROTECTED_RE = /\[ADD:[^\]]*\]|"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|「[^」\n]*」|『[^』\n]*』/g;
/** '다'로 끝나지만 평어체 종결이 아닌 말(명사·조사·외래어 — '람다'를 '람습니다'로 바꾸지 않는다). */
const NOT_ENDING_SUFFIXES = ["바다", "보다", "마다", "람다", "혼다", "아젠다", "어젠다", "프로파간다", "캐나다", "우간다", "르완다"];
/** '이'로 끝나는 명사 + 서술격 '다'(이 탈락) — '차이다'를 '차입니다'로 바꾸지 않도록 판단하지 않는다(leftover). */
const AMBIGUOUS_I_NOUNS = ["차이", "사이", "아이", "나이", "길이", "깊이", "넓이", "놀이"];
/** '다' 바로 앞이 한글이 아니면서 서술격 조사가 빠진 꼴('40%다.', 'Kafka다.'). */
const NON_HANGUL_BEFORE_RE = /[0-9A-Za-z%)\]]/;
const SENTENCE_BOUNDARY = ".!?。\n";
const SNIPPET_MAX = 60;

export interface PlainEnding {
  /** '다' 덩어리의 시작 위치(원문 기준). */
  index: number;
  /** 원문 덩어리(예: '개선했다'). */
  token: string;
  /** 경어체로 바꾼 덩어리. 판단할 수 없으면 null(leftover). */
  replacement: string | null;
  /** 그 문장(앞 문장 경계부터 '다'까지, 60자 안). */
  snippet: string;
}

/** 덩어리(stem + '다') → 경어체. 평어체 종결이 아니면 undefined, 평어체지만 판단할 수 없으면 null. */
function convertToken(stem: string): string | null | undefined {
  const p = stem.at(-1);
  if (!isSyllable(p)) return null; // '40%다.' 같은 꼴(호출부가 앞 글자를 본다)
  const pp = stem.length >= 2 ? stem[stem.length - 2] : undefined;
  const head = stem.slice(0, -1);
  const j = jong(p);
  if (NOT_ENDING_SUFFIXES.some((s) => `${stem}다`.endsWith(s))) return undefined;
  if (p === "니") {
    if (isSyllable(pp) && jong(pp) === JONG_B) return undefined; // 이미 '~습니다/~합니다/~입니다'
    if (pp === "아") return `${head.slice(0, -1)}아닙니다`;
    return null;
  }
  if (j === JONG_SS) return `${stem}습니다`; // 했다·였다·됐다·있었다·맡았다·냈다·왔다·겠다
  if (j === JONG_NONE) {
    if (p === "하") return `${head}합니다`; // 가능하다·필요하다
    if (p === "이") return AMBIGUOUS_I_NOUNS.some((n) => stem.endsWith(n)) ? null : `${head}입니다`; // ~것이다·~개발자이다·줄이다
    return null; // '개발자다.'·'되다.'처럼 판단할 수 없음
  }
  if (j === JONG_N) {
    if (p === "는") {
      // 먹는다·읽는다·맡는다 → 먹습니다…(받침 있는 어간). 받침 없거나 ㄹ이면 판단하지 않는다.
      if (isSyllable(pp) && jong(pp) !== JONG_NONE && jong(pp) !== JONG_L) return `${head}습니다`;
      return null;
    }
    return `${head}${withJong(p, JONG_B)}니다`; // 한다→합니다·된다→됩니다·만든다→만듭니다·줄인다→줄입니다
  }
  if (j === JONG_L) return null; // 만들다·길다(사전형) — 판단하지 않는다
  return `${stem}습니다`; // 있다·없다·많다·같다·않다·높다
}

function protectedRanges(text: string): [number, number][] {
  return [...text.matchAll(PROTECTED_RE)].map((m) => [m.index, m.index + m[0].length]);
}

function snippetAt(text: string, start: number, end: number): string {
  let s = start;
  while (s > 0 && !SENTENCE_BOUNDARY.includes(text[s - 1]!)) s--;
  const t = text.slice(s, end).trim();
  return t.length > SNIPPET_MAX ? `…${t.slice(t.length - (SNIPPET_MAX - 1))}` : t;
}

/** 문장 끝 평어체 종결(바꿀 수 있는 것과 판단할 수 없는 것 모두). 이미 경어체·개조식·명사 끝·따옴표·[ADD] 안은 없다. */
export function detectPlainEndings(text: string): PlainEnding[] {
  const ranges = protectedRanges(text);
  const out: PlainEnding[] = [];
  for (const m of text.matchAll(ENDING_RE)) {
    const stem = m[1]!;
    const daAt = m.index + stem.length;
    if (ranges.some(([a, b]) => daAt >= a && daAt < b)) continue;
    let replacement: string | null | undefined;
    if (stem === "") {
      const before = m.index > 0 ? text[m.index - 1]! : "";
      if (!NON_HANGUL_BEFORE_RE.test(before)) continue;
      replacement = null;
    } else {
      replacement = convertToken(stem);
      if (replacement === undefined) continue;
    }
    out.push({ index: m.index, token: m[0], replacement, snippet: snippetAt(text, m.index, m.index + m[0].length) });
  }
  return out;
}

export interface HonorificResult {
  text: string;
  /** 판단할 수 없어 그대로 둔 평어체 문장(바꾼 뒤 원문 조각). */
  leftovers: string[];
  /** 바꾼 종결 수. */
  changed: number;
}

/** 문장 끝 평어체를 확실한 경우만 경어체로 바꾼다(뜻·수치·[ADD]는 그대로). 남은 평어체 문장은 leftovers. */
export function normalizeHonorific(text: string): HonorificResult {
  const found = detectPlainEndings(text);
  let out = "";
  let last = 0;
  let changed = 0;
  for (const f of found) {
    if (f.replacement === null) continue;
    out += text.slice(last, f.index) + f.replacement;
    last = f.index + f.token.length;
    changed++;
  }
  out += text.slice(last);
  const leftovers = detectPlainEndings(out).map((f) => f.snippet);
  return { text: out, leftovers, changed };
}

export interface DocumentHonorificLeftover {
  /** 문서 경로(citations.ts 줄 경로와 같은 꼴, 예: experience[0].bullets[1]). */
  path: string;
  text: string;
}

export interface DocumentHonorificResult {
  document: ResumeDocument;
  changed: number;
  leftovers: DocumentHonorificLeftover[];
}

/**
 * 문서의 서술 칸에 normalizeHonorific을 적용한다(입력은 바꾸지 않는다). 대상: basics.tagline, summary, highlights title·details(상세 성과 줄),
 * experience scope·bullets, projects summary·problem·action·result·bullets, skills detail, extras items, motivation.
 * 이름·직무명(headline·title·role)·회사·팀·기간·링크·기술명·학력·자격은 대상이 아니다.
 */
export function normalizeDocumentHonorific(doc: ResumeDocument): DocumentHonorificResult {
  const d = structuredClone(doc);
  let changed = 0;
  const leftovers: DocumentHonorificLeftover[] = [];
  const fix = (path: string, value: string): string => {
    if (!value) return value;
    const r = normalizeHonorific(value);
    changed += r.changed;
    for (const t of r.leftovers) leftovers.push({ path, text: t });
    return r.text;
  };
  d.basics.tagline = fix("basics.tagline", d.basics.tagline);
  d.summary = fix("summary", d.summary);
  d.highlights.forEach((h, i) => {
    h.title = fix(`highlights[${i}].title`, h.title);
    h.details = h.details.map((t, j) => fix(`highlights[${i}].details[${j}]`, t));
  });
  d.experience.forEach((e, i) => {
    e.scope = fix(`experience[${i}].scope`, e.scope);
    e.bullets = e.bullets.map((b, j) => fix(`experience[${i}].bullets[${j}]`, b));
  });
  d.projects.forEach((p, i) => {
    p.summary = fix(`projects[${i}].summary`, p.summary);
    p.problem = fix(`projects[${i}].problem`, p.problem);
    p.action = fix(`projects[${i}].action`, p.action);
    p.result = fix(`projects[${i}].result`, p.result);
    p.bullets = p.bullets.map((b, j) => fix(`projects[${i}].bullets[${j}]`, b));
  });
  d.skills.forEach((s, i) => {
    s.detail = fix(`skills[${i}].detail`, s.detail);
  });
  d.extras.forEach((x, i) => {
    x.items = x.items.map((t, j) => fix(`extras[${i}].items[${j}]`, t));
  });
  d.motivation = fix("motivation", d.motivation);
  return { document: d, changed, leftovers };
}

/** 남은 평어체 문장 안내(notes 한 줄). 없으면 null. */
export function honorificLeftoverNote(leftovers: readonly { text: string }[]): string | null {
  if (leftovers.length === 0) return null;
  const first = leftovers[0]!.text;
  return `문장 끝을 '~습니다'로 자동으로 바꾸지 못한 문장 ${leftovers.length}개가 있습니다. 직접 확인해 주세요: '${first}'${leftovers.length > 1 ? " 외" : ""}`;
}
