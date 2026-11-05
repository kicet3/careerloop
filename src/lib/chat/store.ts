import "server-only";
/**
 * 채팅 스레드·메시지 저장(PostgreSQL). 모든 조회·수정은 userId 소유권을 확인한다 — 남의 스레드는 '없음'(null/false)으로 본다.
 */
import { nanoid } from "nanoid";
import { Prisma, prisma, type Db } from "@/lib/db/client";
import { stripNul, stripNulDeep } from "@/lib/db/errors";
import type { ChatMessageRow, ChatThreadRow, UsageTotals } from "@/lib/db/types";
import type { ChatMessage, ChatMessageData, ChatMessageStatus, ChatRole, ChatThread, ChatThreadKind } from "@/lib/domain/chat";
import type { ReviewerId } from "@/lib/domain/schemas";

type ThreadModel = Prisma.ChatThreadGetPayload<object>;
type MessageModel = Prisma.ChatMessageGetPayload<object>;
const asThread = (row: ThreadModel) => row as ChatThreadRow;
const asMessage = (row: MessageModel) => row as unknown as ChatMessageRow;

/** JSON 컬럼에 쓸 값. null·undefined는 SQL NULL(Prisma.DbNull), 문자열의 NUL은 지운다. */
function jsonValue(v: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return v === undefined || v === null ? Prisma.DbNull : (stripNulDeep(v) as Prisma.InputJsonValue);
}

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
  const row = await prisma.chatThread.create({
    data: {
      id: nanoid(),
      userId: input.userId,
      kind: input.kind,
      title: stripNul(input.title).slice(0, 200),
      diagnosisId: input.diagnosisId ?? null,
      reviewer: input.reviewer ?? null,
      createdAt: now,
      updatedAt: now,
    },
  });
  return toChatThread(asThread(row));
}

/** 소유자가 아니면 null. */
export async function getThread(userId: string, threadId: string): Promise<ChatThread | null> {
  const row = await prisma.chatThread.findFirst({ where: { id: threadId, userId } });
  return row ? toChatThread(asThread(row)) : null;
}

/** 최근 갱신 순. diagnosisId·reviewer를 주면 그 진단·심사위원의 스레드만. */
export async function listThreads(
  userId: string,
  filter: { kind?: ChatThreadKind; diagnosisId?: string | null; reviewer?: ReviewerId | null; limit?: number } = {},
): Promise<ChatThread[]> {
  const where: Prisma.ChatThreadWhereInput = { userId };
  if (filter.kind) where.kind = filter.kind;
  if (filter.diagnosisId !== undefined) where.diagnosisId = filter.diagnosisId;
  if (filter.reviewer !== undefined) where.reviewer = filter.reviewer;
  const rows = await prisma.chatThread.findMany({
    where,
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    take: Math.min(filter.limit ?? 50, 200),
  });
  return rows.map((r) => toChatThread(asThread(r)));
}

export async function renameThread(userId: string, threadId: string, title: string): Promise<boolean> {
  const res = await prisma.chatThread.updateMany({
    where: { id: threadId, userId },
    data: { title: stripNul(title).slice(0, 200), updatedAt: new Date() },
  });
  return res.count > 0;
}

/** 메시지도 함께 지운다(FK ON DELETE CASCADE). 소유자가 아니거나 없으면 false. */
export async function deleteThread(userId: string, threadId: string): Promise<boolean> {
  const res = await prisma.chatThread.deleteMany({ where: { id: threadId, userId } });
  return res.count > 0;
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
     * 지정하면 스레드의 마지막 메시지 id가 이것일 때만(null이면 메시지가 하나도 없을 때만) 넣는다 — 스레드 행 잠금(FOR UPDATE) 트랜잭션 안에서 검사하고 넣으므로
     * 동시 요청 중 하나만 성공한다. 조건이 맞지 않으면 ConcurrentMessageError.
     */
    expectLastId?: string | null;
  } = {},
): Promise<ChatMessage | null> {
  const thread = await getThread(userId, input.threadId);
  if (!thread) return null;
  return prisma.$transaction(async (tx) => {
    // 스레드 행을 잠가 같은 스레드에 동시에 쓰는 요청을 줄 세운다(READ COMMITTED에서 '마지막 메시지' 검사와 createdAt 계산이
    // 겹치지 않게). 그 사이 스레드가 지워졌으면 null.
    const locked = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM chat_threads WHERE id = ${input.threadId} FOR UPDATE`;
    if (locked.length === 0) return null;
    const last = await tx.chatMessage.findFirst({
      where: { threadId: input.threadId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true, createdAt: true },
    });
    if (opts.expectLastId !== undefined && (last?.id ?? null) !== opts.expectLastId) throw new ConcurrentMessageError();
    const now = new Date(Math.max(Date.now(), (last?.createdAt.getTime() ?? 0) + 1));
    const row = await insertMessage(tx, input, now);
    await tx.chatThread.update({ where: { id: input.threadId }, data: { updatedAt: now } });
    return toChatMessage(asMessage(row));
  });
}

function insertMessage(db: Db, input: Parameters<typeof addMessage>[1], createdAt: Date): Promise<MessageModel> {
  return db.chatMessage.create({
    data: {
      id: nanoid(),
      threadId: input.threadId,
      role: input.role,
      content: stripNul(input.content),
      data: jsonValue(input.data),
      status: input.status ?? null,
      usage: jsonValue(input.usage),
      createdAt,
    },
  });
}

/** addMessage(expectLastId)의 조건(마지막 메시지)이 맞지 않았다 — 다른 요청이 먼저 메시지를 넣었다. */
export class ConcurrentMessageError extends Error {
  constructor() {
    super("다른 요청이 먼저 메시지를 남겼습니다.");
    this.name = "ConcurrentMessageError";
  }
}

/** 오래된 순. limit을 주면 가장 최근 limit개(오래된 순으로 정렬해 반환). 소유자가 아니면 null. */
export async function listMessages(userId: string, threadId: string, opts: { limit?: number } = {}): Promise<ChatMessage[] | null> {
  const thread = await getThread(userId, threadId);
  if (!thread) return null;
  if (opts.limit !== undefined) {
    const rows = await prisma.chatMessage.findMany({
      where: { threadId },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: opts.limit,
    });
    return rows.reverse().map((r) => toChatMessage(asMessage(r)));
  }
  const rows = await prisma.chatMessage.findMany({ where: { threadId }, orderBy: [{ createdAt: "asc" }, { id: "asc" }] });
  return rows.map((r) => toChatMessage(asMessage(r)));
}

/** 소유자가 아니거나 없으면 null. */
export async function getMessage(userId: string, messageId: string): Promise<ChatMessage | null> {
  const row = await prisma.chatMessage.findFirst({ where: { id: messageId, thread: { userId } } });
  return row ? toChatMessage(asMessage(row)) : null;
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
  const where: Prisma.ChatMessageWhereInput = { id: messageId };
  if (opts.expectStatus !== undefined) where.status = opts.expectStatus;
  const data: Prisma.ChatMessageUpdateManyMutationInput = {};
  if (patch.status !== undefined) data.status = patch.status;
  if (patch.data !== undefined) data.data = jsonValue(patch.data);
  if (patch.content !== undefined) data.content = stripNul(patch.content);
  if (Object.keys(data).length === 0) return current;
  const res = await prisma.chatMessage.updateMany({ where, data });
  if (res.count === 0) return null;
  const row = await prisma.chatMessage.findUnique({ where: { id: messageId } });
  return row ? toChatMessage(asMessage(row)) : null;
}
