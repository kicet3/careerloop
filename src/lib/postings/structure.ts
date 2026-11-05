/**
 * 구조화 공고 만들기·쓰기(클라이언트·서버 공용, 순수).
 * - groundStructure: LLM 구역 출력 → 근거 검증한 PostingStructure. 리스트 항목은 본문에 그대로 있어야 남는다
 *   (요약만 모델 문장을 허용하되 본문에 없는 숫자가 있으면 버린다). 결과가 얇으면 정규식 결과로 빈 구역을 채운다.
 * - structureFromText: LLM 없이 제목 줄 기준으로 나눈 구조(source 'regex'). 직접 입력·기존 행의 즉석 구조화에 쓴다.
 * - composeJdText: 구조 → 제목이 붙은 구역 텍스트. URL 가져오기는 이것을 jdText로 저장해 진단·이력서·경력 대조
 *   (src/lib/graph/match.ts fromText의 '자격 요건'/'우대 사항' 제목 규칙)가 구역을 알아보게 한다. 원문은 sourceText에 따로 둔다.
 */
import {
  emptyStructureContent,
  POSTING_STRUCTURE_VERSION,
  PostingStructureSchema,
  STRUCTURE_LIMITS,
  STRUCTURE_SECTION_LABELS as L,
  type PostingSectionsLlm,
  type PostingStructure,
  type PostingStructureEdit,
  type StructureSource,
} from "@/lib/domain/posting-structure";
import { POSTING_LIMITS, type JobPosting } from "@/lib/domain/postings";
import { canonicalSkill, compactKey, extractKeywords } from "@/lib/skills/dictionary";
import { evidenceChecker, stripBullet, stripTrailingPunct, type EvidenceCheck } from "./evidence";
import { analyzeJobDescription, isSectionHeadingLine } from "./jd-sections";

// ---------------------------------------------------------------------------
// 공용
// ---------------------------------------------------------------------------

/** 입력 텍스트의 FNV-1a 32비트 해시(16진수). 공백 차이는 무시한다. 구조를 만든 원문이 바뀌었는지 판단한다. */
export function sourceHash(text: string): string {
  const s = text.normalize("NFC").replace(/\s+/g, " ").trim();
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** 업무·자격·우대 항목이 합쳐 3개 미만이면 얇은 결과(원문 구역을 거의 못 찾음). */
export function isThin(s: Pick<PostingStructureEdit, "duties" | "requirements" | "preferred">): boolean {
  return s.duties.length + s.requirements.length + s.preferred.length < 3;
}

/** 구조에 보이는 내용이 하나라도 있는가. */
export function hasStructureContent(s: PostingStructureEdit): boolean {
  return (
    !!s.summary ||
    !!s.company.industry ||
    !!s.company.size ||
    !!s.conditions.salary ||
    !!s.conditions.workHours ||
    [
      s.company.intro,
      s.duties,
      s.requirements,
      s.preferred,
      s.techStack,
      s.conditions.other,
      s.benefits,
      s.process,
      s.application.documents,
      s.application.method,
      s.notes,
    ].some((l) => l.length > 0)
  );
}

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n).trimEnd() : s);

/** 글머리 떼기·빈 줄·중복 제거·개수/길이 상한. seen을 주면 그 집합과도 중복을 뺀다(자격·우대 사이). */
function tidyList(items: readonly string[], max: number, opts: { check?: EvidenceCheck; seen?: Set<string> } = {}): string[] {
  const seen = opts.seen ?? new Set<string>();
  const out: string[] = [];
  for (const raw of items) {
    if (out.length >= max) break;
    let t = stripBullet(raw.replace(/\s+/g, " "));
    if (!t) continue;
    if (opts.check) {
      // 제목처럼 보이는 줄(구역 제목, ':'로 끝나는 줄)은 항목이 아니다.
      if (isSectionHeadingLine(stripTrailingPunct(t)) || /[:：]\s*$/.test(raw.trim())) continue;
      if (!opts.check(t)) {
        // 모델이 끝에 마침표 등을 붙였을 수 있다 — 떼고 다시 본다(저장도 뗀 문구로).
        t = stripTrailingPunct(t);
        if (!t || !opts.check(t)) continue;
      }
    }
    const key = compactKey(t);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(clip(t, STRUCTURE_LIMITS.item));
  }
  return out;
}

