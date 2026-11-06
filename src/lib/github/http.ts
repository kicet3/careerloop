import "server-only";
/**
 * GitHub 라우트 공용: 설정 확인(없으면 503 github_unavailable), 오류 응답({ error, code }), 저장소 상세 응답 만들기.
 */
import { featureErrorResponse } from "@/lib/api/errors";
import { getCareerGraph, graphEnabled } from "@/lib/graph/service";
import { briefPreview } from "./brief";
import { matchRepoToProjects } from "./match";
import { githubConfig, type GithubConfig } from "./oauth";
import type { RepoSnapshot } from "./snapshots";
import { GithubError, GithubRateLimitError, GithubUnavailableError, type GithubRepoDetailView } from "./types";

const NO_STORE = { "Cache-Control": "no-store" };

export function githubJsonError(err: GithubError): Response {
  const headers: Record<string, string> = { ...NO_STORE };
  if (err instanceof GithubRateLimitError) headers["Retry-After"] = String(err.retryAfterSec);
  return Response.json({ error: err.message, code: err.code }, { status: err.status, headers });
}

/** GitHub 기능 오류는 { error, code }, 나머지는 featureErrorResponse. */
export function githubErrorResponse(err: unknown, context: string): Response {
  if (err instanceof GithubError) {
    if (err.status >= 500) console.warn(`[${context}] ${err.name}: ${(err as { detail?: string }).detail ?? err.message}`);
    return githubJsonError(err);
  }
  return featureErrorResponse(err, context);
}

/** 설정이 있으면 그 값, 없으면 503 응답. */
export function requireGithubConfigured(): GithubConfig | Response {
  const cfg = githubConfig();
  return cfg ?? githubJsonError(new GithubUnavailableError());
}

/** 저장소 상세 응답(그래프를 못 읽으면 match=null). */
export async function repoDetailView(userId: string, snapshot: RepoSnapshot): Promise<GithubRepoDetailView> {
  let match: GithubRepoDetailView["match"] = null;
  if (graphEnabled()) {
    try {
      const graph = await getCareerGraph(userId);
      const linked = snapshot.projectNodeId && graph.nodes.some((n) => n.id === snapshot.projectNodeId) ? snapshot.projectNodeId : null;
      match = matchRepoToProjects(graph, { fullName: snapshot.fullName, name: snapshot.facts.name, htmlUrl: snapshot.htmlUrl }, linked);
    } catch (err) {
      console.warn("[github] 그래프를 읽지 못해 프로젝트 후보 없이 보여 줍니다", err instanceof Error ? err.message : err);
    }
  }
  const f = snapshot.facts;
  return {
    repo: {
      id: snapshot.repoId,
      fullName: snapshot.fullName,
      htmlUrl: snapshot.htmlUrl,
      description: f.description,
      private: snapshot.private,
      fork: f.fork,
      archived: f.archived,
      stars: f.stars,
      language: f.primaryLanguage,
      pushedAt: f.pushedAt,
      fetchedAt: snapshot.fetchedAt.getTime(),
    },
    myCommits: f.my.commitCount,
    warnings: f.warnings,
    briefChars: snapshot.brief.length,
    briefPreview: briefPreview(snapshot.brief),
    match,
    linkedProjectId: snapshot.projectNodeId,
  };
}

export const githubNoStore = NO_STORE;
