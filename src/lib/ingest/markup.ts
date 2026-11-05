/**
 * HTML·HWPX(XML) 마크업에서 본문 텍스트만 뽑는다. CareerLoop(src/server/extract.ts의 markupText)에서 가져옴.
 * 고친 점: HTML 소스의 들여쓰기·줄바꿈을 공백 하나로 접고(pre 제외), title·svg·iframe·display:none도 숨김으로 보며,
 * HWPX의 탭·줄바꿈 요소를 살린다. 스크립트를 실행하거나 외부 리소스를 읽지 않는다.
 */

import { Parser } from "htmlparser2";
import { tagDepthGuard } from "@/lib/text/tag-depth";
import { trimAroundNewlines } from "@/lib/text/whitespace";

const HIDDEN_TAGS = new Set([
  "script", "style", "head", "title", "template", "noscript", "svg", "iframe", "object", "canvas", "select",
]);
const BLOCK_TAGS = new Set([
  "p", "div", "li", "ul", "ol", "table", "section", "article", "header", "footer", "main", "aside", "nav",
  "h1", "h2", "h3", "h4", "h5", "h6", "blockquote", "pre", "dt", "dd", "dl", "figure", "figcaption", "form", "hr",
]);
const CELL_TAGS = new Set(["td", "th"]);
/** 표의 행은 끝날 때만 줄을 바꾼다(행 사이에 빈 줄이 생기지 않게). */
const ROW_TAG = "tr";

/** HTML 문서의 보이는 텍스트. 블록 경계는 줄바꿈, 표 칸은 공백으로 구분한다. */
export function htmlText(html: string, maxChars = Infinity): string {
  const parts: string[] = [];
  let chars = 0;
  const push = (text: string) => {
    // 상한을 넘으면 더 모으지 않는다(넘친 결과는 폼 검증이 길이 초과로 거절한다).
    if (chars > maxChars) return;
    const piece = text.length > maxChars - chars + 1 ? text.slice(0, maxChars - chars + 1) : text;
    parts.push(piece);
    chars += piece.length;
  };
  const hidden: boolean[] = [];
  let preDepth = 0;
  const isHidden = () => hidden.length > 0 && hidden[hidden.length - 1];
  const depth = tagDepthGuard(() => parser);
  const parser: Parser = new Parser(
    {
      onopentag(name, attributes) {
        depth.open();
        const style = (attributes.style ?? "").toLowerCase().replace(/\s+/g, "");
        hidden.push(
          isHidden() ||
            HIDDEN_TAGS.has(name) ||
            "hidden" in attributes ||
            attributes["aria-hidden"] === "true" ||
            style.includes("display:none") ||
            style.includes("visibility:hidden"),
        );
        if (name === "pre" || name === "textarea") preDepth++;
        if (isHidden()) return;
        if (name === "br") push("\n");
        else if (BLOCK_TAGS.has(name)) push("\n");
      },
      ontext(text) {
        if (isHidden()) return;
        push(preDepth > 0 ? text : text.replace(/\s+/g, " "));
      },
      onclosetag(name) {
        if (!isHidden()) {
          if (BLOCK_TAGS.has(name) || name === ROW_TAG) push("\n");
          else if (CELL_TAGS.has(name)) push(" ");
        }
        if (name === "pre" || name === "textarea") preDepth = Math.max(0, preDepth - 1);
        hidden.pop();
        depth.close();
      },
    },
    { decodeEntities: true, lowerCaseTags: true },
  );
  parser.end(html);
  // 블록 경계 앞뒤에 남은 공백을 정리한다(선형 — pre 안 줄바꿈 없는 긴 탭 덩어리로 ReDoS가 나지 않게).
  return trimAroundNewlines(parts.join(""));
}

/** HWPX 구역 XML(Contents/sectionN.xml)에서 글자 요소(hp:t)만 읽는다. 문단(hp:p)이 끝나면 줄을 바꾼다. */
export function hwpxSectionText(xml: string, maxChars = Infinity): string {
  const parts: string[] = [];
  let chars = 0;
  const push = (text: string) => {
    // 상한을 넘으면 더 모으지 않는다(넘친 결과는 폼 검증이 길이 초과로 거절한다).
    if (chars > maxChars) return;
    const piece = text.length > maxChars - chars + 1 ? text.slice(0, maxChars - chars + 1) : text;
    parts.push(piece);
    chars += piece.length;
  };
  let textDepth = 0;
  const local = (name: string) => name.slice(name.lastIndexOf(":") + 1);
  const depth = tagDepthGuard(() => parser);
  const parser: Parser = new Parser(
    {
      onopentag(name) {
        depth.open();
        const tag = local(name);
        if (tag === "t") textDepth++;
        else if (textDepth > 0 && tag === "tab") push(" ");
        else if (textDepth > 0 && tag === "lineBreak") push("\n");
      },
      ontext(text) {
        if (textDepth > 0) push(text);
      },
      onclosetag(name) {
        depth.close();
        const tag = local(name);
        if (tag === "t") textDepth = Math.max(0, textDepth - 1);
        else if (tag === "p") push("\n");
      },
    },
    { xmlMode: true, decodeEntities: true },
  );
  parser.end(xml);
  return parts.join("");
}

/** HTML 바이트를 문자열로. BOM → meta charset(앞 4KB) → UTF-8 순으로 인코딩을 정한다(EUC-KR 페이지 대응). */
export function decodeHtml(bytes: Uint8Array): string {
  const head = Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(bytes.byteLength, 4096)).toString("latin1");
  let charset: string;
  if (head.startsWith("\xef\xbb\xbf")) charset = "utf-8";
  else if (head.startsWith("\xff\xfe")) charset = "utf-16le";
  else if (head.startsWith("\xfe\xff")) charset = "utf-16be";
  else charset = head.match(/<meta[^>]+charset\s*=\s*["']?\s*([\w.:-]+)/i)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    // 모르는 인코딩 이름이면 UTF-8로 읽는다.
    return new TextDecoder("utf-8").decode(bytes);
  }
}