function techList(names: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = clip(raw.trim(), STRUCTURE_LIMITS.techItem);
    if (!name) continue;
    const label = canonicalSkill(name) ?? name;
    const key = compactKey(label);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(label);
    if (out.length >= STRUCTURE_LIMITS.tech) break;
  }
  return out;
}

function finalize(content: PostingStructureEdit, meta: { source: StructureSource; text: string; now: number }): PostingStructure {
  return PostingStructureSchema.parse({
    version: POSTING_STRUCTURE_VERSION,
    source: meta.source,
    ...content,
    jdComposed: false,
    sourceHash: sourceHash(meta.text),
    extractedAt: Math.trunc(meta.now),
  });
}

// ---------------------------------------------------------------------------
// 정규식 대체 경로
// ---------------------------------------------------------------------------

const SALARY_RE = /^(?:연봉|급여|보수|임금|salary|compensation)(?:\s*(?:조건|수준))?\s*[:：]\s*(.+)$/i;
const HOURS_RE = /^(?:근무\s*시간|업무\s*시간|working\s*hours)\s*[:：]\s*(.+)$/i;
const DOCUMENT_RE = /서류|이력서|경력\s*기술서|자기\s*소개서|자소서|포트폴리오|증명서|사본|resume|cv\b|portfolio|cover letter/i;

/**
 * 제목 줄 기준 구역 나누기(LLM 없음). 요약·업종·규모는 비운다.
 * 구역 제목을 하나도 못 찾았으면 빈 구조를 돌려준다 — 본문 전체를 '기타' 한 칸에 잘라 넣으면 화면이 JD 일부를
 * 말없이 빠뜨린다. 빈 구조면 공고 상세가 '구역 제목을 찾지 못했습니다' 안내와 원문을 보여 준다.
 */
export function structureContentFromText(text: string): PostingStructureEdit {
  const s = analyzeJobDescription(text);
  const content = emptyStructureContent();
  const sectionedAny = [s.required, s.preferred, s.duties, s.benefits, s.process, s.conditions, s.company, s.application, s.tech].some(
    (l) => l.length > 0,
  );
  if (!sectionedAny) return content;
  const reqSeen = new Set<string>();
  content.requirements = tidyList(s.required, STRUCTURE_LIMITS.list, { seen: reqSeen });
  content.preferred = tidyList(s.preferred, STRUCTURE_LIMITS.list, { seen: reqSeen });
  content.duties = tidyList(s.duties, STRUCTURE_LIMITS.list);
  content.benefits = tidyList(s.benefits, STRUCTURE_LIMITS.list);
  content.process = tidyList(s.process, STRUCTURE_LIMITS.small);
  content.company.intro = tidyList(s.company, STRUCTURE_LIMITS.companyIntro);
  const other: string[] = [];
  for (const line of s.conditions) {
    const salary = SALARY_RE.exec(line);
    const hours = HOURS_RE.exec(line);
    if (salary && !content.conditions.salary) content.conditions.salary = clip(salary[1]!.trim(), STRUCTURE_LIMITS.short);
    else if (hours && !content.conditions.workHours) content.conditions.workHours = clip(hours[1]!.trim(), STRUCTURE_LIMITS.short);
    else other.push(line);
  }
  content.conditions.other = tidyList(other, STRUCTURE_LIMITS.small);
  content.application.documents = tidyList(
    s.application.filter((l) => DOCUMENT_RE.test(l)),
    STRUCTURE_LIMITS.small,
  );
  content.application.method = tidyList(
    s.application.filter((l) => !DOCUMENT_RE.test(l)),
    STRUCTURE_LIMITS.applyMethod,
  );
  content.notes = tidyList(s.other, STRUCTURE_LIMITS.notes);
  // '기술 스택' 구역의 이름(쉼표 등으로 나눔, 문장처럼 긴 줄 제외) + 업무·자격·우대 문장에서 사전으로 찾은 키워드.
  const listed = s.tech.flatMap((l) => l.split(/[,，、/|]/)).map((t) => stripBullet(t.trim())).filter((t) => t && t.length <= 40);
  const sectioned = [...s.required, ...s.preferred, ...s.duties];
  content.techStack = techList([...listed, ...extractKeywords(...sectioned, ...s.tech)]);
  return content;
}

