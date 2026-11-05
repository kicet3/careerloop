/**
 * JD 원문을 제목 줄 기준으로 구역에 나눈다(클라이언트·서버 공용, 순수): 필수 요건·우대 사항·주요 업무에 더해
 * 복리후생·채용 절차·근무 조건·회사 소개·제출 서류/지원 방법·기술 스택. 어느 구역 제목도 아닌 줄은 other.
 * 구조화 공고의 정규식 대체 경로(structureFromText, src/lib/postings/structure.ts)가 쓴다.
 * CareerLoop(src/lib/writing.ts analyzeJobDescription)에서 가져옴. 기술 키워드는 src/lib/skills/dictionary.ts 사전으로 뽑는다.
 */
import { extractKeywords } from "@/lib/skills/dictionary";

export interface JdSections {
  required: string[];
  preferred: string[];
  duties: string[];
  benefits: string[];
  process: string[];
  /** 근무 조건(연봉·근무 시간·근무지 등). "근무지: 서울"처럼 제목과 값이 한 줄이면 줄 전체를 둔다. */
  conditions: string[];
  company: string[];
  /** 제출 서류·지원 방법. */
  application: string[];
  /** '기술 스택' 제목 아래(또는 "기술 스택: A, B" 한 줄)의 기술 이름 줄. */
  tech: string[];
  other: string[];
  /** 사전에 있는 기술·역량 키워드(정식 명칭). */
  keywords: string[];
}

type Section = Exclude<keyof JdSections, "keywords">;

const HEADING_RE =
  /^[[【<]?(자격\s*요건|필수\s*(?:요건|사항|조건|역량)?|지원\s*자격|우대\s*(?:사항|조건|요건)?|담당\s*업무|주요\s*업무|업무\s*내용|하는\s*일|이런\s*일을\s*해요|requirements|required qualifications|minimum qualifications|preferred qualifications|nice to have|responsibilities|what you(?:'|’)ll do)[\]】>]?(?:\s*[:：]\s*(.*))?$/i;

/** 그 밖의 구역 제목. 이후 내용은 앞 구역(특히 필수 요건)에 섞지 않는다. */
const EXTRA_HEADINGS: { section: Section; re: string }[] = [
  { section: "benefits", re: "복리\\s*후생|복지(?:\\s*(?:제도|혜택))?|혜택(?:\\s*및\\s*복지)?|benefits|perks" },
  { section: "process", re: "전형\\s*(?:절차|과정|단계|방법)?|채용\\s*(?:절차|과정|전형|프로세스)|hiring process|interview process|recruitment process" },
  {
    section: "conditions",
    re: "근무\\s*(?:조건|환경|형태|시간|지역|장소|지|요일)|급여(?:\\s*조건)?|연봉|처우|고용\\s*형태|working conditions|compensation|salary|location",
  },
  { section: "company", re: "회사\\s*소개|기업\\s*소개|팀\\s*소개|about\\s*(?:us|the\\s*(?:company|team))|who we are|company" },
  {
    section: "application",
    // '제출 서류·지원 방법'은 구조 조합(composeJdText)이 쓰는 제목이다.
    re: "제출\\s*서류(?:\\s*(?:[·・/,]|및)\\s*지원\\s*방법)?|지원\\s*(?:방법|절차|서류)|접수\\s*(?:방법|기간)|구비\\s*서류|how to apply|application(?:\\s*process)?",
  },
  { section: "tech", re: "기술\\s*스택|사용\\s*기술|개발\\s*환경|tech(?:nology)?\\s*stack" },
  { section: "other", re: "기타\\s*(?:사항|안내)?|유의\\s*사항|참고\\s*사항" },
];
const EXTRA_RES = EXTRA_HEADINGS.map(({ section, re }) => ({
  section,
  re: new RegExp(`^[[【<]?(?:${re})[\\]】>]?(?:\\s*[:：]\\s*(.*))?$`, "i"),
}));

/** 줄이 구역 제목인가(필수·우대·업무 또는 그 밖의 구역). 구조화의 근거 검증이 제목 줄을 항목에서 뺄 때 쓴다. */
export function isSectionHeadingLine(line: string): boolean {
  const l = line.trim();
  if (!l) return false;
  const h = HEADING_RE.exec(l);
  if (h && !h[2]?.trim()) return true;
  return EXTRA_RES.some(({ re }) => {
    const m = re.exec(l);
    return !!m && !m[1]?.trim();
  });
}

export function analyzeJobDescription(text: string): JdSections {
  const sections: Record<Section, string[]> = {
    required: [],
    preferred: [],
    duties: [],
    benefits: [],
    process: [],
    conditions: [],
    company: [],
    application: [],
    tech: [],
    other: [],
  };
  let section: Section = "other";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[#*•·\-\s]+/, "").trim();
    if (!line) continue;
    const heading = line.match(HEADING_RE);
    if (heading) {
      const name = heading[1]!;
      section = /우대|preferred|nice/i.test(name) ? "preferred" : /업무|일|responsibilities|you/i.test(name) ? "duties" : "required";
      if (heading[2]?.trim()) sections[section].push(heading[2].trim());
      continue;
    }
    const extra = EXTRA_RES.map(({ section: s, re }) => ({ s, m: re.exec(line) })).find((x) => x.m);
    if (extra) {
      section = extra.s;
      const inline = extra.m![1]?.trim();
      // 근무 조건은 "근무지: 서울"처럼 제목이 값의 이름이라 줄 전체를 둔다.
      if (inline) sections[section].push(section === "conditions" ? line : inline);
      continue;
    }
    if (/[:：]$/.test(line) || /^\[.+\]$/.test(line)) section = "other";
    sections[section].push(line);
  }
  return { ...sections, keywords: extractKeywords(text) };
}
