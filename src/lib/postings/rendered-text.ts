/**
 * 브라우저로 열어 읽기(render.ts)의 순수 부분: 정적 HTML이 자바스크립트로 그려지는 빈 껍데기인지 판단하고(needsRendering),
 * 브라우저가 그린 페이지(보이는 본문 innerText + 페이지가 불러온 같은 사이트 JSON 응답 + 제목·공유 메타)를
 * 모델에 줄 본문 텍스트로 합친다(renderedPageText). 결과는 정적 경로와 같이 근거 검증(extract.ts)과 원문 저장에 그대로 쓴다.
 */
import { Parser } from "htmlparser2";
import { POSTING_LIMITS } from "@/lib/domain/postings";
import { collapseWhitespaceKeepLines } from "@/lib/text/whitespace";
import { isBotChallengeResponse, looksLikeChallengeText } from "./fetch";
import { htmlFragmentText } from "./page-text";

/** 정적 본문이 이보다 짧고 자바스크립트 렌더링 표식이 있으면 브라우저로 연다. */
export const THIN_PAGE_TEXT_CHARS = 1500;
/** 이보다 짧으면 표식이 없어도 브라우저로 연다(extract.ts MIN_PAGE_TEXT_CHARS와 같다 — 그대로는 분석할 수 없는 본문). */
export const EMPTY_PAGE_TEXT_CHARS = 150;

/** 클라이언트 렌더링 표식(정적 HTML에 남는 템플릿·빈 앱 루트·자바스크립트 필요 안내). */
const CLIENT_RENDER_MARKERS: readonly RegExp[] = [
  /\sdata-bind\s*=/i, // Knockout
  /\sng-(?:app|controller|bind|repeat|view)\b/i, // AngularJS
  /\sv-(?:if|for|html|text|cloak|show)\s*=/i, // Vue 템플릿
  /<(?:div|main|section)\s[^>]*id=["'](?:root|app|__next|__nuxt|svelte|main-app)["'][^>]*>\s*<\/(?:div|main|section)>/i, // 빈 앱 루트
  /<app-root\b[^>]*>\s*<\/app-root>/i, // Angular
  /<noscript[^>]*>[^<]{0,300}(?:enable javascript|javascript (?:is )?(?:required|disabled)|자바스크립트|javascript(?:를|을)\s*(?:활성|사용|허용))/i,
];
/** 본문 텍스트에 남은 '불러오는 중' 표시·치환되지 않은 템플릿. */
const LOADING_TEXT = /\bloading\s*\.\.\.|불러오는\s*중|로딩\s*중|\{\{\s*[\w$.()]+\s*\}\}/i;
const JSON_LD_JOB_POSTING = /"@type"\s*:\s*\[?\s*"JobPosting"/;

/**
 * 정적 HTML만으로는 공고 본문이 없어 브라우저로 열어 봐야 하는지(순수).
 * - JobPosting JSON-LD가 있으면 아니다(메타데이터에 공고가 있다).
 * - 본문이 EMPTY_PAGE_TEXT_CHARS 미만이면 그렇다.
 * - 본문이 THIN_PAGE_TEXT_CHARS 미만이고 클라이언트 렌더링 표식(Knockout·Angular·Vue 템플릿, 빈 앱 루트, 자바스크립트 필요 안내,
 *   '불러오는 중' 문구)이 있으면 그렇다.
 */
export function needsRendering(html: string, pageText: string): boolean {
  if (JSON_LD_JOB_POSTING.test(html)) return false;
  const length = pageText.trim().length;
  if (length < EMPTY_PAGE_TEXT_CHARS) return true;
  if (length >= THIN_PAGE_TEXT_CHARS) return false;
  return CLIENT_RENDER_MARKERS.some((m) => m.test(html)) || LOADING_TEXT.test(pageText);
}

export interface PageMeta {
  title: string;
  ogTitle: string;
  ogDescription: string;
  description: string;
}

/** HTML의 <title>·og:title·og:description·description(순수). </head>·<body> 뒤는 보지 않고, 앞 256KB만 읽는다. */
export function pageMeta(html: string): PageMeta {
  const meta: PageMeta = { title: "", ogTitle: "", ogDescription: "", description: "" };
  let inTitle = false;
  let title = "";
  let done = false;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (done) return;
        if (name === "body") {
          done = true;
          return;
        }
        if (name === "title" && !meta.title) inTitle = true;
        if (name === "meta") {
          const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
          const content = (attrs.content ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
          if (!content) return;
          if (key === "og:title" && !meta.ogTitle) meta.ogTitle = content;
          else if (key === "og:description" && !meta.ogDescription) meta.ogDescription = content;
          else if (key === "description" && !meta.description) meta.description = content;
        }
      },
      ontext(text) {
        if (inTitle) title += text;
      },
      onclosetag(name) {
        if (name === "title" && inTitle) {
          inTitle = false;
          meta.title = title.replace(/\s+/g, " ").trim().slice(0, 300);
        }
        if (name === "head") done = true;
      },
    },
    { decodeEntities: true },
  );
  parser.write(html.slice(0, 256 * 1024));
  parser.end();
  return meta;
}

