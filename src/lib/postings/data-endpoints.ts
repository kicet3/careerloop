/**
 * 데이터 요청(request-data.ts)의 순수 부분: 자바스크립트로 그리는 공고 페이지의 정적 HTML·스크립트에서 페이지가 상세 내용을
 * 불러오는 같은 출처 데이터 주소(공개 API)를 찾고(discoverDataEndpoints), 받은 데이터가 이 페이지의 공고 한 건인지 판단해
 * (postingDetailRecord·recordMatchesPage·isPostingLikeData)
 * 모델에 줄 본문으로 바꾼다(requestedPageText — 브라우저 경로의 renderedPageText와 같은 JSON 평탄화).
 *
 * 찾는 방법(결정적 — AI를 쓰지 않는다):
 * - 페이지 주소의 식별자: 숫자가 든 쿼리 값(seq=6217)과 끝쪽 경로 마디(/recruit/10549).
 * - 스크립트의 문자열 이어 붙이기(url + "/guest/" + seq, `/api/x/${id}`): 변수는 가장 가까운 앞쪽 경로 문자열 대입으로 풀고,
 *   쿼리 이름과 같은 변수(seq), 맨 이름(id·seq·no·idx), 앞부분이 페이지 경로 마디인 이름(announceSeq·positionId)만 페이지 식별자로
 *   바꾼다(점 표기 속성 data.projectSeq·다른 대상의 categoryId는 바꾸지 않는다). 결과가 데이터 주소처럼 보여야 한다(/api/, /v1/, .json …).
 * - 이어 붙이기가 없으면 페이지 경로와 마디를 공유하는 데이터 주소 문자열을 바탕으로 base/{id}, base?{param}={id}를 만든다.
 * - 후보는 같은 출처 http(s)만, 최대 POSTING_DATA_DISCOVERY.maxCandidates개. 순위: 쿼리 이름과 같은 변수(+3), 비로그인용
 *   마디(guest·public·open·anonymous, +2), 페이지 경로와 같은 마디(+1), 로그인·관리 마디(-3), 짧은 주소 우선.
 */
import { Parser } from "htmlparser2";
import { MIN_PAGE_TEXT_CHARS } from "./extract";
import { jsonEvidenceLines, pageMeta, renderedPageText } from "./rendered-text";

export const POSTING_DATA_DISCOVERY = {
  maxCandidates: 8,
  /** 스크립트 한 개·합계에서 읽을 상한(글자). */
  maxScriptChars: 512 * 1024,
  maxTotalScriptChars: 1024 * 1024,
  /** 받아 볼 외부 스크립트 파일 수(같은 출처, 라이브러리 제외). */
  maxScriptFiles: 3,
} as const;

export interface PageIdentifier {
  value: string;
  /** 쿼리 이름(seq 등). 경로 마디에서 온 식별자는 null. */
  param: string | null;
}

const ID_VALUE = /^[A-Za-z0-9_-]{1,64}$/;
const TRACKING_PARAM = /^(?:utm_|fbclid|gclid|ref|source|from)/i;

/** 페이지 주소의 식별자(쿼리 값 먼저, 그다음 끝쪽 경로 마디 — 숫자가 든 것만). */
export function pageIdentifiers(pageUrl: URL): PageIdentifier[] {
  const out: PageIdentifier[] = [];
  const add = (value: string, param: string | null) => {
    if (ID_VALUE.test(value) && /\d/.test(value) && !out.some((x) => x.value === value)) out.push({ value, param });
  };
  for (const [k, v] of pageUrl.searchParams) if (!TRACKING_PARAM.test(k)) add(v, k);
  const segments = pageUrl.pathname.split("/").filter(Boolean);
  for (const seg of segments.slice(-2).reverse()) {
    let decoded = seg;
    try {
      decoded = decodeURIComponent(seg);
    } catch {
      // 잘못된 인코딩은 그대로 둔다.
    }
    if (ID_VALUE.test(decoded) && /\d/.test(decoded)) {
      add(decoded, null);
      break;
    }
  }
  return out;
}

const JS_TYPE = /^(?:|text\/javascript|application\/javascript|module|text\/ecmascript)$/i;

