/**
 * 테스트 전용 가짜 GitHub(api.github.com·github.com/login/oauth). fetch 자리에 넣는다. 앱 코드에서는 import할 수 없다.
 * 저장소 하나(owner/repo)를 두고 REST·GraphQL·토큰 엔드포인트를 흉내 낸다. calls에 부른 주소가 쌓인다.
 */
export interface FakeRepoOptions {
  owner?: string;
  name?: string;
  id?: number;
  private?: boolean;
  description?: string;
  readme?: string;
  /** 회원님 커밋 메시지(최근 순). */
  myCommits?: { message: string; date: string }[];
  /** 회원님 커밋 수(Link 마지막 페이지). */
  myCommitCount?: number;
  pushPermission?: boolean;
  packageJson?: Record<string, unknown> | null;
  etag?: string;
}

export interface FakeGithub {
  fetch: typeof fetch;
  calls: { method: string; url: string; headers: Record<string, string>; body: string | null }[];
  /** 다음 토큰 갱신 응답(기본: 새 토큰). */
  refreshResponse: (() => Response) | null;
  /** 저장소 메타데이터 응답을 바꾼다(예: 401·403 한도). */
  repoOverride: (() => Response) | null;
  tokenSeq: number;
}

const json = (body: unknown, init: ResponseInit & { headers?: Record<string, string> } = {}) =>
  new Response(JSON.stringify(body), { status: init.status ?? 200, headers: { "content-type": "application/json", "x-ratelimit-remaining": "4999", ...init.headers } });