/** 페이지가 불러온 JSON에서 읽을 상한. */
export const JSON_EVIDENCE_LIMITS = { depth: 12, nodes: 3000, chars: 12_000, valueChars: 4000 } as const;

const HANGUL = /[가-힣]/;
const DATE_LIKE = /\d{4}\s*[-./년]\s*\d{1,2}\s*[-./월]\s*\d{1,2}/;
const URL_LIKE = /^(?:https?:)?\/\/|^\/[\w\-./]*$|^[\w\-./]+\.(?:png|jpe?g|gif|webp|svg|pdf)$/i;

function looksLikeHtml(text: string): boolean {
  const open = text.search(/<[a-z]/i);
  return open >= 0 && text.lastIndexOf(">") > open;
}

/** 엔티티로 감싼 마크업의 기본 엔티티만 푼다(&amp;는 마지막 — 안쪽 엔티티는 htmlFragmentText가 푼다). */
const unescapeMarkup = (s: string) =>
  s.replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"').replace(/&#0*39;|&apos;/gi, "'").replace(/&amp;/gi, "&");

/** JSON 문자열 값 → 텍스트. HTML이면 줄바꿈을 살린 텍스트로, 엔티티로 한 번 더 감싼 HTML(&lt;p&gt;…)이면 풀어서 다시 읽는다. */
function valueText(raw: string): string {
  if (/&lt;\/?[a-z]/i.test(raw) && !looksLikeHtml(raw)) return htmlFragmentText(unescapeMarkup(raw));
  return looksLikeHtml(raw) ? htmlFragmentText(raw) : collapseWhitespaceKeepLines(raw);
}

/** 날짜 키(endDate·reg_dt 등)의 붙여 쓴 날짜(20261130, 202611302359) → "2026-11-30"(·" 23:59"). 아니면 null. */
const DATE_KEY = /date|_dt$|Dt$|^dt$|deadline|마감|기간/i;
export function compactDateText(key: string, value: string | number): string | null {
  if (!DATE_KEY.test(key)) return null;
  const m = /^(20\d{2})(0[1-9]|1[0-2])(0[1-9]|[12]\d|3[01])(?:([01]\d|2[0-3])([0-5]\d)(?:[0-5]\d)?)?$/.exec(String(value).trim());
  if (!m) return null;
  return `${m[1]}-${m[2]}-${m[3]}${m[4] ? ` ${m[4]}:${m[5]}` : ""}`;
}

/** 화면에 이미 보이는 값인지: 15자 이상 값이 그대로 있거나, 8자 이상인 줄이 모두 화면에 있다(공백 차이는 무시). */
function shownOnPage(text: string, visible: string): boolean {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length >= 15 && visible.includes(flat)) return true;
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\s+/g, " ").trim())
    .filter((l) => l.length >= 8);
  return lines.length > 0 && flat.length >= 15 && lines.every((l) => visible.includes(l));
}

/** 근거로 쓸 만한 문자열 값인지: 한글이 있거나, 날짜이거나, 띄어쓴 낱말이 있는 문장(코드·주소·식별자는 뺀다). */
function readableValue(value: string): boolean {
  if (value.length < 2 || URL_LIKE.test(value)) return false;
  if (HANGUL.test(value) || DATE_LIKE.test(value)) return true;
  return /[a-z]{2,}\s+[a-z]{2,}/i.test(value);
}

