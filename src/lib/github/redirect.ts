/**
 * GitHub 연결 뒤 돌아갈 앱 경로에 결과를 붙인다(순수). next는 safeNextPath()를 거친 앱 안 경로다.
 * - 성공: ?github=connected(이미 github 값이 있으면 그대로 — 예: /app/graph?github=pick은 연결 뒤 저장소 고르기를 다시 연다)
 * - 실패: ?github_error=<코드>(github 값은 지운다). 코드는 화면에서 githubErrorMessage로만 문구가 된다.
 */
export function withGithubParam(next: string, result: { connected: true } | { error: string }): string {
  const url = new URL(next, "http://app.invalid");
  if ("error" in result) {
    url.searchParams.delete("github");
    url.searchParams.set("github_error", result.error);
  } else {
    url.searchParams.delete("github_error");
    if (!url.searchParams.has("github")) url.searchParams.set("github", "connected");
  }
  return `${url.pathname}${url.search}${url.hash}`;
}
