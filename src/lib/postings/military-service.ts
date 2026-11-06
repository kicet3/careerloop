/**
 * 병역특례(전문연구요원·산업기능요원) 가능 여부 판정(결정적, 순수 — 클라이언트·서버 공용). LLM을 쓰지 않는다.
 * 입력은 공개 필드만: 직무명·공고 본문(jdText)·구역(structured). 공용 공고의 가져온 원문(sourceText)은 넣지 않는다.
 *
 * 방법: 본문을 문장(줄·마침표) → 절(쉼표·세미콜론·'~하나/~지만/~며' 같은 연결어)로 나누고, 절마다 병역 관련 언급
 * (전문연구요원·전문연, 산업기능요원·산기요, 병역특례·병특·대체복무·병역지정업체, 보충역·현역)을 찾는다.
 * 언급마다 그 뒤(다음 언급 전까지, 없으면 절 끝까지)의 표현으로 판정한다 — 부정(불가·해당 없음·제외·X…) > 보류(여부·문의·협의…)
 * > 긍정(가능·편입·전직·우대·채용·TO…) > 완료(복무 완료·만료 — 판정하지 않음). 표현이 없으면 앞 표현을 보고, 그래도 없으면
 * 바로 다음 절이 다른 언급이거나 짧은 표현('모두 불가')일 때 그 판정을 물려받고, 아니면 언급만으로 긍정으로 본다.
 * 언급 없는 괄호(예: '(경력 제한 없음)')는 판정에서 뺀다. '군필 또는 면제자'처럼 병역특례 언급이 없으면 태그가 없다.
 * 보충역·현역은 같은 문장에 산업기능요원·병역특례 언급이 있을 때만 산업기능요원의 복무 구분으로 붙인다.
 * 여러 곳에서 엇갈리면 긍정이 하나라도 있는 종류를 태그한다(부정은 그 종류의 긍정이 없을 때만 의미가 있다).
 */
import type { PostingStructure } from "@/lib/domain/posting-structure";
import { normalizeMilitaryTags, type MilitaryServiceTag } from "@/lib/domain/military-service";

/** 판정 규칙이 바뀌면 올린다 — 저장된 행(shared_postings.military_service_version)이 낮으면 다시 계산한다. */
export const MILITARY_SERVICE_DETECTOR_VERSION = 2;

type Kind = "expert" | "industrial" | "general" | "supplementary" | "active";
type Verdict = "pos" | "neg" | "unsure" | "done" | null;

const MENTIONS: [Kind, RegExp][] = [
  ["expert", /전문\s*연구\s*요원|전문연(?!구)/g],
  ["industrial", /산업\s*기능\s*요원|산기요/g],
  ["general", /병역\s*특례|병특|대체\s*복무|병역\s*지정\s*업체/g],
  // '현역 군필자'·'보충역 전역자'처럼 본인의 병역 이력을 말하는 표현은 복무 구분이 아니다.
  ["supplementary", /보충역(?!\s*(?:군필|필|전역|제대|출신|만기))/g],
  ["active", /현역(?!\s*(?:군필|필|전역|제대|출신|만기))/g],
];

const NEG =
  /불가|안\s*됩니다|안\s*됨|안\s*돼|않(?:습니다|음|는|아요)|아님|아닙니다|아니에요|없음|없습니다|없는|없어|해당\s*없|미해당|비\s*해당|미\s*적용|아닌|안\s*함|안\s*합니다|안\s*해요|소진|마감|(?<![가-힣])무(?![가-힣])|제외|미지정|미운영|미선정|미보유|어렵|불허|불인정|비대상|[✕×✗]|(?<![A-Za-z0-9])[Xx](?![A-Za-z0-9])/;
const UNSURE = /여부|문의|협의|추후|확인\s*필요|미정|검토|상담|신청\s*중|진행\s*중/;
const POS =
  /가능|환영|우대|모집|채용|지원|편입|전직|지정|선정|보유|있음|있습니다|운영|대상|해당|(?<![A-Za-z])TO(?![A-Za-z])|(?<![A-Za-z0-9])[Oo](?![A-Za-z0-9])|[○◯]/;
