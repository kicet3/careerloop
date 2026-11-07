/**
 * 청크 나누기·검색어 만들기(§6.1, §6.3 — 순수 함수). 한국어 사전이 없는 Postgres 'simple' FTS를 쓰므로 토큰화는 앱이 한다:
 * 그래프 검색(graph/retrieve.ts)과 같은 tokenize·stripParticle·hangulBigrams·canonicalSkill 정규화.
 * lexeme은 sanitizeLexeme을 거쳐 [\p{L}\p{N}]만 남는다 — tsquery 연산자(& | ! ( ) : * <->)·따옴표가 남지 않아 문법 주입이 없다.
 */
import { hangulBigrams, rawTokens, stripParticle, tokenize } from "@/lib/graph/retrieve";
import { canonicalSkill, skillKey } from "@/lib/skills/dictionary";

export const CHUNK_SOURCE_TYPES = Object.freeze(["repo-brief", "document-import", "portfolio-text"] as const);
export type ChunkSourceType = (typeof CHUNK_SOURCE_TYPES)[number];
export const isChunkSourceType = (v: unknown): v is ChunkSourceType => typeof v === "string" && (CHUNK_SOURCE_TYPES as readonly string[]).includes(v);

export const CHUNK_MIN = 800;
export const CHUNK_MAX = 1200;
export const CHUNK_OVERLAP = 150;
/** 출처 하나당 청크 수 상한(긴 문서 방어). */
export const MAX_CHUNKS_PER_SOURCE = 60;

export interface Span {
  start: number;
  end: number;
}

/** 원문 → [start,end) 구간들. 문단 경계를 먼저 보고, 800~1200자 창에 150자 겹침. 오프셋은 원문 기준(JS 문자열 인덱스). */
export function chunkSpans(text: string): Span[] {
  const spans: Span[] = [];
  const len = text.length;
  if (len === 0 || text.trim().length === 0) return spans;
  let start = 0;
  while (start < len && spans.length < MAX_CHUNKS_PER_SOURCE) {
    while (start < len && /\s/.test(text[start]!)) start++;
    if (start >= len) break;
    let end = Math.min(len, start + CHUNK_MAX);
    if (end < len) {
      // 800자 뒤의 마지막 문단 경계(빈 줄) → 줄바꿈 → 문장 끝 순서로 자른다.
      const window = text.slice(start + CHUNK_MIN, end);
      const cut = [window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), Math.max(window.lastIndexOf(". "), window.lastIndexOf("다. "))].find((i) => i >= 0);
      if (cut !== undefined) end = start + CHUNK_MIN + cut + 1;
    }
    let trimmedEnd = end;
    while (trimmedEnd > start && /\s/.test(text[trimmedEnd - 1]!)) trimmedEnd--;
    if (trimmedEnd > start) spans.push({ start, end: trimmedEnd });
    if (end >= len) break;
    start = Math.max(end - CHUNK_OVERLAP, start + 1);
  }
  return spans;
}

/** lexeme 정리: NFKC → 소문자 → 문자·숫자만 → 64자. 빈 문자열이면 버린다. */
export function sanitizeLexeme(raw: string): string {
  return raw
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "")
    .slice(0, 64);
}

/** 텍스트 → 정규화 토큰(조사 뗀 토큰 + 한글 바이그램 + 기술 정식 이름). 문서·질의 공통. */
export function lexemesOf(text: string): string[] {
  const out = new Set<string>();
  for (const t of tokenize(text)) {
    const s = sanitizeLexeme(t);
    if (s) out.add(s);
    for (const b of hangulBigrams(t)) out.add(b);
  }
  for (const t of rawTokens(text)) {
    const c = canonicalSkill(t) ?? canonicalSkill(stripParticle(t));
    if (c) {
      const k = sanitizeLexeme(skillKey(c));
      if (k) out.add(k);
    }
  }
  return [...out];
}

/** 색인용 search_terms(공백 구분). */
export function searchTermsOf(text: string): string {
  return lexemesOf(text).join(" ").slice(0, 20_000);
}

/** 질의 lexeme(상한 32개). */
export function queryLexemes(query: string): string[] {
  return lexemesOf(query).map(sanitizeLexeme).filter(Boolean).slice(0, 32);
}
