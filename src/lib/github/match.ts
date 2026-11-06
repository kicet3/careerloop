/**
 * GitHub 저장소 ↔ 경험 그래프 Project 노드 맞추기(순수). 사용자가 최종 확인한다(맞는 프로젝트 / 다른 후보 / 새 프로젝트).
 * (a) 이미 이은 프로젝트(snapshot.project_node_id)가 그래프에 있으면 자동,
 * (b) Project.url이 같은 저장소 주소면 자동,
 * (c) 프로젝트 이름이 저장소 이름(또는 -·_를 띄어 쓴 이름)과 같으면 0.8,
 * (d) 저장소 이름 낱말의 60% 이상이 프로젝트 이름에 있으면 0.5.
 */
import type { CareerGraph } from "@/lib/domain/graph";
import type { RepoMatch, RepoMatchCandidate } from "./types";

const MAX_CANDIDATES = 3;

/** github.com 저장소 주소 → "github.com/owner/repo"(소문자). 저장소 주소가 아니면 null. */
export function normalizeRepoUrl(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) return null;
  let v = raw.trim();
  if (!/^[a-z]+:\/\//i.test(v)) v = `https://${v}`;
  let url: URL;
  try {
    url = new URL(v);
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  if (host !== "github.com") return null;
  const [owner, repo] = url.pathname.split("/").filter(Boolean);
  if (!owner || !repo) return null;
  const name = repo.replace(/\.git$/i, "");
  if (!name) return null;
  return `github.com/${owner.toLowerCase()}/${name.toLowerCase()}`;
}

const norm = (s: string) => s.normalize("NFKC").toLowerCase().replace(/[\s.,·()\-_/'"`]+/g, "");
const humanize = (name: string) => name.replace(/[-_.]+/g, " ").replace(/([a-z])([A-Z])/g, "$1 $2").trim();
const words = (s: string) =>
  humanize(s)
    .normalize("NFKC")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length >= 2);

export function matchRepoToProjects(
  graph: Pick<CareerGraph, "nodes">,
  repo: { fullName: string; name: string; htmlUrl: string },
  linkedNodeId: string | null,
): RepoMatch {
  const projects = graph.nodes.filter((n) => n.label === "Project");
  const repoUrl = normalizeRepoUrl(repo.htmlUrl) ?? normalizeRepoUrl(`github.com/${repo.fullName}`);
  const repoNorm = norm(repo.name);
  const repoHuman = norm(humanize(repo.name));
  const repoWords = words(repo.name);
  const scored: RepoMatchCandidate[] = [];
  let autoNodeId: string | null = null;

  for (const p of projects) {
    const props = p.props as { name?: string; url?: string };
    const name = props.name ?? "";
    if (linkedNodeId && p.id === linkedNodeId) {
      autoNodeId = p.id;
      scored.push({ nodeId: p.id, name, score: 1, reason: "이미 이 저장소와 연결된 프로젝트" });
      continue;
    }
    if (repoUrl && normalizeRepoUrl(props.url) === repoUrl) {
      autoNodeId ??= p.id;
      scored.push({ nodeId: p.id, name, score: 1, reason: "프로젝트 주소가 이 저장소" });
      continue;
    }
    const n = norm(name);
    if (n && (n === repoNorm || n === repoHuman)) {
      scored.push({ nodeId: p.id, name, score: 0.8, reason: "이름이 저장소 이름과 같음" });
      continue;
    }
    if (repoWords.length > 0) {
      const nameWords = words(name);
      const nameNorm = norm(name);
      const hit = repoWords.filter((w) => nameWords.includes(w) || nameNorm.includes(w)).length;
      if (hit / repoWords.length >= 0.6) scored.push({ nodeId: p.id, name, score: 0.5, reason: "이름이 저장소 이름과 비슷함" });
    }
  }
  scored.sort((a, b) => b.score - a.score || a.name.localeCompare(b.name, "ko"));
  // 자동 연결 대상은 맨 앞에 둔다(링크가 있으면 링크가 먼저).
  if (autoNodeId) {
    const i = scored.findIndex((c) => c.nodeId === autoNodeId);
    if (i > 0) scored.unshift(...scored.splice(i, 1));
  }
  return { autoNodeId, candidates: scored.slice(0, MAX_CANDIDATES) };
}