const DONE = /완료|만료|소집\s*해제|마친|마치신|필한|필자/;

function cueOf(text: string): Verdict {
  if (NEG.test(text)) return "neg";
  if (UNSURE.test(text)) return "unsure";
  if (POS.test(text)) return "pos";
  if (DONE.test(text)) return "done";
  return null;
}

const ANY_MENTION = new RegExp(MENTIONS.map(([, re]) => re.source).join("|"));

interface Mention {
  kind: Kind;
  start: number;
  end: number;
}

function mentionsIn(clause: string): Mention[] {
  const out: Mention[] = [];
  for (const [kind, re] of MENTIONS) {
    re.lastIndex = 0;
    for (const m of clause.matchAll(re)) out.push({ kind, start: m.index, end: m.index + m[0].length });
  }
  return out.sort((a, b) => a.start - b.start);
}

/** 판정에 쓸 절 텍스트: 병역 언급이 없는 괄호 안은 지우고, '가능 여부: 불가' 같은 질문-답 꼴은 답만 남긴다. */
function prepareClause(raw: string): string {
  return raw
    .replace(/[([{（［【]([^()[\]{}（）［］【】]*)[)\]}）］】]/g, (whole, inner: string) => (ANY_MENTION.test(inner) ? ` ${inner} ` : " "))
    .replace(/(?:가능\s*)?여부\s*[:：=\-–]\s*/g, " : ");
}

