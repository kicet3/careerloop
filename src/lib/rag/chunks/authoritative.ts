import "server-only";
/**
 * 출처 재조회(§7.3) — 권위 원문을 출처 유형별 소유 조건으로 읽는다. 청크 행의 user_id·content는 믿지 않는다.
 * - repo-brief: github_repo_snapshots { id, userId: principal } → brief
 * - document-import: chat_messages { id, thread.userId: principal }, data.kind='document-import' → data.text
 * - portfolio-text: portfolios { id, userId: principal } → textKey가 users/<principal>/ 접두사일 때만 저장소에서 읽는다
 * 찾지 못하면 null. 같은 id가 다른 사용자 이름으로 있는지는 sourceExistsElsewhere(count만)로 따로 확인한다 — 결과는 보안 실패 여부만 정하고
 * LLM·로그·응답에 나가지 않는다.
 */
import { prisma } from "@/lib/db/client";
import type { DocumentImportData } from "@/lib/domain/chat";
import { parseGraphPortfolioSource } from "@/lib/domain/graph-portfolio";
import { portfolioHasText } from "@/lib/domain/portfolios";
import { sha256 } from "../hash";
import type { ChunkSourceType } from "./build";

export interface AuthoritativeSource {
  sourceType: ChunkSourceType;
  sourceId: string;
  /** 권위 원문 전체. */
  text: string;
  /** 출처 버전(색인 시점과 비교): repo=sha256(brief), document=message id, portfolio=textKey. */
  version: string;
  /** 사람이 읽을 출처 이름(화면·LLM 렌더용). */
  label: string;
  /** 출처가 가리키는 그래프 노드 후보(동기화 때 스냅샷과 교집합). */
  nodeCandidates: string[];
}

export type SourceReader = (principalUserId: string, sourceType: ChunkSourceType, sourceId: string) => Promise<AuthoritativeSource | null>;
export type SourceExistsElsewhere = (sourceType: ChunkSourceType, sourceId: string, principalUserId: string) => Promise<boolean>;

export const SOURCE_TYPE_LABEL: Record<ChunkSourceType, string> = {
  "repo-brief": "GitHub 저장소 요약",
  "document-import": "가져온 문서",
  "portfolio-text": "포트폴리오",
};

/** 저장소 읽기(R2·로컬). 테스트가 바꿔 낄 수 있게 동적 import. */
async function readObject(key: string): Promise<string | null> {
  const { getObject } = await import("@/lib/storage");
  const buf = await getObject(key);
  return buf ? buf.toString("utf8") : null;
}

export const readAuthoritativeSource: SourceReader = (principal, sourceType, sourceId) => readSource(principal, sourceType, sourceId, true);

/**
 * 인용 재검증용 가벼운 읽기: 같은 소유 조건, 노드 후보 조회 없음. 포트폴리오 글은 저장소를 읽지 않고 textKey(=출처 버전)만 돌려준다 —
 * 글을 바꾸면 키가 바뀌므로 키가 같으면 같은 글이다(키 접두사 확인 포함). 다른 출처는 본문을 돌려준다.
 */
export async function readAuthoritativeForCitation(
  principal: string,
  sourceType: ChunkSourceType,
  sourceId: string,
): Promise<{ version: string; text: string | null } | null> {
  if (!principal || !sourceId) return null;
  if (sourceType === "portfolio-text") {
    const row = await prisma.portfolio.findFirst({ where: { id: sourceId, userId: principal }, select: { kind: true, textKey: true } });
    if (!row || !portfolioHasText(row.kind) || !row.textKey || !row.textKey.startsWith(`users/${principal}/`)) return null;
    return { version: row.textKey, text: null };
  }
  const src = await readSource(principal, sourceType, sourceId, false);
  return src ? { version: src.version, text: src.text } : null;
}

