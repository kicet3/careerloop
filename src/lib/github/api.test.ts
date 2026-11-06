import { describe, expect, it, vi } from "vitest";
import { createFakeGithub } from "@/test/fake-github";
import { countFromPerPageOne, fetchRepoFacts, lastPageFromLink, listRepos, rateLimitWait } from "./api";
import { GithubAuthError, GithubNotFoundError, GithubRateLimitError } from "./types";

vi.mock("server-only", () => ({}));

describe("GitHub API 도우미", () => {
  it("Link 헤더의 마지막 페이지로 개수를 센다(Link가 없으면 항목 수)", () => {
    expect(lastPageFromLink('<https://api.github.com/x?per_page=1&page=2>; rel="next", <https://api.github.com/x?per_page=1&page=34>; rel="last"')).toBe(34);
    expect(lastPageFromLink(null)).toBeNull();
    expect(countFromPerPageOne(null, [{}])).toBe(1);
    expect(countFromPerPageOne(null, [])).toBe(0);
    expect(countFromPerPageOne('<https://api.github.com/x?page=7>; rel="last"', [{}])).toBe(7);
  });

  it("한도 응답: retry-after, remaining=0 + reset, 429", () => {
    const h = (o: Record<string, string>) => new Headers(o);
    expect(rateLimitWait({ status: 403, headers: h({ "retry-after": "30" }) }, 0)).toBe(30);
    expect(rateLimitWait({ status: 403, headers: h({ "x-ratelimit-remaining": "0", "x-ratelimit-reset": "100" }) }, 40_000)).toBe(60);
    expect(rateLimitWait({ status: 429, headers: h({}) }, 0)).toBe(60);
    expect(rateLimitWait({ status: 403, headers: h({ "x-ratelimit-remaining": "10" }) }, 0)).toBeNull();
    expect(rateLimitWait({ status: 404, headers: h({}) }, 0)).toBeNull();
  });
});

describe("listRepos", () => {
  it("GraphQL 한 번으로 읽고, 비공개는 허용했을 때만", async () => {
    const gh = createFakeGithub();
    const pub = await listRepos("t", { includePrivate: false }, { fetch: gh.fetch });
    expect(pub.map((r) => r.fullName)).toEqual(["octo/career-app"]);
    const all = await listRepos("t", { includePrivate: true }, { fetch: gh.fetch });
    expect(all.map((r) => r.fullName)).toEqual(["octo/career-app", "octo/secret"]);
    expect(gh.calls.every((c) => c.url === "https://api.github.com/graphql" && c.headers.authorization === "Bearer t")).toBe(true);
  });

  it("GraphQL을 못 쓰면 REST /user/repos로 대신한다, 401은 그대로", async () => {
    const fetchMock = vi.fn(async (u: RequestInfo | URL) => {
      if (String(u).endsWith("/graphql")) return Response.json({ errors: [{ message: "x" }] }, { status: 502 });
      return Response.json([{ id: 1, full_name: "me/one", private: false, stargazers_count: 1, pushed_at: "2024-01-01T00:00:00Z" }]);
    });
    expect((await listRepos("t", { includePrivate: false }, { fetch: fetchMock as typeof fetch })).map((r) => r.fullName)).toEqual(["me/one"]);
    const unauthorized = (async () => new Response(null, { status: 401 })) as typeof fetch;
    await expect(listRepos("t", { includePrivate: false }, { fetch: unauthorized })).rejects.toBeInstanceOf(GithubAuthError);
  });
});

