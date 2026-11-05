/**
 * 공고 페이지 HTML → 모델에 줄 본문 텍스트(순수). 실행 코드·스타일·내비게이션·푸터는 버리고, JobPosting JSON-LD가 있으면
 * 읽기 쉬운 줄("직무: …", "회사: …", "마감: …", 설명)로 바꿔 맨 앞에 둔다(채용 플랫폼은 본문 대신 이 메타데이터에 공고를 싣는 경우가 많다).
 * 결과는 근거 검증(extract.ts)과 JD 원문 저장에 그대로 쓰므로 길이는 JD 상한(30,000자)에 맞춘다.
 * CareerLoop(src/server/postingImport/analyze.ts postingPageText)에서 가져옴 — 원본은 JSON-LD를 JSON 문자열 그대로 넣었다.
 */
import { Parser } from "htmlparser2";
import { POSTING_LIMITS } from "@/lib/domain/postings";
import { tagDepthGuard } from "@/lib/text/tag-depth";
import { collapseWhitespaceKeepLines } from "@/lib/text/whitespace";

const SKIP_TAGS = new Set(["script", "style", "svg", "noscript", "nav", "footer", "template", "iframe", "button"]);
const BLOCK_TAGS = new Set(["p", "div", "li", "br", "tr", "h1", "h2", "h3", "h4", "h5", "h6", "section", "article", "dt", "dd", "table", "ul", "ol"]);

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

export function postingPageText(html: string, maxChars: number = POSTING_LIMITS.jdText): string {
  const parts: string[] = [];
  const jobs: string[] = [];
  let skipDepth = 0;
  let jsonLd = "";
  let inJsonLd = false;
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
          inJsonLd = (attrs.type ?? "").toLowerCase() === "application/ld+json";
          jsonLd = "";
        }
        if (name === "br") parts.push("\n");
      },
      ontext(text) {
        if (inJsonLd) jsonLd += text;
        else if (skipDepth === 0) parts.push(text);
      },
      onclosetag(name) {
        if (name === "script" && inJsonLd) {
          try {
            collectJob(JSON.parse(jsonLd));
          } catch {
            // 깨진 메타데이터는 근거로 쓰지 않는다.
          }
          inJsonLd = false;
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
  return [...jobs, body].filter(Boolean).join("\n\n").slice(0, maxChars).trim();
}
