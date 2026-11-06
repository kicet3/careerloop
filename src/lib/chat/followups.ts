import "server-only";
/**
 * 경험 그래프 후속 질문(graph_followups) 저장과 상태 전이. 모든 조회·수정은 userId 소유권을 확인한다(남의 질문은 '없음').
 *
 * - 쌓기(saveProposalFollowups): 그래프 채팅 변경안이 나오면 후보(followup-extract.ts)를 저장한다. 같은 프로젝트(미지정끼리도)의 열린 질문과
 *   정규화한 글(dedupe_key)이 같으면 새로 만들지 않는다. 사용자당 열린 질문은 MAX_OPEN_FOLLOWUPS개까지.
 * - 상태: open → answered(그 질문에 답한 변경안을 적용, 목표 구조화 항목이 완료, 또는 채팅 답변에서 LLM이 최근 메시지가 답했다고 표시 —
 *   markFollowupsAnswered) | skipped(건너뛰기). answered·skipped → open(다시 열기). 변경안을 거절해도 이미 답함으로 바뀐 질문은 그대로다.
 * - 적용 뒤(onProposalApplied): 새 Project의 ref로 귀속한 질문을 실제 id로 바꾸고, 답한 질문을 answered로, 이 변경안이 건드린 Project의
 *   목표 구조화 항목이 완료된 열린 질문도 answered로 바꾼다. 지운 Project의 질문은 미지정으로 옮긴다(Neo4j id라 외래 키가 없다).
 * - 거절·적용 실패(releasePendingRefs): 새 Project의 ref로 귀속한 그 변경안의 질문을 미지정으로 옮긴다(숨은 채 남지 않게).
 * 대화를 지우면 thread_id·source_message_id만 비고(ON DELETE SET NULL), 탈퇴하면 함께 지워진다(CASCADE).
 */
import { nanoid } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { CareerGraph } from "@/lib/domain/graph";
import {
  type FollowupCounts,
  type FollowupKind,
  type FollowupStatus,
  type GraphFollowup,
  MAX_OPEN_FOLLOWUPS,
  normalizeFollowupText,
} from "@/lib/domain/followups";
import { assessProjectStructure, type ProjectStructureItemId } from "@/lib/graph/project-structure";
import { type FollowupCandidate, structureItemOfQuestion } from "./followup-extract";

type Row = Prisma.GraphFollowupGetPayload<object>;

export function toFollowup(r: Row): GraphFollowup {
  return {
    id: r.id,
    projectNodeId: r.projectNodeId ?? null,
    threadId: r.threadId ?? null,
    sourceMessageId: r.sourceMessageId ?? null,
    kind: r.kind as FollowupKind,
    text: r.text,
    detail: r.detail ?? null,
    targetItem: (r.targetItem as ProjectStructureItemId | null) ?? null,
    status: r.status as FollowupStatus,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
    resolvedAt: r.resolvedAt?.getTime() ?? null,
  };
}

/**
 * 변경안의 후속 질문 후보를 저장한다. 이미 열린 같은 질문(같은 프로젝트·같은 dedupe_key)이 있으면 건너뛴다.
 * 새 Project의 ref에 귀속한 후보(projectRef)는 적용 때 id가 정해지므로 여기서는 그 변경안 안에서만 중복을 본다.
 * 돌려주는 값: 새로 만든 질문.
 */