/** 정규식 구조(source 'regex'). */
export function structureFromText(text: string, now: number = Date.now()): PostingStructure {
  return finalize(structureContentFromText(text), { source: "regex", text, now });
}

// ---------------------------------------------------------------------------
// LLM 출력 근거 검증
// ---------------------------------------------------------------------------

/**
 * LLM 구역 출력 → PostingStructure(source 'llm'). pageText는 모델에 준 본문(근거 검사 대상).
 * 리스트·짧은 값은 본문에 없으면 버리고, 요약은 본문에 없는 숫자가 있으면 비운다. 얇으면 정규식 결과로 빈 구역을 채운다.
 */
export function groundStructure(llm: PostingSectionsLlm, pageText: string, now: number = Date.now()): PostingStructure {
  const check = evidenceChecker(pageText);
  const checkCi = evidenceChecker(pageText, { ignoreCase: true });
  const shortValue = (v: string) => {
    const t = stripBullet(v.replace(/\s+/g, " "));
    if (t && check(t)) return clip(t, STRUCTURE_LIMITS.short);
    const bare = stripTrailingPunct(t);
    return bare && check(bare) ? clip(bare, STRUCTURE_LIMITS.short) : "";
  };
  const content = emptyStructureContent();
  const reqSeen = new Set<string>();
  content.requirements = tidyList(llm.requirements, STRUCTURE_LIMITS.list, { check, seen: reqSeen });
  content.preferred = tidyList(llm.preferred, STRUCTURE_LIMITS.list, { check, seen: reqSeen });
  content.duties = tidyList(llm.duties, STRUCTURE_LIMITS.list, { check });
  content.benefits = tidyList(llm.benefits, STRUCTURE_LIMITS.list, { check });
  content.process = tidyList(llm.process, STRUCTURE_LIMITS.small, { check });
  content.notes = tidyList(llm.notes, STRUCTURE_LIMITS.notes, { check });
  content.company = {
    industry: shortValue(llm.companyIndustry),
    size: shortValue(llm.companySize),
    intro: tidyList(llm.companyIntro, STRUCTURE_LIMITS.companyIntro, { check }),
  };
  content.conditions = {
    salary: shortValue(llm.salary),
    workHours: shortValue(llm.workHours),
    other: tidyList(llm.conditionsOther, STRUCTURE_LIMITS.small, { check }),
  };
  content.application = {
    documents: tidyList(llm.documents, STRUCTURE_LIMITS.small, { check }),
    method: tidyList(llm.applyMethod, STRUCTURE_LIMITS.applyMethod, { check }),
  };

  const summary = clip(llm.summary.replace(/\s+/g, " ").trim(), STRUCTURE_LIMITS.summary);
  const digits = summary.match(/\d+/g) ?? [];
  const flatPage = pageText.normalize("NFC");
  content.summary = digits.every((d) => flatPage.includes(d)) ? summary : "";

  // 기술: 본문에 있는 이름만(대소문자 무시) 정식 명칭으로 + 업무·자격·우대 문장에서 사전으로 찾은 키워드.
  // 페이지 본문 전체는 메뉴·푸터 잡음이 섞이므로 키워드를 뽑는 대상으로 쓰지 않는다.
  const grounded = llm.techStack.map((t) => t.trim()).filter((t) => t && checkCi(t));
  content.techStack = techList([...grounded, ...extractKeywords(...content.requirements, ...content.preferred, ...content.duties, ...grounded)]);

  if (isThin(content)) {
    const fb = structureContentFromText(pageText);
    const fill = <T>(cur: T[], alt: T[]) => (cur.length > 0 ? cur : alt);
    content.duties = fill(content.duties, fb.duties);
    const seen = new Set(content.requirements.map(compactKey));
    content.requirements = fill(content.requirements, fb.requirements);
    for (const r of content.requirements) seen.add(compactKey(r));
    content.preferred = fill(
      content.preferred,
      fb.preferred.filter((p) => !seen.has(compactKey(p))),
    );
    content.benefits = fill(content.benefits, fb.benefits);
    content.process = fill(content.process, fb.process);
    content.company.intro = fill(content.company.intro, fb.company.intro);
    content.conditions.other = fill(content.conditions.other, fb.conditions.other);
    content.conditions.salary ||= fb.conditions.salary;
    content.conditions.workHours ||= fb.conditions.workHours;
    content.application.documents = fill(content.application.documents, fb.application.documents);
    content.application.method = fill(content.application.method, fb.application.method);
    // 기타(notes)·기술은 채우지 않는다 — 페이지 전체의 제목 밖 줄(메뉴·푸터)이 섞인다.
  }
  return finalize(content, { source: "llm", text: pageText, now });
}