/** 인라인 스크립트 본문과 외부 스크립트 주소(순수). */
export function pageScripts(html: string): { inline: string[]; sources: string[] } {
  const inline: string[] = [];
  const sources: string[] = [];
  let current: string[] | null = null;
  let total = 0;
  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name !== "script") return;
        if (!JS_TYPE.test((attrs.type ?? "").trim())) return;
        if (attrs.src) sources.push(attrs.src);
        else current = [];
      },
      ontext(text) {
        if (current && total < POSTING_DATA_DISCOVERY.maxTotalScriptChars) {
          current.push(text);
          total += text.length;
        }
      },
      onclosetag(name) {
        if (name !== "script" || !current) return;
        const body = current.join("").slice(0, POSTING_DATA_DISCOVERY.maxScriptChars);
        if (body.trim()) inline.push(body);
        current = null;
      },
    },
    { decodeEntities: false },
  );
  parser.write(html);
  parser.end();
  return { inline, sources };
}

/** 받아 볼 만한 외부 스크립트(같은 출처, 잘 알려진 라이브러리·분석 도구 제외) — 앞에서부터 maxScriptFiles개. */
const VENDOR_SCRIPT =
  /jquery|knockout|polyfill|generator-runtime|regenerator|swiper|scrollbar|bootstrap|lodash|underscore|moment|kakao|gtag|analytics|gtm|sns-share|cookie|slick|select2|datepicker|vendor|chunk-vendors|polyfills/i;
export function appScriptUrls(sources: readonly string[], pageUrl: URL): string[] {
  const out: string[] = [];
  for (const src of sources) {
    let url: URL;
    try {
      url = new URL(src, pageUrl);
    } catch {
      continue;
    }
    if (url.origin !== pageUrl.origin || VENDOR_SCRIPT.test(url.pathname)) continue;
    url.hash = "";
    if (!out.includes(url.href)) out.push(url.href);
    if (out.length >= POSTING_DATA_DISCOVERY.maxScriptFiles) break;
  }
  return out;
}

const DATA_PATH = /\/api\/|\/v\d+\/|\.json(?:$|\?)|\/rest\/|\/ajax\/|\/data\/|\/graphql\b/i;
const BARE_ID_NAME = /^(?:seq|id|no|idx|sn|num)$/i;
/** announceSeq·positionId·recruit_no → 앞부분(announce·position·recruit). */
const PREFIXED_ID_NAME = /^([a-z][a-z0-9]*?)_?(?:Seq|Id|No|Idx|SEQ|ID|NO|IDX|seq|id|no|idx)$/;
const GUEST_SEGMENT = /\/(?:guest|public|open|anonymous|anon)(?:\/|$)/i;
const PRIVATE_SEGMENT = /\/(?:login|logout|auth|admin|my|mypage|member|user|account|session|token)(?:\/|$)/i;
/** 쓰기·개인 동작으로 보이는 마디(GET이어도 부르지 않는다). */
const ACTION_SEGMENT = /\/(?:insert|update|delete|remove|save|write|submit|check\w*|interest|like|scrap|upload|password)(?:\/|\?|$)/i;
const ID_TOKEN = "\u0000ID\u0000";

/** 문자열이 같은 출처 경로(또는 같은 출처 절대 주소)인지 — 경로로 돌려준다. */
function asPath(value: string, origin: string): string | null {
  if (value.startsWith("/") && !value.startsWith("//")) return value;
  if (value.startsWith(`${origin}/`)) return value.slice(origin.length);
  return null;
}

interface Assignment {
  index: number;
  value: string;
}

