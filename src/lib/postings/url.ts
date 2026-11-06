/**
 * 공고 URL 정규화·검사·플랫폼 추정(클라이언트·서버 공용, 순수).
 * CareerLoop(src/lib/postings.ts normalizeUrl·isValidUrl, src/lib/postingImportTypes.ts parsePostingUrl,
 * src/data/platforms.ts inferPlatformId)에서 가져옴.
 */

/** 사용자에게 그대로 보여도 되는 URL 입력 오류(400). 서버 모듈이 FeatureError로 바꿔 응답한다. */
export class PostingUrlError extends Error {
  readonly status = 400;
  constructor(message: string) {
    super(message);
    this.name = "PostingUrlError";
  }
}

/** 스킴이 없으면 https://를 붙인다("wanted.co.kr/wd/1"처럼 붙여 넣는 경우가 많다). 다른 스킴(ftp: 등)은 그대로 둔다. */
export function withScheme(raw: string): string {
  const value = raw.trim();
  return /^[a-z][a-z\d+.-]*:/i.test(value) ? value : `https://${value}`;
}

/**
 * 같은 공고인데 URL만 다른 경우(추적 파라미터, 끝 슬래시, www 유무, 플랫폼 별칭 호스트)를 하나로 본다.
 * 결과는 중복 판별 키(job_postings.url_key)다. 해석할 수 없는 문자열은 소문자로만 정리해 그대로 쓴다.
 */
export function normalizeUrl(raw: string): string {
  const value = raw.trim();
  if (!value) return "";
  try {
    const url = new URL(/^https?:/i.test(value) ? value : `https://${value}`);
    url.hash = "";
    url.host = url.host.toLowerCase().replace(/^www\./, "");
    // 플랫폼별 개별 공고의 식별자는 유지하고 유입 경로만 다른 링크를 합친다.
    if (["wanted.co.kr", "recruit.wanted.co.kr"].includes(url.hostname) && /^\/wd\/\d+\/?$/.test(url.pathname)) {
      url.hostname = "wanted.co.kr";
      url.search = "";
    } else if (["catch.co.kr", "m.catch.co.kr"].includes(url.hostname) && /^\/NCS\/RecruitInfoDetails\/\d+\/?$/.test(url.pathname)) {
      url.hostname = "catch.co.kr";
      url.search = "";
    } else if (
      (url.hostname === "jobkorea.co.kr" && /^\/Recruit\/GI_Read\/\d+\/?$/i.test(url.pathname)) ||
      (url.hostname === "career.rememberapp.co.kr" && /^\/job\/posting\/\d+\/?$/.test(url.pathname)) ||
      (url.hostname === "zighang.com" && /^\/recruitment\/[\da-f-]+\/?$/i.test(url.pathname))
    ) {
      url.search = "";
    } else if (url.hostname === "jobplanet.co.kr" && url.pathname === "/job/search") {
      const ids = url.searchParams.getAll("posting_ids[]");
      if (ids.length === 1 && /^\d+$/.test(ids[0]!)) {
        url.search = "";
        url.searchParams.set("posting_ids[]", ids[0]!);
      }
    }
    for (const key of Array.from(url.searchParams.keys())) {
      if (/^(utm_|client_id|ref|source|fbclid|gclid)/i.test(key)) url.searchParams.delete(key);
    }
    url.search = url.searchParams.toString();
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host}${path}${url.search ? `?${url.search}` : ""}`;
  } catch {
    return value.toLowerCase();
  }
}

/** 공고 링크로 저장할 만한 형식인지(호스트에 점이 있는 http/https 주소). 스킴이 없어도 된다. */
export function isValidUrl(raw: string): boolean {
  const value = raw.trim();
  if (!value) return false;
  try {
    const url = new URL(withScheme(value));
    return /^https?:$/.test(url.protocol) && Boolean(url.host) && url.hostname.includes(".");
  } catch {
    return false;
  }
}

/**
 * URL 가져오기 입력 검사: 공개 http/https 주소만(로그인 정보·별도 포트 없음). 실패하면 PostingUrlError(400).
 * 실제 연결 대상이 공개 주소인지는 fetch.ts가 DNS 결과로 다시 검사한다.
 */
export function parsePostingUrl(raw: string): URL {
  if (raw.length > 2048) throw new PostingUrlError("주소는 2,048자 이내로 입력하세요.");
  let url: URL;
  try {
    url = new URL(withScheme(raw));
  } catch {
    throw new PostingUrlError("https://로 시작하는 공고 상세 주소를 입력하세요.");
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password || url.port || !url.hostname) {
    throw new PostingUrlError("로그인 정보나 별도 포트가 없는 공개 http/https 주소를 입력하세요.");
  }
  url.hash = "";
  return url;
}

/** 채용 플랫폼 식별자 → 화면 이름. */
export const PLATFORM_LABELS: Record<string, string> = {
  remember: "리멤버",
  wanted: "원티드",
  linkedin: "링크드인",
  jobkorea: "잡코리아",
  saramin: "사람인",
  incruit: "인크루트",
  rocketpunch: "로켓펀치",
  groupby: "그룹바이",
  zighang: "직행",
  peoplenjob: "피플앤잡",
  glassdoor: "글래스도어",
  catch: "캐치",
  jasoseol: "자소설닷컴",
  superookie: "슈퍼루키",
  jobplanet: "잡플래닛",
};

const PLATFORM_HOSTS: [id: string, hosts: string[]][] = [
  ["remember", ["rememberapp.co.kr"]],
  ["wanted", ["wanted.co.kr"]],
  ["linkedin", ["linkedin.com"]],
  ["jobkorea", ["jobkorea.co.kr"]],
  ["saramin", ["saramin.co.kr"]],
  ["incruit", ["incruit.com"]],
  ["rocketpunch", ["rocketpunch.com"]],
  ["groupby", ["groupby.kr"]],
  ["zighang", ["zighang.com"]],
  ["peoplenjob", ["peoplenjob.com"]],
  ["glassdoor", ["glassdoor.com"]],
  ["catch", ["catch.co.kr"]],
  ["jasoseol", ["jasoseol.com"]],
  ["superookie", ["superookie.com"]],
  ["jobplanet", ["jobplanet.co.kr"]],
];

/**
 * URL의 채용 플랫폼. 알려진 플랫폼이면 식별자(wanted 등), 아니면 호스트 이름(www 제외, 회사 채용 페이지 등).
 * URL이 아니면 "".
 */
export function inferPlatform(raw: string): string {
  if (!isValidUrl(raw)) return "";
  const host = new URL(withScheme(raw)).hostname.toLowerCase().replace(/^www\./, "");
  const hit = PLATFORM_HOSTS.find(([, hosts]) => hosts.some((h) => host === h || host.endsWith(`.${h}`)));
  return (hit ? hit[0] : host).slice(0, 40);
}

/**
 * 공용 공고에 올려도 되는 플랫폼 값: 알려진 채용 플랫폼 식별자만, 그 밖(호스트 이름 — 사내·비공개 주소일 수 있다)은 null.
 * 직접 입력 공고는 주소를 공유하지 않으므로 호스트 이름도 내보내지 않는다.
 */
export function publicPlatform(platform: string | null | undefined): string | null {
  return platform && PLATFORM_HOSTS.some(([id]) => id === platform) ? platform : null;
}

/** 화면 표시용 플랫폼 이름. */
export function platformLabel(platform: string): string {
  return PLATFORM_LABELS[platform] ?? platform;
}