export async function saveProposalFollowups(
  userId: string,
  input: { threadId: string | null; messageId: string | null; candidates: readonly FollowupCandidate[] },
): Promise<GraphFollowup[]> {
  if (input.candidates.length === 0) return [];
  // 상한은 보이는 열린 질문만 센다(새 Project ref에 귀속한 질문은 변경안 하나당 몇 개뿐이고 적용·거절 때 정리된다).
  const openCount = await prisma.graphFollowup.count({ where: { userId, status: "open", projectRef: null } });
  let room = MAX_OPEN_FOLLOWUPS - openCount;
  if (room <= 0) return [];
  const projectIds = [...new Set(input.candidates.map((c) => c.projectNodeId))];
  const existing = await prisma.graphFollowup.findMany({
    where: {
      userId,
      status: "open",
      projectRef: null,
      OR: [
        ...(projectIds.some((p) => p === null) ? [{ projectNodeId: null }] : []),
        { projectNodeId: { in: projectIds.filter((p): p is string => p !== null) } },
      ],
    },
    select: { projectNodeId: true, dedupeKey: true },
  });
  const seen = new Set(existing.map((e) => `${e.projectNodeId ?? ""}|${e.dedupeKey}`));
  const now = new Date();
  const rows: Prisma.GraphFollowupCreateManyInput[] = [];
  for (const c of input.candidates) {
    const text = stripNul(c.text).trim();
    const dedupeKey = normalizeFollowupText(text);
    if (!dedupeKey || room <= 0) continue;
    const key = c.projectRef ? `ref:${c.projectRef}|${dedupeKey}` : `${c.projectNodeId ?? ""}|${dedupeKey}`;
    if (seen.has(key)) continue;
    seen.add(key);
    room -= 1;
    rows.push({
      id: nanoid(),
      userId,
      projectNodeId: c.projectRef ? null : c.projectNodeId,
      projectRef: c.projectRef,
      threadId: input.threadId,
      sourceMessageId: input.messageId,
      kind: c.kind,
      text,
      detail: c.detail ? stripNul(c.detail) : null,
      targetItem: c.targetItem,
      dedupeKey,
      status: "open",
      // 같은 변경안 안의 순서를 지키려고 1ms씩 늘린다(목록은 created_at 순).
      createdAt: new Date(now.getTime() + rows.length),
      updatedAt: now,
    });
  }
  if (rows.length === 0) return [];
  await prisma.graphFollowup.createMany({ data: rows });
  const created = await prisma.graphFollowup.findMany({ where: { id: { in: rows.map((r) => r.id) } }, orderBy: { createdAt: "asc" } });
  return created.map(toFollowup);
}

export interface ListFollowupsQuery {
  /** Project 노드 id. null이면 프로젝트 미지정만. undefined면 모두. */
  projectNodeId?: string | null;
  statuses?: readonly FollowupStatus[];
  limit?: number;
}

/** 후속 질문 목록(오래된 것부터 — 묻는 순서). 새 Project ref에 귀속한(아직 적용 전) 질문은 뺀다. */
export async function listFollowups(userId: string, q: ListFollowupsQuery = {}): Promise<GraphFollowup[]> {
  const rows = await prisma.graphFollowup.findMany({
    where: {
      userId,
      projectRef: null,
      ...(q.projectNodeId !== undefined ? { projectNodeId: q.projectNodeId } : {}),
      ...(q.statuses ? { status: { in: [...q.statuses] } } : {}),
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    take: Math.min(Math.max(q.limit ?? 100, 1), 200),
  });
  return rows.map(toFollowup);
}

/**
 * 그래프 채팅 프롬프트에 넣을 열린 후속 질문(<open_followups>). 이 사용자의 열린·보이는(projectRef 없음) 질문만.
 * - 프로젝트 대화(focusProjectId): 그 프로젝트의 질문(오래된 것부터).
 * - 일반 대화: 답하는 질문(currentId)의 프로젝트 → 최근 메시지에서 이름이 나온 프로젝트(mentionedProjectIds) → 프로젝트 미지정 순.
 * 답하는 질문(currentId — 열린 질문일 때)은 맨 앞. limit개까지.
 */
export async function openFollowupsForPrompt(
  userId: string,
  scope: { focusProjectId: string | null; mentionedProjectIds?: readonly string[]; currentId?: string | null },
  limit: number,
): Promise<GraphFollowup[]> {
  if (limit <= 0) return [];
  const base = { userId, status: "open", projectRef: null } as const;
  const order = [{ createdAt: "asc" as const }, { id: "asc" as const }];
  let rows: Row[];
  if (scope.focusProjectId) {
    rows = await prisma.graphFollowup.findMany({ where: { ...base, projectNodeId: scope.focusProjectId }, orderBy: order, take: limit + 1 });
  } else {
    const current = scope.currentId ? await prisma.graphFollowup.findFirst({ where: { ...base, id: scope.currentId } }) : null;
    const projects = [...new Set([...(current?.projectNodeId ? [current.projectNodeId] : []), ...(scope.mentionedProjectIds ?? [])])];
    const projectRows = projects.length
      ? await prisma.graphFollowup.findMany({ where: { ...base, projectNodeId: { in: projects } }, orderBy: order, take: limit * 2 })
      : [];
    // 프로젝트 순서(답하는 질문의 프로젝트 → 언급 순)를 지킨다.
    projectRows.sort((a, b) => projects.indexOf(a.projectNodeId!) - projects.indexOf(b.projectNodeId!));
    const unassigned = await prisma.graphFollowup.findMany({ where: { ...base, projectNodeId: null }, orderBy: order, take: limit + 1 });
    rows = [...(current ? [current] : []), ...projectRows, ...unassigned];
  }
  if (scope.currentId && scope.focusProjectId) {
    const i = rows.findIndex((r) => r.id === scope.currentId);
    if (i > 0) rows.unshift(...rows.splice(i, 1));
  }
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.id) && seen.add(r.id)).slice(0, limit).map(toFollowup);
}