/** 문장 → 절. 쉼표·세미콜론·'~하나 / ~지만 / ~으나 / ~이나 / ~며 / ~하고 / ~고' 뒤에서 자른다. */
function clausesOf(sentence: string): string[] {
  return sentence
    .split(/[,，;；]|(?<=하나|지만|으나|이나|며|하고)\s+/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/** 본문 → 문장(줄바꿈·마침표·느낌표·물음표). */
function sentencesOf(text: string): string[] {
  return text
    .split(/\n+|(?<=[.!?。])\s+|[•▪◦●■□◆◇]\s*/)
    .map((s) => s.trim())
    .filter(Boolean);
}

interface ClauseResult {
  mentions: (Mention & { verdict: Verdict })[];
  /** 절 전체에서 처음 보이는 표현(물려받기용). */
  cue: Verdict;
  short: boolean;
  text: string;
}

/** 언급 없는 절이 앞 절 언급의 긍정을 이어 받는 표현(전직·편입 가능). */
const TRANSFER = /(?:전직|편입)[^]*가능/;

function judgeClause(raw: string): ClauseResult {
  const clause = prepareClause(raw);
  const ms = mentionsIn(clause);
  const results = ms.map((m, i) => {
    // 다음 언급 전까지 → 절 끝까지 → 앞쪽 순서로 표현을 찾는다.
    const nextStart = ms.slice(i + 1).find((n) => n.start >= m.end)?.start ?? clause.length;
    const verdict = cueOf(clause.slice(m.end, nextStart)) ?? cueOf(clause.slice(m.end)) ?? cueOf(clause.slice(0, m.start));
    return { ...m, verdict };
  });
  const stripped = clause.replace(/\s+/g, "");
  return { mentions: results, cue: cueOf(clause), short: stripped.length <= 12, text: clause };
}

/** 한 문장의 언급별 판정(물려받기 포함). */
function judgeSentence(sentence: string): { kind: Kind; verdict: Verdict }[] {
  const clauses = clausesOf(sentence).map(judgeClause);
  const resolved: Verdict[] = new Array(clauses.length).fill(null);
  // 오른쪽부터: 표현 없는 절은 바로 다음 절(언급이 있거나 짧은 표현)의 판정을 물려받는다.
  for (let i = clauses.length - 1; i >= 0; i--) {
    const c = clauses[i];
    const next = clauses[i + 1];
    const inherited = next && (next.mentions.length > 0 || next.short) ? resolved[i + 1] : null;
    resolved[i] = c.cue ?? inherited;
  }
  const out: { kind: Kind; verdict: Verdict }[] = [];
  let lastKinds: Kind[] = [];
  clauses.forEach((c, i) => {
    for (const m of c.mentions) {
      // 절 안에 표현이 없으면 물려받은 판정, 그것도 없으면 언급만으로 긍정.
      const verdict = m.verdict ?? resolved[i] ?? "pos";
      out.push({ kind: m.kind, verdict });
    }
    const special = c.mentions.map((m) => m.kind).filter((k) => k === "expert" || k === "industrial" || k === "general");
    if (special.length > 0) lastKinds = special;
    else if (c.mentions.length === 0 && c.cue === "pos" && TRANSFER.test(c.text) && lastKinds.length > 0) {
      // '산업기능요원 신규 편입 불가, 전직만 가능': 언급 없는 뒤 절의 '전직·편입 … 가능'은 앞 절 언급의 긍정이다.
      for (const kind of lastKinds) out.push({ kind, verdict: "pos" });
    }
  });
  return out;
}

/** 텍스트(여러 줄) → 병역특례 태그. */
export function detectMilitaryService(text: string): MilitaryServiceTag[] {
  if (!text || !ANY_MENTION.test(text)) return [];
  const pos = new Set<Kind>();
  const duty = new Set<"supplementary" | "active">();
  for (const sentence of sentencesOf(text)) {
    if (!ANY_MENTION.test(sentence)) continue;
    const judged = judgeSentence(sentence);
    const dutyContext = judged.some((j) => j.kind === "industrial" || j.kind === "general");
    for (const j of judged) {
      if (j.verdict !== "pos") continue;
      if (j.kind === "supplementary" || j.kind === "active") {
        if (dutyContext) duty.add(j.kind);
      } else pos.add(j.kind);
    }
  }
  const tags: MilitaryServiceTag[] = [];
  if (pos.has("expert")) tags.push("expert");
  if (pos.has("industrial")) {
    tags.push("industrial");
    if (duty.has("supplementary")) tags.push("industrial_supplementary");
    if (duty.has("active")) tags.push("industrial_active");
  } else if (pos.has("general") && duty.size > 0) {
    // '병역특례(보충역) 가능'처럼 복무 구분이 있으면 산업기능요원으로 본다(전문연구요원은 현역·보충역으로 나누지 않는다).
    tags.push("industrial", ...[...duty].map((d) => (d === "supplementary" ? "industrial_supplementary" : "industrial_active") as MilitaryServiceTag));
  }
  if (tags.length === 0 && pos.has("general")) tags.push("general");
  return normalizeMilitaryTags(tags);
}

/** 판정에 넣는 공개 필드. */
export interface MilitaryServiceSource {
  roleTitle?: string | null;
  jdText?: string | null;
  structured?: PostingStructure | null;
}

/** 구조의 글자 필드(메타 정보 제외)를 줄로 모은다. */
function structureLines(s: PostingStructure): string[] {
  return [
    s.company.industry,
    s.company.size,
    ...s.company.intro,
    s.summary,
    ...s.duties,
    ...s.requirements,
    ...s.preferred,
    s.conditions.salary,
    s.conditions.workHours,
    ...s.conditions.other,
    ...s.benefits,
    ...s.process,
    ...s.application.documents,
    ...s.application.method,
    ...s.notes,
  ].filter((v) => !!v && v.trim().length > 0);
}

/** 공개 필드(직무명·JD·구역)로 판정. 가져온 원문(sourceText)은 받지 않는다. */
export function detectPostingMilitaryService(src: MilitaryServiceSource): MilitaryServiceTag[] {
  const parts = [src.roleTitle ?? "", src.jdText ?? "", ...(src.structured ? structureLines(src.structured) : [])];
  return detectMilitaryService(parts.filter(Boolean).join("\n"));
}

/** 공용 공고에 저장할 병역특례 컬럼(공개 필드를 쓸 때마다 함께 쓴다). */
export function militaryServiceColumns(src: MilitaryServiceSource): { militaryService: MilitaryServiceTag[]; militaryServiceVersion: number } {
  return { militaryService: detectPostingMilitaryService(src), militaryServiceVersion: MILITARY_SERVICE_DETECTOR_VERSION };
}
