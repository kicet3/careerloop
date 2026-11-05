import "server-only";
/**
 * 채팅 스레드·메시지 저장(SQLite). 모든 조회·수정은 userId 소유권을 확인한다 — 남의 스레드는 '없음'(null/false)으로 본다.
 * 라우트 핸들러는 호출 전에 ensureDatabase()를 부른다(다른 라우트와 같은 관례).
 */
import { and, asc, desc, eq, isNull, sql, type SQL } from "drizzle-orm";
import { nanoid } from "nanoid";
import { db } from "@/lib/db/client";
import { chatMessages, chatThreads, type ChatMessageRow, type ChatThreadRow, type UsageTotals } from "@/lib/db/schema";
import type { ChatMessage, ChatMessageData, ChatMessageStatus, ChatRole, ChatThread, ChatThreadKind } from "@/lib/domain/chat";
import type { ReviewerId } from "@/lib/domain/schemas";

export function toChatThread(row: ChatThreadRow): ChatThread {
  return {
    id: row.id,
    kind: row.kind,
    diagnosisId: row.diagnosisId ?? null,
    reviewer: row.reviewer ?? null,
    title: row.title,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

export function toChatMessage(row: ChatMessageRow): ChatMessage {
  return {
    id: row.id,
    threadId: row.threadId,
    role: row.role,
    content: row.content,
    data: row.data ?? null,
    status: row.status ?? null,
    createdAt: row.createdAt.getTime(),
  };
}

// ---------------------------------------------------------------------------
// 스레드
// ---------------------------------------------------------------------------

export async function createThread(input: {
  userId: string;
  kind: ChatThreadKind;
  title: string;
  diagnosisId?: string | null;
  reviewer?: ReviewerId | null;
}): Promise<ChatThread> {
  if (input.kind === "reviewer" && (!input.diagnosisId || !input.reviewer)) {
    throw new Error("심사위원 채팅에는 diagnosisId와 reviewer가 필요합니다");
  }
  const now = new Date();
  const [row] = await db
    .insert(chatThreads)
    .values({
      id: nanoid(),
      userId: input.userId,
      kind: input.kind,
      title: input.title.slice(0, 200),
      diagnosisId: input.diagnosisId ?? null,
      reviewer: input.reviewer ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return toChatThread(row!);
}

/** 소유자가 아니면 null. */
export async function getThread(userId: string, threadId: string): Promise<ChatThread | null> {
  const [row] = await db
    .select()
    .from(chatThreads)
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
  return row ? toChatThread(row) : null;
}

/** 최근 갱신 순. diagnosisId·reviewer를 주면 그 진단·심사위원의 스레드만. */
export async function listThreads(
  userId: string,
  filter: { kind?: ChatThreadKind; diagnosisId?: string | null; reviewer?: ReviewerId | null; limit?: number } = {},
): Promise<ChatThread[]> {
  const conds: SQL[] = [eq(chatThreads.userId, userId)];
  if (filter.kind) conds.push(eq(chatThreads.kind, filter.kind));
  if (filter.diagnosisId !== undefined) {
    conds.push(filter.diagnosisId === null ? isNull(chatThreads.diagnosisId) : eq(chatThreads.diagnosisId, filter.diagnosisId));
  }
  if (filter.reviewer !== undefined) {
    conds.push(filter.reviewer === null ? isNull(chatThreads.reviewer) : eq(chatThreads.reviewer, filter.reviewer));
  }
  const rows = await db
    .select()
    .from(chatThreads)
    .where(and(...conds))
    .orderBy(desc(chatThreads.updatedAt))
    .limit(Math.min(filter.limit ?? 50, 200));
  return rows.map(toChatThread);
}

export async function renameThread(userId: string, threadId: string, title: string): Promise<boolean> {
  const res = await db
    .update(chatThreads)
    .set({ title: title.slice(0, 200), updatedAt: new Date() })
    .where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)))
    .returning({ id: chatThreads.id });
  return res.length > 0;
}

/** 메시지도 함께 지운다(FK cascade + 명시 삭제). */
export async function deleteThread(userId: string, threadId: string): Promise<boolean> {
  const thread = await getThread(userId, threadId);
  if (!thread) return false;
  await db.delete(chatMessages).where(eq(chatMessages.threadId, threadId));
  await db.delete(chatThreads).where(and(eq(chatThreads.id, threadId), eq(chatThreads.userId, userId)));
  return true;
}

// ---------------------------------------------------------------------------
// 메시지
// ---------------------------------------------------------------------------

/**
 * 메시지를 추가하고 스레드 updatedAt을 갱신한다. 소유자가 아니면 null.
 * createdAt은 같은 밀리초에 연달아 쓰더라도 순서가 유지되도록 직전 메시지보다 크게 잡는다.
 */
export async function addMessage(
  userId: string,
  input: {
    threadId: string;
    role: ChatRole;
    content: string;
    data?: ChatMessageData | null;
    status?: ChatMessageStatus | null;
    usage?: UsageTotals | null;
  },
  opts: {
    /**
     * 지정하면 스레드의 마지막 메시지 id가 이것일 때만(null이면 메시지가 하나도 없을 때만) 넣는다 — 검사와 삽입이 한 문장이라
     * 동시 요청 중 하나만 성공한다. 조건이 맞지 않으면 ConcurrentMessageError.
     */
    expectLastId?: string | null;
  } = {},
): Promise<ChatMessage | null> {
  const thread = await getThread(userId, input.threadId);
  if (!thread) return null;
  if (opts.expectLastId !== undefined) return addMessageIfLast(input, opts.expectLastId);
  const [last] = await db
    .select({ createdAt: chatMessages.createdAt })
    .from(chatMessages)
    .where(eq(chatMessages.threadId, input.threadId))
    .orderBy(desc(chatMessages.createdAt))
    .limit(1);
  const now = new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1));
  const [row] = await db
    .insert(chatMessages)
    .values({
      id: nanoid(),
      threadId: input.threadId,
      role: input.role,
      content: input.content,
      data: input.data ?? null,
      status: input.status ?? null,
      usage: input.usage ?? null,
      createdAt: now,
    })
    .returning();
  await db.update(chatThreads).set({ updatedAt: now }).where(eq(chatThreads.id, input.threadId));
  return toChatMessage(row!);
}