describe("fetchRepoFacts", () => {
  it("저장소 정보를 모은다: 언어·README 정리·내 커밋 수·첫 커밋·전체 커밋·기여자·PR·의존성", async () => {
    const gh = createFakeGithub({ myCommitCount: 120 });
    const r = await fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "octo-user" }, { fetch: gh.fetch });
    expect(r.notModified).toBe(false);
    if (r.notModified) return;
    const f = r.facts;
    expect(f.repoId).toBe("4242");
    expect(f.languages).toEqual([
      { name: "TypeScript", percent: 80 },
      { name: "Go", percent: 20 },
    ]);
    expect(f.readme).toContain("취업 준비를 돕는 앱");
    expect(f.readme).not.toContain("숨은 주석");
    expect(f.readme).not.toContain("shields.io");
    expect(f.my.commitCount).toBe(120);
    expect(f.my.firstCommitAt).toBe("2023-01-10T00:00:00Z");
    expect(f.my.commits[0]).toEqual({ message: "feat: 결제 API를 Go로 다시 작성", date: "2024-03-02T10:00:00Z" });
    expect(f.commitsTotal).toBe(340);
    expect(f.contributors).toBe(4);
    expect(f.my.prs).toEqual([{ title: "결제 API 개편", state: "merged" }]);
    expect(f.dependencies).toEqual([{ file: "package.json", names: ["next", "react", "eslint", "typescript"] }]);
    expect(f.topLevel).toEqual(["src/", "package.json", "README.md"]);
    // api.github.com 밖으로는 부르지 않는다
    expect(gh.calls.every((c) => c.url.startsWith("https://api.github.com/"))).toBe(true);
    expect(gh.calls.length).toBeLessThanOrEqual(13);
  });

  it("ETag가 같으면 304 → notModified", async () => {
    const gh = createFakeGithub();
    const r = await fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "x", etag: '"etag-1"' }, { fetch: gh.fetch });
    expect(r.notModified).toBe(true);
    expect(gh.calls).toHaveLength(1);
  });

  it("401 → GithubAuthError, 한도 → GithubRateLimitError, 404 → GithubNotFoundError, 잘못된 이름은 부르지 않는다", async () => {
    const gh = createFakeGithub();
    gh.repoOverride = () => new Response(null, { status: 401 });
    await expect(fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "x" }, { fetch: gh.fetch })).rejects.toBeInstanceOf(GithubAuthError);
    gh.repoOverride = () => new Response(null, { status: 403, headers: { "x-ratelimit-remaining": "0", "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 120) } });
    const err = await fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "x" }, { fetch: gh.fetch }).catch((e) => e);
    expect(err).toBeInstanceOf(GithubRateLimitError);
    expect(err.status).toBe(429);
    gh.repoOverride = null;
    await expect(fetchRepoFacts("t", { owner: "octo", repo: "nope", login: "x" }, { fetch: gh.fetch })).rejects.toBeInstanceOf(GithubNotFoundError);
    const before = gh.calls.length;
    await expect(fetchRepoFacts("t", { owner: "../x", repo: "y", login: "x" }, { fetch: gh.fetch })).rejects.toBeInstanceOf(GithubNotFoundError);
    expect(gh.calls.length).toBe(before);
  });

  it("남은 한도가 100 미만이면 선택 정보를 건너뛰고 경고를 남긴다", async () => {
    const gh = createFakeGithub();
    const low = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const res = await gh.fetch(u, init);
      const headers = new Headers(res.headers);
      headers.set("x-ratelimit-remaining", "50");
      return new Response(res.status === 304 || res.status === 204 ? null : await res.text(), { status: res.status, headers });
    }) as typeof fetch;
    const r = await fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "x" }, { fetch: low });
    if (r.notModified) throw new Error("unexpected");
    expect(r.facts.readme).toBeNull();
    expect(r.facts.warnings.join(" ")).toMatch(/한도/);
    expect(gh.calls).toHaveLength(1);
  });

  it("search API의 작은 한도(분당 30회)는 선택 정보를 끄지 않는다(core 한도만 본다)", async () => {
    const gh = createFakeGithub();
    const searchLate = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const res = await gh.fetch(u, init);
      if (!String(u).includes("/search/")) return res;
      await new Promise((r) => setTimeout(r, 20)); // 1단계에서 가장 늦게 끝나게
      const headers = new Headers(res.headers);
      headers.set("x-ratelimit-remaining", "29");
      headers.set("x-ratelimit-resource", "search");
      return new Response(await res.text(), { status: res.status, headers });
    }) as typeof fetch;
    const r = await fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "octo-user" }, { fetch: searchLate });
    if (r.notModified) throw new Error("unexpected");
    expect(r.facts.dependencies).toEqual([{ file: "package.json", names: ["next", "react", "eslint", "typescript"] }]);
    expect(r.facts.warnings.join(" ")).not.toMatch(/한도/);
  });

  it("내 커밋 수를 못 읽고 목록이 꽉 차면(50개) 커밋 수·첫 커밋을 모른다고 둔다", async () => {
    const many = Array.from({ length: 50 }, (_, i) => ({ message: `c${i}`, date: new Date(Date.UTC(2024, 5, 30 - (i % 28))).toISOString() }));
    const gh = createFakeGithub({ myCommits: many });
    const countFails = (async (u: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(u));
      if (url.pathname.endsWith("/commits") && url.searchParams.has("author") && url.searchParams.get("per_page") === "1") return new Response("x", { status: 500 });
      return gh.fetch(u, init);
    }) as typeof fetch;
    const r = await fetchRepoFacts("t", { owner: "octo", repo: "career-app", login: "octo-user" }, { fetch: countFails });
    if (r.notModified) throw new Error("unexpected");
    expect(r.facts.my.commits).toHaveLength(50);
    expect(r.facts.my.commitCount).toBeNull();
    expect(r.facts.my.firstCommitAt).toBeNull();
  });
});
