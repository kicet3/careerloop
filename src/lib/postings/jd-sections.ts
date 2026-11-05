/**
 * JD 원문을 필수 요건·우대 사항·주요 업무·기타로 나눈다(클라이언트·서버 공용, 순수). 공고 상세의 '섹션 보기'에 쓴다.
 * CareerLoop(src/lib/writing.ts analyzeJobDescription)에서 가져옴. 기술 키워드는 src/lib/skills/dictionary.ts 사전으로 뽑는다.
 */
import { extractKeywords } from "@/lib/skills/dictionary";

export interface JdSections {
  required: string[];
  preferred: string[];
  duties: string[];
  other: string[];
  /** 사전에 있는 기술·역량 키워드(정식 명칭). */
  keywords: string[];
}

const HEADING_RE =
  /^[[【<]?(자격\s*요건|필수\s*(?:요건|사항|조건|역량)?|지원\s*자격|우대\s*(?:사항|조건|요건)?|담당\s*업무|주요\s*업무|업무\s*내용|하는\s*일|이런\s*일을\s*해요|requirements|required qualifications|minimum qualifications|preferred qualifications|nice to have|responsibilities|what you(?:'|’)ll do)[\]】>]?(?:\s*[:：]\s*(.*))?$/i;
/** 알 수 없는 다른 제목: 이후 내용은 앞 섹션(특히 필수 요건)에 섞지 않는다. */
const OTHER_HEADING_RE =
  /^(복리\s*후생|전형\s*절차|채용\s*절차|근무\s*조건|지원\s*방법|접수\s*방법|혜택|회사\s*소개|기타\s*사항|benefits|how to apply|about us)$/i;

export function analyzeJobDescription(text: string): JdSections {
  const sections: Record<"required" | "preferred" | "duties" | "other", string[]> = { required: [], preferred: [], duties: [], other: [] };
  let section: keyof typeof sections = "other";
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim().replace(/^[#*•·\-\s]+/, "").trim();
    if (!line) continue;
    const heading = line.match(HEADING_RE);
    if (heading) {
      const name = heading[1]!;
      section = /우대|preferred|nice/i.test(name) ? "preferred" : /업무|일|responsibilities|you/i.test(name) ? "duties" : "required";
      if (heading[2]?.trim()) sections[section].push(heading[2].trim());
    } else {
      if (/[:：]$/.test(line) || /^\[.+\]$/.test(line) || OTHER_HEADING_RE.test(line)) section = "other";
      sections[section].push(line);
    }
  }
  return { ...sections, keywords: extractKeywords(text) };
}