/** addMessage(expectLastId)의 조건(마지막 메시지)이 맞지 않았다 — 다른 요청이 먼저 메시지를 넣었다. */
export class ConcurrentMessageError extends Error {
  constructor() {
    super("다른 요청이 먼저 메시지를 남겼습니다.");
    this.name = "ConcurrentMessageError";
  }
}

async function addMessageIfLast(
  input: Parameters<typeof addMessage>[1],
  expectLastId: string | null,
): Promise<ChatMessage> {
  const id = nanoid();
  const tid = input.threadId;
  const cond =
    expectLastId === null
      ? sql`NOT EXISTS (SELECT 1 FROM chat_messages WHERE thread_id = ${tid})`
      : sql`(SELECT id FROM chat_messages WHERE thread_id = ${tid} ORDER BY created_at DESC LIMIT 1) = ${expectLastId}`;
  const json = (v: unknown) => (v === undefined || v === null ? null : JSON.stringify(v));
  const rows = await db.all<{ id: string; created_at: number }>(sql`
    INSERT INTO chat_messages (id, thread_id, role, content, data, status, usage, created_at)
    SELECT ${id}, ${tid}, ${input.role}, ${input.content}, ${json(input.data)}, ${input.status ?? null}, ${json(input.usage)},
      MAX(${Date.now()}, COALESCE((SELECT MAX(created_at) FROM chat_messages WHERE thread_id = ${tid}), 0) + 1)
    WHERE ${cond}
    RETURNING id, created_at`);
  const inserted = rows[0];
  if (!inserted) throw new ConcurrentMessageError();
  await db.update(chatThreads).set({ updatedAt: new Date(Number(inserted.created_at)) }).where(eq(chatThreads.id, tid));
  const [row] = await db.select().from(chatMessages).where(eq(chatMessages.id, id)).limit(1);
  return toChatMessage(row!);
}

/** 오래된 순. limit을 주면 가장 최근 limit개(오래된 순으로 정렬해 반환). 소유자가 아니면 null. */
export async function listMessages(userId: string, threadId: string, opts: { limit?: number } = {}): Promise<ChatMessage[] | null> {
  const thread = await getThread(userId, threadId);
  if (!thread) return null;
  if (opts.limit !== undefined) {
    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.threadId, threadId))
      .orderBy(desc(chatMessages.createdAt))
      .limit(opts.limit);
    return rows.reverse().map(toChatMessage);
  }
  const rows = await db.select().from(chatMessages).where(eq(chatMessages.threadId, threadId)).orderBy(asc(chatMessages.createdAt));
  return rows.map(toChatMessage);
}

/** 소유자가 아니거나 없으면 null. */
export async function getMessage(userId: string, messageId: string): Promise<ChatMessage | null> {
  const [row] = await db
    .select({ m: chatMessages })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.threadId))
    .where(and(eq(chatMessages.id, messageId), eq(chatThreads.userId, userId)));
  return row ? toChatMessage(row.m) : null;
}

/**
 * 메시지 상태·데이터를 바꾼다(예: 변경안 proposed → applied). expectStatus를 주면 그 상태일 때만 바꾼다(중복 적용 방지).
 * 바뀐 메시지를 반환하고, 소유자가 아니거나 조건이 맞지 않으면 null.
 */
export async function updateMessage(
  userId: string,
  messageId: string,
  patch: { status?: ChatMessageStatus | null; data?: ChatMessageData | null; content?: string },
  opts: { expectStatus?: ChatMessageStatus | null } = {},
): Promise<ChatMessage | null> {
  const current = await getMessage(userId, messageId);
  if (!current) return null;
  const conds: SQL[] = [eq(chatMessages.id, messageId)];
  if (opts.expectStatus !== undefined) {
    conds.push(opts.expectStatus === null ? isNull(chatMessages.status) : eq(chatMessages.status, opts.expectStatus));
  }
  const set: Partial<typeof chatMessages.$inferInsert> = {};
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.data !== undefined) set.data = patch.data;
  if (patch.content !== undefined) set.content = patch.content;
  if (Object.keys(set).length === 0) return current;
  const [row] = await db.update(chatMessages).set(set).where(and(...conds)).returning();
  return row ? toChatMessage(row) : null;
}