async function readSource(principal: string, sourceType: ChunkSourceType, sourceId: string, withNodes: boolean): Promise<AuthoritativeSource | null> {
  if (!principal || !sourceId) return null;
  switch (sourceType) {
    case "repo-brief": {
      const row = await prisma.githubRepoSnapshot.findFirst({
        where: { id: sourceId, userId: principal },
        select: { id: true, brief: true, fullName: true, projectNodeId: true },
      });
      if (!row) return null;
      return {
        sourceType,
        sourceId: row.id,
        text: row.brief,
        version: sha256(row.brief),
        label: `${SOURCE_TYPE_LABEL[sourceType]} · ${row.fullName}`.slice(0, 120),
        nodeCandidates: row.projectNodeId ? [row.projectNodeId] : [],
      };
    }
    case "document-import": {
      const row = await prisma.chatMessage.findFirst({
        where: { id: sourceId, role: "user", thread: { userId: principal } },
        select: { id: true, threadId: true, data: true },
      });
      const data = row?.data as DocumentImportData | null | undefined;
      if (!row || !data || data.kind !== "document-import" || typeof data.text !== "string") return null;
      return {
        sourceType,
        sourceId: row.id,
        text: data.text,
        version: row.id,
        label: `${SOURCE_TYPE_LABEL[sourceType]} · ${(data.fileName ?? (data.docKind === "resume" ? "이력서" : "포트폴리오")).slice(0, 80)}`,
        nodeCandidates: withNodes ? await documentImportNodes(principal, row.threadId, row.id) : [],
      };
    }
    case "portfolio-text": {
      const row = await prisma.portfolio.findFirst({
        where: { id: sourceId, userId: principal },
        select: { id: true, kind: true, textKey: true, title: true, graphSource: true },
      });
      if (!row || !portfolioHasText(row.kind) || !row.textKey) return null;
      // 키가 이 사용자 접두사인지 한 번 더 본다(행의 user_id와 키가 어긋나면 남의 객체일 수 있다 — 읽지 않는다).
      if (!row.textKey.startsWith(`users/${principal}/`)) return null;
      const text = await readObject(row.textKey);
      if (text === null) return null;
      return {
        sourceType,
        sourceId: row.id,
        text,
        version: row.textKey,
        label: `${SOURCE_TYPE_LABEL[sourceType]} · ${row.title}`.slice(0, 120),
        nodeCandidates: parseGraphPortfolioSource(row.graphSource)?.projectIds ?? [],
      };
    }
  }
}

/** 가져온 문서 메시지 뒤, 같은 스레드에서 적용된 document-import 변경안이 만든 노드 id(스냅샷과 교집합은 호출자가). */
async function documentImportNodes(principal: string, threadId: string, messageId: string): Promise<string[]> {
  const msg = await prisma.chatMessage.findFirst({ where: { id: messageId, thread: { userId: principal } }, select: { createdAt: true } });
  if (!msg) return [];
  const later = await prisma.chatMessage.findMany({
    where: { threadId, thread: { userId: principal }, role: "assistant", status: "applied", createdAt: { gte: msg.createdAt } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { data: true },
    take: 20,
  });
  const ids: string[] = [];
  for (const m of later) {
    const d = m.data as { kind?: string; source?: string; created?: Record<string, string> } | null;
    if (d?.kind === "graph-proposal" && d.source === "document-import" && d.created) ids.push(...Object.values(d.created));
  }
  return [...new Set(ids)].slice(0, 200);
}

/** 같은 출처 id가 다른 사용자 이름으로 있는가(count만 — 행을 읽지 않는다). */
export const sourceExistsElsewhere: SourceExistsElsewhere = async (sourceType, sourceId, principal) => {
  switch (sourceType) {
    case "repo-brief":
      return (await prisma.githubRepoSnapshot.count({ where: { id: sourceId, NOT: { userId: principal } } })) > 0;
    case "document-import":
      return (await prisma.chatMessage.count({ where: { id: sourceId, NOT: { thread: { userId: principal } } } })) > 0;
    case "portfolio-text": {
      if ((await prisma.portfolio.count({ where: { id: sourceId, NOT: { userId: principal } } })) > 0) return true;
      // 본인 행인데 키가 남의 접두사(위조·버그)도 보안 실패로 본다.
      const own = await prisma.portfolio.findFirst({ where: { id: sourceId, userId: principal }, select: { textKey: true } });
      return !!own?.textKey && !own.textKey.startsWith(`users/${principal}/`);
    }
  }
};