/**
 * 채팅 답변에서 답했다고 표시한 질문을 answered로 바꾼다(이 사용자의 열린·보이는 질문만 — 남의 질문·이미 처리된 질문은 건너뛴다).
 * 돌려주는 값: 실제로 바꾼 id(입력 순서).
 */
export async function markFollowupsAnswered(userId: string, ids: readonly string[]): Promise<string[]> {
  const unique = [...new Set(ids)];
  if (unique.length === 0) return [];
  const now = new Date();
  const done: string[] = [];
  for (const id of unique) {
    const res = await prisma.graphFollowup.updateMany({
      where: { id, userId, status: "open", projectRef: null },
      data: { status: "answered", resolvedAt: now, updatedAt: now },
    });
    if (res.count > 0) done.push(id);
  }
  return done;
}

/** 이 사용자 질문들의 지금 상태와 처리 시각(id → {status, resolvedAt ms}). 없는 id는 빠진다. */
export async function followupStatuses(
  userId: string,
  ids: readonly string[],
): Promise<Map<string, { status: FollowupStatus; resolvedAt: number | null }>> {
  if (ids.length === 0) return new Map();
  const rows = await prisma.graphFollowup.findMany({
    where: { userId, id: { in: [...new Set(ids)] } },
    select: { id: true, status: true, resolvedAt: true },
  });
  return new Map(rows.map((r) => [r.id, { status: r.status as FollowupStatus, resolvedAt: r.resolvedAt?.getTime() ?? null }]));
}

/** 열린 후속 질문 수(프로젝트별·미지정). */
export async function followupCounts(userId: string): Promise<FollowupCounts> {
  const groups = await prisma.graphFollowup.groupBy({
    by: ["projectNodeId"],
    where: { userId, status: "open", projectRef: null },
    _count: { _all: true },
  });
  const out: FollowupCounts = { byProject: {}, unassigned: 0 };
  for (const g of groups) {
    if (g.projectNodeId) out.byProject[g.projectNodeId] = g._count._all;
    else out.unassigned += g._count._all;
  }
  return out;
}

export async function getFollowup(userId: string, id: string): Promise<GraphFollowup | null> {
  const row = await prisma.graphFollowup.findFirst({ where: { id, userId } });
  return row ? toFollowup(row) : null;
}

async function requireFollowup(userId: string, id: string): Promise<Row> {
  const row = await prisma.graphFollowup.findFirst({ where: { id, userId } });
  if (!row) throw new FeatureError("후속 질문을 찾을 수 없습니다.", 404);
  return row;
}

/** 같은 프로젝트에 같은 글의 열린 질문이 (이 질문 말고) 있는가. */
async function hasOpenDuplicate(userId: string, projectNodeId: string | null, dedupeKey: string, exceptId: string): Promise<boolean> {
  const dup = await prisma.graphFollowup.findFirst({
    where: { userId, projectNodeId, projectRef: null, dedupeKey, status: "open", id: { not: exceptId } },
    select: { id: true },
  });
  return dup !== null;
}

/**
 * 상태 바꾸기: skipped(건너뛰기)·answered(답함)·open(다시 열기). 같은 상태면 그대로 돌려준다.
 * 다시 열 때 같은 프로젝트에 같은 글의 열린 질문이 이미 있으면 409.
 */