export function createFakeGithub(opts: FakeRepoOptions = {}): FakeGithub {
  const owner = opts.owner ?? "octo";
  const name = opts.name ?? "career-app";
  const id = opts.id ?? 4242;
  const etag = opts.etag ?? '"etag-1"';
  const myCommits = opts.myCommits ?? [
    { message: "feat: 결제 API를 Go로 다시 작성\n\n자세한 설명", date: "2024-03-02T10:00:00Z" },
    { message: "fix: 정산 배치 시간대 버그", date: "2023-11-20T10:00:00Z" },
  ];
  const myCount = opts.myCommitCount ?? myCommits.length;
  const pkg = opts.packageJson === undefined ? { dependencies: { next: "16", react: "19" }, devDependencies: { eslint: "9", typescript: "5" } } : opts.packageJson;
  const fake: FakeGithub = {
    calls: [],
    refreshResponse: null,
    repoOverride: null,
    tokenSeq: 0,
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
      const method = (init?.method ?? "GET").toUpperCase();
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
      const body = typeof init?.body === "string" ? init.body : null;
      fake.calls.push({ method, url: url.href, headers, body });

      if (url.hostname === "github.com" && url.pathname === "/login/oauth/access_token") {
        const form = new URLSearchParams(body ?? "");
        if (form.get("grant_type") === "refresh_token" && fake.refreshResponse) return fake.refreshResponse();
        fake.tokenSeq++;
        return json({
          access_token: `ghu_access_${fake.tokenSeq}`,
          expires_in: 28800,
          refresh_token: `ghr_refresh_${fake.tokenSeq}`,
          refresh_token_expires_in: 15897600,
          token_type: "bearer",
        });
      }
      if (url.hostname !== "api.github.com") return new Response("not found", { status: 404 });
      const path = url.pathname;
      const base = `/repos/${owner}/${name}`;
      if (path === "/user") return json({ id: 777, login: "octo-user", avatar_url: "https://avatars.githubusercontent.com/u/777" });
      if (path === "/graphql") {
        const node = {
          databaseId: id,
          nameWithOwner: `${owner}/${name}`,
          name,
          description: opts.description ?? "커리어 관리 앱",
          url: `https://github.com/${owner}/${name}`,
          isPrivate: opts.private ?? false,
          isFork: false,
          isArchived: false,
          stargazerCount: 12,
          pushedAt: "2024-03-02T10:00:00Z",
          primaryLanguage: { name: "TypeScript" },
          owner: { login: owner },
        };
        const secret = { ...node, databaseId: id + 1, nameWithOwner: `${owner}/secret`, name: "secret", isPrivate: true };
        return json({ data: { viewer: { repositories: { nodes: [node, secret] }, repositoriesContributedTo: { nodes: [] } } } });
      }
      if (method === "DELETE" && /^\/applications\/[^/]+\/grant$/.test(path)) return new Response(null, { status: 204 });
      if (path.toLowerCase() === base.toLowerCase()) {
        if (fake.repoOverride) return fake.repoOverride();
        if (headers["if-none-match"] === etag) return new Response(null, { status: 304, headers: { etag, "x-ratelimit-remaining": "4999" } });
        return json(
          {
            id,
            full_name: `${owner}/${name}`,
            name,
            owner: { login: owner },
            html_url: `https://github.com/${owner}/${name}`,
            description: opts.description ?? "커리어 관리 앱",
            topics: ["career", "nextjs"],
            homepage: "https://example.com",
            license: { spdx_id: "MIT" },
            private: opts.private ?? false,
            fork: false,
            archived: false,
            default_branch: "main",
            stargazers_count: 12,
            forks_count: 3,
            created_at: "2023-01-05T00:00:00Z",
            pushed_at: "2024-03-02T10:00:00Z",
            language: "TypeScript",
            permissions: { admin: false, push: opts.pushPermission ?? false, pull: true },
          },
          { headers: { etag } },
        );
      }
      if (path === `${base}/languages`) return json({ TypeScript: 8000, Go: 2000 });
      if (path === `${base}/readme`) return new Response(opts.readme ?? "# Career App\n\n<!-- 숨은 주석 -->\n![badge](https://img.shields.io/x)\n취업 준비를 돕는 앱입니다.", { status: 200 });
      if (path === `${base}/commits`) {
        const perPage = Number(url.searchParams.get("per_page"));
        const page = Number(url.searchParams.get("page") ?? "1");
        if (url.searchParams.has("author")) {
          if (perPage === 1) {
            const item = page > 1 ? myCommits.at(-1) : myCommits[0];
            const link = myCount > 1 ? `<https://api.github.com${base}/commits?author=x&per_page=1&page=${myCount}>; rel="last"` : null;
            return json(item ? [{ commit: { message: item.message, author: { date: page > 1 ? "2023-01-10T00:00:00Z" : item.date } } }] : [], {
              headers: link ? { link } : {},
            });
          }
          return json(myCommits.map((c) => ({ commit: { message: c.message, author: { date: c.date } } })));
        }
        return json([{ commit: { message: "x" } }], { headers: { link: `<https://api.github.com${base}/commits?per_page=1&page=340>; rel="last"` } });
      }
      if (path === `${base}/contributors`) return json([{ login: "a" }], { headers: { link: `<https://api.github.com${base}/contributors?per_page=1&page=4>; rel="last"` } });
      if (path === "/search/issues") return json({ total_count: 1, items: [{ title: "결제 API 개편", state: "closed", pull_request: { merged_at: "2024-03-03" } }] });
      if (path === `${base}/contents/`) {
        return json([
          { name: "src", type: "dir", size: 0 },
          ...(pkg ? [{ name: "package.json", type: "file", size: 300 }] : []),
          { name: "README.md", type: "file", size: 100 },
        ]);
      }
      if (path === `${base}/contents/package.json`) return new Response(JSON.stringify(pkg), { status: 200 });
      return json({ message: "Not Found" }, { status: 404 });
    }) as typeof fetch,
  };
  return fake;
}

/** 테스트용 GitHub 환경 변수(32바이트 키). */
export const FAKE_GITHUB_ENV = {
  GITHUB_APP_CLIENT_ID: "Iv1.testclient",
  GITHUB_APP_CLIENT_SECRET: "test-secret",
  GITHUB_TOKEN_ENC_KEY: Buffer.alloc(32, 7).toString("base64"),
  GITHUB_APP_SLUG: "careerloop-test",
};
