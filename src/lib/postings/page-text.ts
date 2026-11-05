/**
 * 공고 페이지 HTML → 모델에 줄 본문 텍스트(순수). 실행 코드·스타일·내비게이션·푸터는 버리고, JobPosting JSON-LD가 있으면
 * 읽기 쉬운 줄("직무: …", "회사: …", "마감: …", 설명)로 바꿔 맨 앞에 둔다(채용 플랫폼은 본문 대신 이 메타데이터에 공고를 싣는 경우가 많다).
 * 결과는 근거 검증(extract.ts)과 JD 원문 저장에 그대로 쓰므로 길이는 JD 상한(30,000자)에 맞춘다.
 * 구역 경계를 살린다: h1~h4·dt는 따로 한 줄이 되게 앞뒤로 줄을 나누고, 구역 제목처럼 보이는 strong·b도 따로 한 줄로 둔다.
 * Next 계열 사이트(예: 원티드)는 본문 대신 페이지 데이터(script#__NEXT_DATA__, application/json)에 공고를 싣기도 한다 —
 * 정해진 키 이름(main_tasks·requirements 등)만 찾아 "주요 업무" 같은 제목 줄과 값으로 바꿔 JSON-LD 뒤에 둔다
 * (경로는 사이트마다 달라 하드코딩하지 않는다. 실제 키 구조는 사이트별 실측이 필요한 가정이다).
 * CareerLoop(src/server/postingImport/analyze.ts postingPageText)에서 가져옴 — 원본은 JSON-LD를 JSON 문자열 그대로 넣었다.
 */
import { Parser } from "htmlparser2";
import { POSTING_LIMITS } from "@/lib/domain/postings";
import { isSectionHeadingLine } from "./jd-sections";
import { tagDepthGuard } from "@/lib/text/tag-depth";
import { collapseWhitespaceKeepLines } from "@/lib/text/whitespace";

const SKIP_TAGS = new Set(["script", "style", "svg", "noscript", "nav", "footer", "template", "iframe", "button"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "dt", "dd", "table", "ul", "ol"]);
/** 여는 자리에서도 줄을 나눌 태그(제목이 앞 문장에 붙지 않게). */
const HEADING_TAGS = new Set(["h1", "h2", "h3", "h4", "dt"]);
/** 구역 제목처럼 보이면 따로 한 줄로 둘 강조 태그. */
const EMPHASIS_TAGS = new Set(["strong", "b"]);

/** 페이지 데이터 JSON에서 읽을 키 → 제목. */
const DATA_KEYS: Record<string, string> = {
  intro: "회사 소개",
  main_tasks: "주요 업무",
  responsibilities: "주요 업무",
  requirements: "자격 요건",
  qualification: "자격 요건",
  qualifications: "자격 요건",
  preferred_points: "우대 사항",
  benefits: "복리후생",
  skill_tags: "기술 스택",
  hire_rounds: "채용 절차",
  description: "공고 설명",
};
export const DATA_SCAN_LIMITS = { depth: 12, nodes: 2000, chars: 15_000 } as const;