export async function setFollowupStatus(userId: string, id: string, status: FollowupStatus): Promise<GraphFollowup> {
  const row = await requireFollowup(userId, id);
  if (row.status === status) return toFollowup(row);
  if (status === "open" && (await hasOpenDuplicate(userId, row.projectNodeId, row.dedupeKey, id))) {
    throw new FeatureError("같은 후속 질문이 이미 열려 있습니다.", 409);
  }
  const now = new Date();
  const updated = await prisma.graphFollowup.update({
    where: { id },
    data: { status, updatedAt: now, resolvedAt: status === "open" ? null : now },
  });
  return toFollowup(updated);
}

/**
 * 프로젝트 지정·변경(projectNodeId null이면 미지정으로). Project가 그래프에 있어야 한다(graph로 확인 — 없으면 404).
 * 옮길 프로젝트에 같은 글의 열린 질문이 있으면 409. 질문(kind='question')이면 구조화 항목을 다시 정한다.
 */
export async function assignFollowupProject(
  userId: string,
  id: string,
  projectNodeId: string | null,
  graph: CareerGraph | null,
): Promise<GraphFollowup> {
  const row = await requireFollowup(userId, id);
  if (projectNodeId !== null && (!graph || !assessProjectStructure(graph, projectNodeId))) {
    throw new FeatureError("프로젝트를 찾을 수 없습니다. 그래프를 새로 고친 뒤 다시 시도해 주세요.", 404);
  }
  if (row.projectNodeId === projectNodeId && row.projectRef === null) return toFollowup(row);
  if (row.status === "open" && (await hasOpenDuplicate(userId, projectNodeId, row.dedupeKey, id))) {
    throw new FeatureError("그 프로젝트에 같은 후속 질문이 이미 있습니다.", 409);
  }
  // 뺀 항목에서 만든 질문은 특정 노드·값에 대한 것이라 체크리스트 상태로 판정하지 않는다(targetItem 없음).
  const targetItem = projectNodeId !== null && row.kind === "question" ? structureItemOfQuestion(row.text) : null;
  const updated = await prisma.graphFollowup.update({
    where: { id },
    data: { projectNodeId, projectRef: null, targetItem, updatedAt: new Date() },
  });
  return toFollowup(updated);
}

/**
 * 질문들을 프로젝트 미지정으로 옮긴다(목표 구조화 항목도 지운다). 미지정에 같은 글의 열린 질문이 이미 있으면 옮긴 열린 질문은 건너뜀으로.
 */
async function moveToUnassigned(userId: string, rows: readonly Row[], now: Date): Promise<void> {
  for (const r of rows) {
    const dup = r.status === "open" && (await hasOpenDuplicate(userId, null, r.dedupeKey, r.id));
    await prisma.graphFollowup.update({
      where: { id: r.id },
      data: { projectNodeId: null, projectRef: null, targetItem: null, updatedAt: now, ...(dup ? { status: "skipped", resolvedAt: now } : {}) },
    });
  }
}

/** 거절·적용 실패한 변경안: 그 변경안이 새로 만들려던 Project의 ref에 귀속한 질문을 미지정으로 옮긴다. */
export async function releasePendingRefs(userId: string, messageId: string): Promise<void> {
  const rows = await prisma.graphFollowup.findMany({ where: { userId, sourceMessageId: messageId, projectRef: { not: null } } });
  if (rows.length > 0) await moveToUnassigned(userId, rows, new Date());
}

/** 지운 노드 중 Project였던 것의 (답하지 않은) 질문을 미지정으로 옮긴다. 노드 id는 사용자마다 고유하니 그래프를 다시 읽지 않는다. */
export async function releaseDeletedProjectFollowups(userId: string, deletedNodeIds: readonly string[]): Promise<void> {
  if (deletedNodeIds.length === 0) return;
  const rows = await prisma.graphFollowup.findMany({
    where: { userId, projectNodeId: { in: [...deletedNodeIds] }, status: { in: ["open", "skipped"] } },
  });
  if (rows.length > 0) await moveToUnassigned(userId, rows, new Date());
}

/**
 * 변경안을 적용한 뒤:
 * (1) 지운 Project의 질문을 미지정으로,
 * (2) 새 Project ref에 귀속한 이 변경안의 질문을 실제 id로(created: ref → id, 기존 Project로 합쳐졌으면 그 id. 이미 같은 열린 질문이 있으면 건너뜀으로),
 * (3) 이 변경안이 답한 질문(followupId)을 answered로,
 * (4) 이 변경안이 건드린 Project(touchedNodeIds — 연산이 직접 가리킨 노드)의 목표 구조화 항목이 있는 열린 질문이 있으면 loadGraph로
 *     적용 뒤 그래프를 읽어 그 항목이 완료된 질문을 answered로(그래프를 못 읽으면 넘어간다).
 * 돌려주는 값: answered로 바꾼 질문 id.
 */