// ---------------------------------------------------------------------------
// jdText 조합
// ---------------------------------------------------------------------------

/**
 * 구조 → 제목 붙은 구역 텍스트(≤30,000자). 순서는 그래프 대조(fromText)의 제목 규칙을 고려했다:
 * 주요 업무(제목 이전이라 '언급') → 자격 요건(must) → 우대 사항(nice) → 기술 스택 → 근무 조건 → 복리후생 → 채용 절차 →
 * 제출 서류·지원 방법 → 회사 소개 → 기타.
 */
export function composeJdText(s: PostingStructureEdit): string {
  const out: string[] = [];
  const block = (title: string, lines: string[]) => {
    if (lines.length === 0) return;
    if (out.length) out.push("");
    out.push(title, ...lines);
  };
  const bullets = (items: string[]) => items.map((i) => `- ${i}`);
  if (s.summary) out.push(`[${L.summary}] ${s.summary}`);
  block(L.duties, bullets(s.duties));
  block(L.requirements, bullets(s.requirements));
  block(L.preferred, bullets(s.preferred));
  if (s.techStack.length) {
    if (out.length) out.push("");
    out.push(`${L.techStack}: ${s.techStack.join(", ")}`);
  }
  block(L.conditions, [
    ...(s.conditions.salary ? [`- 연봉: ${s.conditions.salary}`] : []),
    ...(s.conditions.workHours ? [`- 근무시간: ${s.conditions.workHours}`] : []),
    ...bullets(s.conditions.other),
  ]);
  block(L.benefits, bullets(s.benefits));
  block(
    L.process,
    s.process.map((p, i) => `${i + 1}. ${p}`),
  );
  block(L.application, [...s.application.documents.map((d) => `- 제출 서류: ${d}`), ...s.application.method.map((m) => `- 지원 방법: ${m}`)]);
  block(L.company, [
    ...(s.company.industry ? [`- 업종: ${s.company.industry}`] : []),
    ...(s.company.size ? [`- 규모: ${s.company.size}`] : []),
    ...bullets(s.company.intro),
  ]);
  block(L.notes, bullets(s.notes));
  return out.join("\n").trim().slice(0, POSTING_LIMITS.jdText);
}

/** 구조를 만들(다시 만들) 입력 텍스트: jdText가 구조로 조합된 상태면 원문(sourceText), 아니면 jdText. */
export function structureInputText(p: Pick<JobPosting, "jdText" | "sourceText" | "structured">): string {
  return p.sourceText && (p.structured?.jdComposed ?? true) ? p.sourceText : p.jdText;
}

/** 구조를 만든 뒤 원문(입력 텍스트)이 바뀌었는가. 정규식 구조는 저장 때마다 다시 만들므로 해당 없음. */
export function isStructureStale(p: Pick<JobPosting, "jdText" | "sourceText" | "structured">): boolean {
  if (!p.structured || p.structured.source === "regex") return false;
  const input = structureInputText(p);
  return !!input.trim() && sourceHash(input) !== p.structured.sourceHash;
}

/**
 * 진단·이력서 프롬프트에 넣을 JD. AI·직접 편집 구조가 충분하고 최신이면 구역 텍스트, 아니면 jdText 그대로
 * (정규식 구조는 jdText를 제목으로 나눈 것뿐이라 원문이 더 온전하다). 구조를 만든 뒤 사용자가 jdText를 고쳤으면
 * (jdComposed=false인데 해시가 jdText와 다름) 낡은 구조 대신 고친 jdText를 쓴다.
 */
export function postingJdForPrompt(p: Pick<JobPosting, "jdText" | "structured">): string {
  const s = p.structured;
  if (!s || s.source === "regex" || s.jdComposed || isThin(s)) return p.jdText;
  if (p.jdText.trim() && sourceHash(p.jdText) !== s.sourceHash) return p.jdText;
  return composeJdText(s) || p.jdText;
}