/** HTML 조각(JSON-LD description 등)을 줄바꿈을 살린 텍스트로. */
export function htmlFragmentText(html: string): string {
  const parts: string[] = [];
  // 열린 SKIP 태그 수. 스택 전체를 훑으면 닫지 않은 태그가 쌓인 페이지에서 O(n²)이 된다.
  let skipDepth = 0;
  const depth = tagDepthGuard(() => parser);
  const parser: Parser = new Parser(
    {
      onopentag(name) {
        depth.open();
        if (SKIP_TAGS.has(name)) skipDepth++;
        if (name === "br") parts.push("\n");
      },
      ontext(text) {
        if (skipDepth === 0) parts.push(text);
      },
      onclosetag(name) {
        depth.close();
        if (SKIP_TAGS.has(name)) skipDepth = Math.max(0, skipDepth - 1);
        if (BLOCK_TAGS.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  return tidy(parts.join(" "));
}

/** 줄 안 공백을 하나로, 줄바꿈 주변 공백·연속 줄바꿈을 줄바꿈 하나로(선형 — 긴 공백 덩어리로 ReDoS가 나지 않게). */
function tidy(text: string): string {
  return collapseWhitespaceKeepLines(text);
}

const str = (v: unknown): string => (typeof v === "string" ? v.trim() : typeof v === "number" ? String(v) : "");
const nameOf = (v: unknown): string => {
  if (Array.isArray(v)) return v.map(nameOf).filter(Boolean).join(", ");
  if (v && typeof v === "object") return str((v as Record<string, unknown>).name);
  return str(v);
};
function placeOf(v: unknown): string {
  if (Array.isArray(v)) return v.map(placeOf).filter(Boolean).join(" / ");
  if (!v || typeof v !== "object") return str(v);
  const obj = v as Record<string, unknown>;
  const addr = obj.address;
  if (addr && typeof addr === "object") {
    const a = addr as Record<string, unknown>;
    return [a.addressRegion, a.addressLocality, a.streetAddress, a.addressCountry].map(nameOf).filter(Boolean).join(" ");
  }
  return str(addr) || str(obj.name);
}

/** `<태그` 뒤 어딘가에 `>`가 있는가(`/<[a-z][\s\S]*>/i`와 같지만 `<a`가 많은 입력에서도 선형). */
function looksLikeHtml(text: string): boolean {
  const open = text.search(/<[a-z]/i);
  return open >= 0 && text.lastIndexOf(">") > open;
}

/** JobPosting JSON-LD 하나 → 줄 텍스트. */
function jobPostingLines(obj: Record<string, unknown>): string {
  const lines: string[] = [];
  const push = (label: string, value: string) => {
    if (value) lines.push(`${label}: ${value.replace(/\s+/g, " ").slice(0, 500)}`);
  };
  push("직무", str(obj.title));
  push("회사", nameOf(obj.hiringOrganization));
  push("근무지", placeOf(obj.jobLocation));
  push("고용 형태", [obj.employmentType].flat().map(str).filter(Boolean).join(", "));
  push("게시일", str(obj.datePosted));
  push("마감", str(obj.validThrough));
  const description = str(obj.description);
  if (description) lines.push(looksLikeHtml(description) ? htmlFragmentText(description) : tidy(description));
  return lines.join("\n");
}

/** 페이지 데이터 값(문자열·문자열 배열·이름 있는 객체 배열) → 줄 텍스트. */
function dataValueText(v: unknown): string {
  if (typeof v === "string") return looksLikeHtml(v) ? htmlFragmentText(v) : tidy(v);
  if (Array.isArray(v)) {
    return v
      .map((x) => {
        if (typeof x === "string" || typeof x === "number") return str(x);
        if (x && typeof x === "object") {
          const o = x as Record<string, unknown>;
          return str(o.title) || str(o.name) || str(o.text) || str(o.keyword) || str(o.value);
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * 페이지 데이터 JSON(__NEXT_DATA__ 등)에서 DATA_KEYS 키를 깊이·노드 수 상한 안에서 찾아 "제목\n값" 블록으로.
 * 같은 값은 한 번만, 전체는 DATA_SCAN_LIMITS.chars까지.
 */
export function pageDataLines(data: unknown): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  let nodes = 0;
  let chars = 0;
  const visit = (v: unknown, depth: number) => {
    if (depth > DATA_SCAN_LIMITS.depth || nodes >= DATA_SCAN_LIMITS.nodes || chars >= DATA_SCAN_LIMITS.chars) return;
    if (!v || typeof v !== "object") return;
    nodes++;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, depth + 1);
      return;
    }
    for (const [key, value] of Object.entries(v as Record<string, unknown>)) {
      if (nodes >= DATA_SCAN_LIMITS.nodes || chars >= DATA_SCAN_LIMITS.chars) return;
      const label = DATA_KEYS[key];
      if (label) {
        const text = dataValueText(value).trim();
        // 'description'은 흔한 키라(메타 설명 등) 충분히 긴 값만.
        if (text.length >= (key === "description" ? 40 : 2) && !seen.has(text)) {
          seen.add(text);
          const block = `${label}\n${text}`.slice(0, DATA_SCAN_LIMITS.chars - chars);
          out.push(block);
          chars += block.length;
          continue;
        }
      }
      visit(value, depth + 1);
    }
  };
  visit(data, 0);
  return out;
}

export function postingPageText(html: string, maxChars: number = POSTING_LIMITS.jdText): string {
  const parts: string[] = [];
  const jobs: string[] = [];
  const pageData: string[] = [];
  let skipDepth = 0;
  let jsonLd = "";
  let inJsonLd = false;
  let inData = false;
  /** 열린 강조 태그의 시작 위치(parts 인덱스). */
  const emphasis: number[] = [];
  const collectJob = (value: unknown) => {
    if (Array.isArray(value)) {
      value.forEach(collectJob);
      return;
    }
    if (!value || typeof value !== "object") return;
    const obj = value as Record<string, unknown>;
    if ([obj["@type"]].flat().includes("JobPosting")) jobs.push(jobPostingLines(obj));
    else if (obj["@graph"]) collectJob(obj["@graph"]);
  };
  const depth = tagDepthGuard(() => parser);
  const parser: Parser = new Parser(
    {
      onopentag(name, attrs) {
        depth.open();
        if (SKIP_TAGS.has(name)) skipDepth++;
        if (name === "script") {
          const type = (attrs.type ?? "").toLowerCase();
          inJsonLd = type === "application/ld+json";
          inData = !inJsonLd && (attrs.id === "__NEXT_DATA__" || type === "application/json");
          jsonLd = "";
        }
        if (name === "br") parts.push("\n");
        if (HEADING_TAGS.has(name)) parts.push("\n");
        if (EMPHASIS_TAGS.has(name)) emphasis.push(parts.length);
      },
      ontext(text) {
        if (inJsonLd || inData) jsonLd += text;
        else if (skipDepth === 0) parts.push(text);
      },
      onclosetag(name) {
        if (name === "script" && (inJsonLd || inData)) {
          try {
            const parsed: unknown = JSON.parse(jsonLd);
            if (inJsonLd) collectJob(parsed);
            else pageData.push(...pageDataLines(parsed));
          } catch {
            // 깨진 메타데이터는 근거로 쓰지 않는다.
          }
          inJsonLd = false;
          inData = false;
          jsonLd = "";
        }
        if (EMPHASIS_TAGS.has(name)) {
          const start = emphasis.pop();
          // 제목은 짧다 — 긴 강조 구간(닫지 않은 태그 등)은 보지 않는다(선형 유지).
          if (start !== undefined && parts.length - start <= 8) {
            const inner = parts.slice(start).join(" ").replace(/\s+/g, " ").trim();
            if (inner && isSectionHeadingLine(inner.replace(/[:：]\s*$/, ""))) {
              parts.splice(start, 0, "\n");
              parts.push("\n");
            }
          }
        }
        depth.close();
        if (SKIP_TAGS.has(name)) skipDepth = Math.max(0, skipDepth - 1);
        if (BLOCK_TAGS.has(name)) parts.push("\n");
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  const body = tidy(parts.join(" "));
  return [...jobs, ...pageData, body].filter(Boolean).join("\n\n").slice(0, maxChars).trim();
}
