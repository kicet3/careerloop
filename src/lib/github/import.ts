import "server-only";
/**
 * GitHub 저장소로 프로젝트 정리 시작(POST /api/graph/chat/github-import): 저장소 정보(snapshot) 확인 → 프로젝트 고르기·만들기
 * → 저장소 연결 → 그 프로젝트 대화(프로젝트 단위 스레드) 열기 → 사용자 메시지(data.kind='repo-import') 저장. 답변(변경안·후속 질문)은
 * runGraphChatReply의 repo-import 분기가 백그라운드에서 만든다(graph-chat.ts). 저장소 요약은 메시지에 싣지 않는다(snapshot에만).
 */
import { createHash } from "node:crypto";
import { FeatureError } from "@/lib/api/errors";
import { GITHUB_IMPORT_LIMIT, GRAPH_CHAT_LIMIT } from "@/lib/auth/db-rate-limit";
import {
  assertWithinLimit,
  defaultGraphChatDeps,
  type GraphChatDeps,
  openFocusedGraphThread,
  startUserMessage,
} from "@/lib/chat/graph-chat";
import type { ChatMessage, ChatThread, RepoImportData } from "@/lib/domain/chat";
import { PERSON_ID, type GraphOp } from "@/lib/domain/graph";
import { assessProjectStructure } from "@/lib/graph/project-structure";
import { graphEnabled, GraphUnavailableError } from "@/lib/graph/service";
import { normalizeRepoUrl } from "./match";
import { getOrFetchSnapshot, type GithubSnapshotDeps, linkSnapshotToProject } from "./snapshots";
import { parseFullName } from "./types";

export interface StartGithubImportInput {
  fullName: string;
  /** 이을 Project 노드 id, 또는 "new"(저장소 이름으로 새 프로젝트를 만든다). */
  projectNodeId: string;
  /** true면 저장소 정보를 GitHub에서 새로 읽는다('새 정보로 다시 정리'). */
  refresh?: boolean;
  /** 지금 보고 있는 프로젝트 대화(그 프로젝트 대화일 때만 쓴다 — 아니면 그 프로젝트의 가장 최근 대화). */
  threadId?: string | null;
}

export interface StartGithubImportResult {
  thread: ChatThread;
  message: ChatMessage;
  projectNodeId: string;
  /** 새 프로젝트를 만들었는가. */
  created: boolean;
}

export type GithubImportDeps = Pick<GraphChatDeps, "getGraph" | "applyOps" | "now"> & GithubSnapshotDeps;

const defaultDeps: GithubImportDeps = defaultGraphChatDeps;

export async function startGithubImport(
  userId: string,
  input: StartGithubImportInput,
  deps: GithubImportDeps = defaultDeps,
): Promise<StartGithubImportResult> {
  if (!graphEnabled()) throw new GraphUnavailableError();
  const target = parseFullName(input.fullName);
  if (!target) throw new FeatureError("저장소 이름(owner/repo)이 올바르지 않습니다.", 400);
  const isNew = input.projectNodeId === "new";
  if (!isNew && !/^[A-Za-z0-9_-]{1,64}$/.test(input.projectNodeId)) throw new FeatureError("프로젝트를 찾을 수 없습니다.", 404);

  const { snapshot } = await getOrFetchSnapshot(userId, target, { force: input.refresh === true }, deps);
  let graph = await deps.getGraph(userId, null);
  if (!isNew && !assessProjectStructure(graph, input.projectNodeId)) {
    throw new FeatureError("프로젝트를 찾을 수 없습니다. 그래프를 새로 고친 뒤 다시 시도해 주세요.", 404);
  }
  // 하루 상한은 그래프를 바꾸기 전에 센다(새 프로젝트만 남고 대화가 시작되지 않는 일이 없게).
  await assertWithinLimit(GITHUB_IMPORT_LIMIT, userId);

  let projectNodeId: string;
  if (isNew) {
    const ops: GraphOp[] = [
      { op: "addNode", ref: "new:repo", label: "Project", props: { name: snapshot.facts.name.slice(0, 120), url: snapshot.htmlUrl } },
      { op: "addEdge", type: "WORKED_ON", from: PERSON_ID, to: "new:repo" },
    ];
    const result = await deps.applyOps(userId, ops);
    const id = result.created["new:repo"];
    if (!id) throw new FeatureError("프로젝트를 만들지 못했습니다. 다시 시도해 주세요.", 500);
    projectNodeId = id;
    await linkSnapshotToProject(userId, snapshot.id, projectNodeId);
  } else {
    projectNodeId = input.projectNodeId;
    await linkSnapshotToProject(userId, snapshot.id, projectNodeId);
    const node = graph.nodes.find((n) => n.id === projectNodeId);
    const url = (node?.props as { url?: string } | undefined)?.url;
    // 프로젝트 주소가 비어 있으면 저장소 주소를 넣는다(다른 주소가 있으면 그대로 둔다).
    if (node && !url && normalizeRepoUrl(snapshot.htmlUrl)) {
      await deps.applyOps(userId, [{ op: "updateNode", id: projectNodeId, label: "Project", props: { url: snapshot.htmlUrl } }]);
    }
  }
  graph = await deps.getGraph(userId, null);
  const { thread } = await openFocusedGraphThread(userId, projectNodeId, { getGraph: async () => graph }, { preferThreadId: input.threadId });
  const data: RepoImportData = {
    kind: "repo-import",
    repoId: snapshot.repoId,
    fullName: snapshot.fullName,
    htmlUrl: snapshot.htmlUrl,
    private: snapshot.private,
    fetchedAt: snapshot.fetchedAt.getTime(),
    chars: snapshot.brief.length,
    briefSha256: createHash("sha256").update(snapshot.brief).digest("hex"),
  };
  const content = `GitHub 저장소 ${snapshot.fullName}${snapshot.private ? "(비공개)" : ""}의 정보로 이 프로젝트를 정리해 주세요.`;
  const message = await startUserMessage(
    userId,
    thread.id,
    { content, data, title: `GitHub: ${snapshot.fullName}`, kind: "graph", limit: GRAPH_CHAT_LIMIT },
    deps,
  );
  return { thread, message, projectNodeId, created: isNew };
}