/**
 * 페이지가 불러온 JSON 응답들 → "키: 값" 줄(순수). 화면에 이미 보이는 긴 값(15자 이상이 본문에 그대로 있음)과 같은 값은 한 번만.
 * HTML 값은 줄바꿈을 살린 텍스트로 바꾸고, 날짜 키의 붙여 쓴 날짜(20261130)는 2026-11-30으로 읽는다. 깊이·노드 수·글자 수(JSON_EVIDENCE_LIMITS) 안에서만 읽는다.
 */
export function jsonEvidenceLines(responses: readonly unknown[], visibleText: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visible = visibleText.replace(/\s+/g, " ");
  let nodes = 0;
  let chars = 0;
  const full = () => nodes >= JSON_EVIDENCE_LIMITS.nodes || chars >= JSON_EVIDENCE_LIMITS.chars;
  const visit = (v: unknown, key: string, depth: number) => {
    if (depth > JSON_EVIDENCE_LIMITS.depth || full()) return;
    if (typeof v === "number") {
      const date = compactDateText(key, v);
      if (date) visit(date, key, depth);
      return;
    }
    if (typeof v === "string") {
      const raw = compactDateText(key, v) ?? v.trim();
      if (!raw) return;
      const text = valueText(raw).slice(0, JSON_EVIDENCE_LIMITS.valueChars).trim();
      if (!readableValue(text) || seen.has(text)) return;
      seen.add(text);
      if (shownOnPage(text, visible)) return;
      const line = key ? `${key}: ${text}` : text;
      // 줄바꿈(합칠 때의 구분자)까지 센다.
      const room = JSON_EVIDENCE_LIMITS.chars - chars - (out.length ? 1 : 0);
      if (room <= 0) {
        chars = JSON_EVIDENCE_LIMITS.chars;
        return;
      }
      out.push(line.slice(0, room));
      chars += Math.min(line.length, room) + (out.length > 1 ? 1 : 0);
      return;
    }
    if (!v || typeof v !== "object") return;
    nodes++;
    if (Array.isArray(v)) {
      for (const x of v) visit(x, key, depth + 1);
      return;
    }
    for (const [k, value] of Object.entries(v as Record<string, unknown>)) {
      if (full()) return;
      visit(value, k, depth + 1);
    }
  };
  for (const r of responses) visit(r, "", 0);
  return out;
}

export interface RenderedPageContent {
  /** 브라우저가 그린 DOM의 HTML(page.content()) — 보안 검사 판별·메타 읽기용. */
  html: string;
  /** 보이는 본문(document.body.innerText). */
  text: string;
  /** 첫 문서 응답의 상태·헤더(키는 소문자). */
  status: number;
  headers: Record<string, string | undefined>;
  /** 로드 중 관찰한 같은 사이트 JSON 응답(파싱한 값). */
  data: readonly unknown[];
}

/** 브라우저로 연 페이지가 봇 차단(보안 검사) 화면인지(순수) — fetch.ts와 같은 판별 + 짧은 본문의 검사 문구. */
export function isRenderedChallenge(page: Pick<RenderedPageContent, "html" | "text" | "status" | "headers">): boolean {
  return isBotChallengeResponse({ status: page.status, headers: page.headers, html: page.html }) || looksLikeChallengeText(page.text.trim());
}

/**
 * 브라우저로 연 페이지 → 모델에 줄 본문 텍스트(순수). 맨 앞에 페이지 제목·공유 제목/설명(회사·직무 단서), 이어서 보이는 본문,
 * 끝에 '페이지가 불러온 데이터'(보이지 않는 접힌 내용 등). 전체는 JD 상한으로 자른다.
 */
export function renderedPageText(page: Pick<RenderedPageContent, "html" | "text" | "data">, maxChars: number = POSTING_LIMITS.jdText): string {
  const meta = pageMeta(page.html);
  const head = [
    meta.title && `페이지 제목: ${meta.title}`,
    meta.ogTitle && meta.ogTitle !== meta.title && `공유 제목: ${meta.ogTitle}`,
    meta.ogDescription && `공유 설명: ${meta.ogDescription}`,
    meta.description && meta.description !== meta.ogDescription && `페이지 설명: ${meta.description}`,
  ].filter(Boolean);
  const body = collapseWhitespaceKeepLines(page.text.replace(/\r\n?/g, "\n").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, ""));
  const data = jsonEvidenceLines(page.data, body);
  return [head.join("\n"), body, data.length ? `페이지가 불러온 데이터\n${data.join("\n")}` : ""]
    .filter(Boolean)
    .join("\n\n")
    .slice(0, maxChars)
    .trim();
}