export async function onProposalApplied(
  userId: string,
  input: {
    messageId: string;
    created: Record<string, string>;
    followupId?: string | null;
    touchedNodeIds?: readonly string[];
    deletedNodeIds?: readonly string[];
    loadGraph?: () => Promise<CareerGraph | null>;
  },
): Promise<string[]> {
  const now = new Date();
  const deleted = new Set(input.deletedNodeIds ?? []);
  await releaseDeletedProjectFollowups(userId, [...deleted]);

  const pendingRefs = await prisma.graphFollowup.findMany({ where: { userId, sourceMessageId: input.messageId, projectRef: { not: null } } });
  const unresolved: Row[] = [];
  for (const r of pendingRefs) {
    const id = input.created[r.projectRef!];
    if (!id || deleted.has(id)) {
      // 그 프로젝트가 만들어지지 않았다(변경안에서 빠짐): 미지정으로 남긴다.
      unresolved.push(r);
      continue;
    }
    const dup = r.status === "open" && (await hasOpenDuplicate(userId, id, r.dedupeKey, r.id));
    await prisma.graphFollowup.update({
      where: { id: r.id },
      data: { projectNodeId: id, projectRef: null, updatedAt: now, ...(dup ? { status: "skipped", resolvedAt: now } : {}) },
    });
  }
  if (unresolved.length > 0) await moveToUnassigned(userId, unresolved, now);

  const answered: string[] = [];
  if (input.followupId) {
    const res = await prisma.graphFollowup.updateMany({
      where: { id: input.followupId, userId, status: "open" },
      data: { status: "answered", resolvedAt: now, updatedAt: now },
    });
    if (res.count > 0) answered.push(input.followupId);
  }

  const touched = (input.touchedNodeIds ?? []).filter((id) => !deleted.has(id));
  const targeted =
    input.loadGraph && touched.length > 0
      ? await prisma.graphFollowup.findMany({
          where: { userId, status: "open", projectRef: null, projectNodeId: { in: touched }, targetItem: { not: null } },
          select: { id: true, projectNodeId: true, targetItem: true },
          take: 500,
        })
      : [];
  const graphAfter = targeted.length > 0 ? await input.loadGraph!().catch(() => null) : null;
  if (graphAfter) {
    const structures = new Map<string, ReturnType<typeof assessProjectStructure>>();
    const done: string[] = [];
    for (const t of targeted) {
      const pid = t.projectNodeId!;
      if (!structures.has(pid)) structures.set(pid, assessProjectStructure(graphAfter, pid));
      const item = structures.get(pid)?.items.find((i) => i.id === t.targetItem);
      if (item?.state === "done") done.push(t.id);
    }
    if (done.length > 0) {
      await prisma.graphFollowup.updateMany({
        where: { id: { in: done }, userId, status: "open" },
        data: { status: "answered", resolvedAt: now, updatedAt: now },
      });
      answered.push(...done);
    }
  }
  return answered;
}

export interface FollowupPatch {
  status?: FollowupStatus;
  /** 프로젝트 지정(null이면 미지정으로). */
  projectNodeId?: string | null;
}

/**
 * 라우트용: 프로젝트 지정(그래프에서 Project인지 확인) → 상태 바꾸기 순서로 적용한다. 바꿀 것이 없으면 400.
 * getGraph는 프로젝트를 지정할 때만 부른다.
 */
export async function updateFollowup(
  userId: string,
  id: string,
  patch: FollowupPatch,
  deps: { getGraph(userId: string): Promise<CareerGraph> },
): Promise<GraphFollowup> {
  if (patch.status === undefined && patch.projectNodeId === undefined) throw new FeatureError("바꿀 내용이 없습니다.", 400);
  let out: GraphFollowup | null = null;
  if (patch.projectNodeId !== undefined) {
    const graph = patch.projectNodeId === null ? null : await deps.getGraph(userId);
    out = await assignFollowupProject(userId, id, patch.projectNodeId, graph);
  }
  if (patch.status !== undefined) out = await setFollowupStatus(userId, id, patch.status);
  return out!;
}