const STRING = String.raw`"[^"\\\n]{0,300}"|'[^'\\\n]{0,300}'`;
const IDENT = String.raw`[A-Za-z_$][\w$]*(?:\(\))?(?:\.[A-Za-z_$][\w$]*(?:\(\))?){0,4}`;
const OPERAND = `(?:${STRING}|${IDENT})`;
const CONCAT = new RegExp(`${OPERAND}(?:\\s*\\+\\s*${OPERAND}){1,6}`, "g");
const OPERAND_ONE = new RegExp(`^(?:${STRING}|${IDENT})$`);
const ASSIGN = /([A-Za-z_$][\w$]*)\s*[:=]\s*(["'])([^"'\\\n]{1,300})\2/g;
const TEMPLATE = /`([^`\\\n]{1,300})`/g;
const STRING_LITERAL = /(["'])([^"'\\\n]{2,300})\1/g;

interface Candidate {
  path: string;
  score: number;
  order: number;
}

/**
 * 스크립트들 → 데이터 주소 후보(절대 주소, 순위 순, 최대 maxCandidates개). 순수 — 접속하지 않는다.
 */
export function discoverDataEndpoints(pageUrl: URL, scripts: readonly string[]): string[] {
  const ids = pageIdentifiers(pageUrl);
  if (!ids.length) return [];
  const origin = pageUrl.origin;
  const pageSegments = new Set(
    pageUrl.pathname
      .split("/")
      .filter((s) => s.length >= 3 && !/\d/.test(s) && !/^(?:view|detail|index|page|list)$/i.test(s))
      .map((s) => s.toLowerCase()),
  );
  const candidates = new Map<string, Candidate>();
  let order = 0;
  const add = (rawPath: string, score: number, id: PageIdentifier) => {
    const path = rawPath.replace(ID_TOKEN, encodeURIComponent(id.value));
    if (path.includes(ID_TOKEN) || !DATA_PATH.test(path) || ACTION_SEGMENT.test(path)) return;
    let url: URL;
    try {
      url = new URL(path, origin);
    } catch {
      return;
    }
    if (url.origin !== origin || !/^https?:$/.test(url.protocol)) return;
    url.hash = "";
    let s = score;
    if (GUEST_SEGMENT.test(url.pathname)) s += 2;
    if (PRIVATE_SEGMENT.test(url.pathname)) s -= 3;
    if (url.pathname.split("/").some((seg) => pageSegments.has(seg.toLowerCase()))) s += 1;
    const prev = candidates.get(url.href);
    if (!prev || prev.score < s) candidates.set(url.href, { path: url.href, score: s, order: prev?.order ?? order++ });
  };

  for (const script of scripts) {
    const text = script.slice(0, POSTING_DATA_DISCOVERY.maxScriptChars);
    // 변수 → 경로 문자열 대입(같은 이름이 여러 번이면 쓰는 자리에서 가장 가까운 앞쪽 대입).
    const assignments = new Map<string, Assignment[]>();
    for (const m of text.matchAll(ASSIGN)) {
      const path = asPath(m[3]!, origin);
      if (!path) continue;
      const list = assignments.get(m[1]!) ?? [];
      list.push({ index: m.index!, value: path });
      assignments.set(m[1]!, list);
    }
    const resolveIdent = (name: string, at: number): string | null => {
      const list = assignments.get(name);
      if (!list) return null;
      let best: Assignment | null = null;
      for (const a of list) if (a.index < at && (!best || a.index > best.index)) best = a;
      return (best ?? list[0]!).value;
    };
    /**
     * 변수 이름 → 페이지 식별자. 다른 대상의 번호(categoryId·companyId·data.projectSeq)에 공고 번호를 넣지 않도록 좁게 본다:
     * 쿼리 이름과 같은 이름(seq=… → seq), 맨 이름(id·seq·no·idx …), 또는 앞부분이 페이지 경로 마디인 이름
     * (/positions/9983 → positionId, /apply/announce/view → announceSeq)만. 점 표기 속성은 응답 안의 값이라 바꾸지 않는다.
     */
    const idFor = (name: string): { id: PageIdentifier; exact: boolean } | null => {
      const exact = ids.find((x) => x.param && x.param.toLowerCase() === name.toLowerCase());
      if (exact) return { id: exact, exact: true };
      if (BARE_ID_NAME.test(name)) return { id: ids[0]!, exact: false };
      const prefix = name.match(PREFIXED_ID_NAME)?.[1]?.toLowerCase();
      if (prefix && prefix.length >= 3 && [...pageSegments].some((seg) => seg === prefix || seg === `${prefix}s` || seg === `${prefix}es`)) {
        return { id: ids[0]!, exact: false };
      }
      return null;
    };
    const resolveExpression = (tokens: string[], at: number): { path: string; id: PageIdentifier; exact: boolean } | null => {
      let path = "";
      let found: { id: PageIdentifier; exact: boolean } | null = null;
      for (const raw of tokens) {
        const t = raw.trim();
        if (!OPERAND_ONE.test(t)) return null;
        if (t.startsWith('"') || t.startsWith("'")) {
          path += t.slice(1, -1);
          continue;
        }
        if (t.includes(".")) return null;
        const name = t.replace(/\(\)$/, "");
        const assigned = resolveIdent(name, at);
        if (assigned && !path) {
          path = assigned;
          continue;
        }
        const id = idFor(name);
        if (!id || found) return null;
        found = id;
        path += ID_TOKEN;
      }
      const start = asPath(path, origin);
      return found && start ? { path: start, ...found } : null;
    };

    for (const m of text.matchAll(CONCAT)) {
      const tokens = m[0].split(/\s*\+\s*/);
      const resolved = resolveExpression(tokens, m.index!);
      if (resolved) add(resolved.path, resolved.exact ? 3 : 0, resolved.id);
    }
    for (const m of text.matchAll(TEMPLATE)) {
      const parts = m[1]!.split(/\$\{\s*([^}]{1,80}?)\s*\}/);
      const tokens = parts.map((p, i) => (i % 2 ? p : JSON.stringify(p))).filter((p) => p !== '""');
      const resolved = resolveExpression(tokens, m.index!);
      if (resolved) add(resolved.path, resolved.exact ? 3 : 0, resolved.id);
    }
    // 식별자가 그대로 든 데이터 주소 문자열(설정 객체 등).
    for (const m of text.matchAll(STRING_LITERAL)) {
      const path = asPath(m[2]!, origin);
      if (!path) continue;
      for (const id of ids) {
        if (new RegExp(`(?:^|[/=])${id.value.replace(/[-]/g, "\\-")}(?:$|[/?&.])`).test(path)) add(path, 3, id);
      }
    }
  }

  // 이어 붙이기로 찾지 못했으면, 페이지 경로와 마디를 공유하는 데이터 주소 문자열을 바탕으로 만든다.
  if (!candidates.size) {
    const bases: string[] = [];
    for (const script of scripts) {
      for (const m of script.slice(0, POSTING_DATA_DISCOVERY.maxScriptChars).matchAll(STRING_LITERAL)) {
        const path = asPath(m[2]!, origin)?.replace(/[?#].*$/, "").replace(/\/+$/, "");
        if (!path || !DATA_PATH.test(`${path}/`) || bases.includes(path)) continue;
        if (!path.split("/").some((seg) => pageSegments.has(seg.toLowerCase()))) continue;
        bases.push(path);
      }
    }
    const id = ids[0]!;
    for (const base of bases.slice(0, 4)) {
      add(`${base}/${ID_TOKEN}`, -1, id);
      if (id.param) add(`${base}?${encodeURIComponent(id.param)}=${ID_TOKEN}`, -1, id);
    }
  }

  return [...candidates.values()]
    .sort((a, b) => b.score - a.score || a.path.length - b.path.length || a.order - b.order)
    .slice(0, POSTING_DATA_DISCOVERY.maxCandidates)
    .map((c) => c.path);
}

/** 공고 데이터로 보이는 키(공고 제목·설명·자격·업무 등). */
const POSTING_KEY = /title|desc|qualif|requir|duty|duties|responsib|prefer|benefit|position|recruit|employ|announce|업무|자격|우대|요건|직무|모집|채용|공고/i;

/**
 * 받은 데이터가 공고 상세처럼 보이는지(순수): 평탄화한 줄이 MIN_PAGE_TEXT_CHARS 이상이고, 공고 키가 2개 이상이거나
 * 한글이 200자 이상이거나 페이지 공유 제목이 들어 있다.
 */
export function isPostingLikeData(lines: readonly string[], hints: { ogTitle?: string } = {}): boolean {
  const text = lines.join("\n");
  if (text.length < MIN_PAGE_TEXT_CHARS) return false;
  const keys = new Set(lines.map((l) => l.split(":")[0]!.trim()).filter((k) => k.length <= 40 && POSTING_KEY.test(k)));
  if (keys.size >= 2) return true;
  if ((text.match(/[가-힣]/g)?.length ?? 0) >= 200) return true;
  const og = hints.ogTitle?.trim() ?? "";
  return og.length >= 4 && text.includes(og);
}

/** 받은 응답 본문 → 데이터 값(JSON이면 파싱한 값, 아니면 null). */
export function parseDataBody(text: string, contentType: string): unknown {
  const body = text.trim();
  if (!/json/i.test(contentType) && !/^[[{]/.test(body)) return null;
  try {
    return JSON.parse(body);
  } catch {
    return null;
  }
}

type DataRecord = Record<string, unknown>;
const isRecord = (v: unknown): v is DataRecord => v !== null && typeof v === "object" && !Array.isArray(v);
const hasPostingScalar = (o: DataRecord) =>
  Object.entries(o).some(([k, v]) => typeof v === "string" && v.trim().length >= 2 && POSTING_KEY.test(k));

/**
 * 공고 한 건의 상세 레코드(순수): 최상위(또는 한 겹 감싼 {data:{…}})에 공고 키의 문자열 값이 있어야 한다.
 * 목록 응답(최상위 배열, {list:[…]}·{items:[…]}·{content:[…]}처럼 배열만 든 응답)은 null — 목록 속 다른 공고를 이 링크로 저장하지 않는다.
 */
export function postingDetailRecord(data: unknown): DataRecord | null {
  let v = data;
  if (Array.isArray(v)) {
    if (v.length !== 1) return null;
    v = v[0];
  }
  if (!isRecord(v)) return null;
  if (hasPostingScalar(v)) return v;
  const inner = Object.values(v).filter((x): x is DataRecord => isRecord(x) && hasPostingScalar(x));
  return inner.length === 1 ? inner[0]! : null;
}

/** 레코드의 값(배열 속은 보지 않는다 — 관련 공고·목록의 번호·제목으로 판단하지 않게). */
function recordScalars(o: DataRecord, depth = 0, out: { key: string; value: string }[] = []): { key: string; value: string }[] {
  for (const [key, v] of Object.entries(o)) {
    if (typeof v === "string" || typeof v === "number") out.push({ key, value: String(v).trim() });
    else if (isRecord(v) && depth < 2) recordScalars(v, depth + 1, out);
  }
  return out;
}

/**
 * 받은 상세가 바로 이 페이지의 공고인지(순수): 레코드 값에 페이지 식별자(seq=6217이면 6217)가 그대로 있거나,
 * 레코드의 제목이 페이지 제목·공유 제목에 들어 있거나 그 반대.
 */
export function recordMatchesPage(record: DataRecord, pageUrl: URL, staticHtml: string): boolean {
  const scalars = recordScalars(record);
  const ids = pageIdentifiers(pageUrl).map((x) => x.value);
  if (scalars.some((s) => ids.includes(s.value))) return true;
  const meta = pageMeta(staticHtml);
  const pageTitles = [meta.ogTitle, meta.title].map((t) => t.trim()).filter((t) => t.length >= 4);
  return scalars.some(
    (s) => /title|subject|name|제목/i.test(s.key) && s.value.length >= 4 && pageTitles.some((t) => t.includes(s.value) || s.value.includes(t)),
  );
}

/**
 * 데이터 응답이 이 페이지의 공고 상세면 모델에 줄 본문(페이지 제목·공유 메타 + 평탄화한 데이터), 아니면 null(순수).
 * 공고 한 건의 레코드(postingDetailRecord)이고, 이 페이지를 가리키며(recordMatchesPage), 내용이 공고처럼 보여야(isPostingLikeData) 한다.
 */
export function requestedPageText(staticHtml: string, data: unknown, pageUrl: URL): string | null {
  const record = postingDetailRecord(data);
  if (!record || !recordMatchesPage(record, pageUrl, staticHtml)) return null;
  const lines = jsonEvidenceLines([data], "");
  if (!isPostingLikeData(lines, { ogTitle: pageMeta(staticHtml).ogTitle })) return null;
  return renderedPageText({ html: staticHtml, text: "", data: [data] });
}

/**
 * HTML로 상세 조각을 주는 응답 → 본문, 아니면 null(순수). 모르는 경로에 사이트 껍데기·오류 페이지를 주는 사이트가 있어 좁게 본다:
 * 한글 200자 이상, 정적 페이지와 다른 본문, 페이지 식별자가 HTML에 그대로 있음, 정적 페이지와 제목이 같은 전체 문서(사이트 껍데기)가 아님.
 */
export function requestedHtmlText(staticHtml: string, html: string, pageUrl: URL, toText: (html: string) => string): string | null {
  const text = toText(html);
  if ((text.match(/[가-힣]/g)?.length ?? 0) < 200) return null;
  if (text.trim() === toText(staticHtml).trim()) return null;
  const ids = pageIdentifiers(pageUrl).map((x) => x.value.replace(/[-]/g, "\\-"));
  if (!ids.some((id) => new RegExp(`(?<![\\w-])${id}(?![\\w-])`).test(html))) return null;
  if (/<(?:html|body)[\s>]/i.test(html)) {
    const a = pageMeta(html);
    const b = pageMeta(staticHtml);
    const same = (x: string, y: string) => !!x.trim() && x.trim() === y.trim();
    if (same(a.title, b.title) || same(a.ogTitle, b.ogTitle)) return null;
  }
  return text;
}
