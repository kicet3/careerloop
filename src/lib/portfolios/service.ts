import "server-only";
/**
 * 포트폴리오 보관함(portfolios). 사용자마다 MAX_PORTFOLIOS_PER_USER개까지 보관하고, 이력서는 그중 하나를 첨부한다
 * (company_resumes.portfolio_id, 포트폴리오를 지우면 FK SET NULL로 떨어진다).
 *
 * - 파일은 원본을 보관하지 않고 ingest(src/lib/ingest/extract.ts)로 뽑은 텍스트만 저장소 users/<u>/portfolios/<id>/text-<꼬리>.txt에
 *   둔다(키는 portfolios.text_key). 예전 이력서 첨부에서 옮긴 항목은 users/<u>/resumes/<이력서 id>/portfolio-<꼬리>.txt를 쓴다 —
 *   이력서를 지울 때 그 키는 남기고(resumes/service.ts deleteResume), 포트폴리오를 지우거나 내용을 바꿀 때 지운다.
 * - 링크는 주소만 저장한다(서버가 그 주소를 열지 않는다).
 * - 모든 함수는 userId 소유권을 확인한다. 남의 포트폴리오는 null/false(라우트에서 404).
 * - 상한은 만들 때 사용자별 잠금 안에서 확인한다(createRow). 목록은 상한을 넘는 행(옛 첨부에서 옮긴 것)도 모두 보여 준다.
 * - 파일 읽기·레이트 리밋·업로드 크기 검사는 라우트(src/lib/portfolios/http.ts)가 한다. 여기는 저장만.
 */
import { randomUUID } from "node:crypto";
import { customAlphabet } from "nanoid";
import { FeatureError } from "@/lib/api/errors";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { PortfolioRow } from "@/lib/db/types";
import {
  MAX_PORTFOLIO_DESCRIPTION_CHARS,
  MAX_PORTFOLIO_TEXT_CHARS,
  MAX_PORTFOLIO_TITLE_CHARS,
  MAX_PORTFOLIO_URL_CHARS,
  MAX_PORTFOLIOS_PER_USER,
  PORTFOLIO_KINDS,
  type PortfolioInfo,
  type PortfolioListItem,
  type PortfolioResumeRef,
} from "@/lib/domain/portfolios";
import { deleteObject, getObject, listByPrefix, putObject, userKey, userPrefix } from "@/lib/storage";

// 저장소 키 조각은 영문·숫자로 시작해야 하므로 '-'·'_' 없는 알파벳을 쓴다(이력서 id와 같은 꼴).
const newId = customAlphabet("0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz", 16);

export const PORTFOLIO_NOT_FOUND = "포트폴리오를 찾을 수 없습니다.";

/**
 * 업로드마다 새 키를 쓴다. 같은 키를 다시 쓰면, 동시에 링크로 바꾸기·지우기가 옛 키를 지울 때 방금 올린 새 텍스트까지 지워
 * DB는 'file'인데 텍스트가 없는 상태가 된다. 키가 다르면 지우는 쪽은 늘 자기가 읽은 옛 텍스트만 지운다.
 */
export function portfolioTextKey(userId: string, portfolioId: string, nonce: string = newNonce()): string {
  return userKey(userId, "portfolios", portfolioId, `text-${nonce}.txt`);
}

function newNonce(): string {
  return `${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

/** 행 → 화면 정보. 모르는 종류 값은 'url'로 보지 않고 null 필드로 둔다(파일로 취급하지 않는다). */
export function toPortfolioInfo(row: PortfolioRow): PortfolioInfo {
  const kind = PORTFOLIO_KINDS.find((k) => k === row.kind) ?? "url";
  return {
    id: row.id,
    title: row.title,
    description: row.description ?? null,
    kind,
    fileName: kind === "file" ? (row.fileName ?? null) : null,
    url: kind === "url" ? (row.url ?? null) : null,
    chars: kind === "file" ? (row.chars ?? null) : null,
    createdAt: row.createdAt.getTime(),
    updatedAt: row.updatedAt.getTime(),
  };
}

function toResumeRef(r: { id: string; title: string; kind: string }): PortfolioResumeRef {
  return { id: r.id, title: r.title, kind: r.kind === "general" ? "general" : "company" };
}

async function ownedRow(userId: string, id: string): Promise<PortfolioRow | null> {
  return ((await prisma.portfolio.findFirst({ where: { id, userId } })) as PortfolioRow | null) ?? null;
}

async function dropText(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (err) {
    console.error("[portfolio] 텍스트 삭제 실패", key, err);
  }
}

function cleanTitle(raw: string | null | undefined): string {
  return stripNul((raw ?? "").trim()).slice(0, MAX_PORTFOLIO_TITLE_CHARS).trim();
}

function cleanDescription(raw: string | null | undefined): string | null {
  return stripNul((raw ?? "").trim()).slice(0, MAX_PORTFOLIO_DESCRIPTION_CHARS).trim() || null;
}

function cleanText(raw: string): { text: string; truncated: boolean } {
  const clean = stripNul(raw).trim();
  const truncated = clean.length > MAX_PORTFOLIO_TEXT_CHARS;
  return { text: truncated ? clean.slice(0, MAX_PORTFOLIO_TEXT_CHARS) : clean, truncated };
}

function cleanFileName(raw: string): string {
  return stripNul(raw.trim().slice(0, 200)) || "portfolio";
}

function cleanUrl(raw: string): string {
  return stripNul(raw.trim().slice(0, MAX_PORTFOLIO_URL_CHARS));
}

/** 이름을 비워 두면: 파일 이름, 링크는 호스트 이름. */
export function defaultPortfolioTitle(source: { fileName?: string | null; url?: string | null }): string {
  if (source.fileName?.trim()) return cleanTitle(source.fileName);
  if (source.url) {
    try {
      const host = new URL(source.url).hostname;
      if (host) return cleanTitle(host);
    } catch {}
  }
  return "포트폴리오";
}

function roomError(): FeatureError {
  return new FeatureError(`포트폴리오는 ${MAX_PORTFOLIOS_PER_USER}개까지 보관할 수 있습니다. 쓰지 않는 포트폴리오를 지워 주세요.`, 409);
}

/**
 * 새로 만들 자리가 있는지 미리 본다(잠금 없음). 업로드 라우트가 레이트 리밋·텍스트 추출 전에 불러 꽉 찬 사용자의 업로드 횟수와
 * 추출 시간을 아낀다. 실제 상한은 createRow가 잠금 안에서 다시 확인한다. 꽉 찼으면 FeatureError(409).
 */
export async function assertPortfolioRoom(userId: string): Promise<void> {
  const n = await prisma.portfolio.count({ where: { userId } });
  if (n >= MAX_PORTFOLIOS_PER_USER) throw roomError();
}

/**
 * 상한 확인과 행 만들기를 한 트랜잭션에서 한다. READ COMMITTED에서는 동시 요청이 모두 count를 통과할 수 있으므로
 * 사용자별 트랜잭션 advisory lock으로 줄 세운다(트랜잭션이 끝나면 풀려 Transaction pooler에서도 안전).
 */
async function createRow(userId: string, data: Omit<Prisma.PortfolioUncheckedCreateInput, "userId">): Promise<PortfolioRow> {
  return prisma.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`portfolio-create:${userId}`}))`;
    const n = await tx.portfolio.count({ where: { userId } });
    if (n >= MAX_PORTFOLIOS_PER_USER) throw roomError();
    return (await tx.portfolio.create({ data: { ...data, userId } })) as PortfolioRow;
  });
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/** 내 포트폴리오(최근 수정 순) + 각각을 첨부한 이력서. */
export async function listPortfolios(userId: string): Promise<PortfolioListItem[]> {
  const rows = await prisma.portfolio.findMany({
    where: { userId },
    // 상한(MAX_PORTFOLIOS_PER_USER)보다 많이 있을 수 있으므로(예전 이력서 첨부에서 옮긴 항목은 이력서 수만큼) 자르지 않는다 —
    // 보이지 않는 항목은 지울 수도 없다.
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
    include: { resumes: { select: { id: true, title: true, kind: true }, where: { userId }, orderBy: { updatedAt: "desc" } } },
  });
  return rows.map((r) => ({ ...toPortfolioInfo(r as PortfolioRow), resumes: r.resumes.map(toResumeRef) }));
}

export async function getPortfolio(userId: string, id: string): Promise<PortfolioListItem | null> {
  const row = await prisma.portfolio.findFirst({
    where: { id, userId },
    include: { resumes: { select: { id: true, title: true, kind: true }, where: { userId }, orderBy: { updatedAt: "desc" } } },
  });
  return row ? { ...toPortfolioInfo(row as PortfolioRow), resumes: row.resumes.map(toResumeRef) } : null;
}

/** 저장해 둔 텍스트(kind 'file'). 링크거나 저장소에서 사라졌으면 null. */
export async function readPortfolioText(row: Pick<PortfolioRow, "kind" | "textKey">): Promise<string | null> {
  if (row.kind !== "file" || !row.textKey) return null;
  const buf = await getObject(row.textKey);
  return buf ? buf.toString("utf8") : null;
}

/** 정보 + 텍스트(진단 프리필·미리보기). 남의 포트폴리오면 null. */
export async function getPortfolioText(userId: string, id: string): Promise<{ portfolio: PortfolioInfo; text: string | null } | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  return { portfolio: toPortfolioInfo(row), text: await readPortfolioText(row) };
}

// ---------------------------------------------------------------------------
// 만들기
// ---------------------------------------------------------------------------

export interface NewPortfolioMeta {
  title?: string | null;
  description?: string | null;
}

/**
 * 파일에서 뽑은 텍스트로 새 포트폴리오. 텍스트는 MAX_PORTFOLIO_TEXT_CHARS까지 저장한다(넘으면 truncated).
 * 텍스트를 먼저 저장하고 행을 만든다. 행을 못 만들면 방금 저장한 텍스트를 지운다.
 */
export async function createPortfolioFromFile(
  userId: string,
  input: NewPortfolioMeta & { fileName: string; text: string },
): Promise<{ portfolio: PortfolioInfo; truncated: boolean }> {
  await assertPortfolioRoom(userId);
  const id = newId();
  const fileName = cleanFileName(input.fileName);
  const { text, truncated } = cleanText(input.text);
  const key = portfolioTextKey(userId, id);
  await putObject(key, text, { contentType: "text/plain; charset=utf-8" });
  try {
    const row = await createRow(userId, {
      id,
      title: cleanTitle(input.title) || defaultPortfolioTitle({ fileName }),
      description: cleanDescription(input.description),
      kind: "file",
      fileName,
      textKey: key,
      chars: text.length,
    });
    return { portfolio: toPortfolioInfo(row), truncated };
  } catch (err) {
    await dropText(key);
    throw err;
  }
}

/** 링크로 새 포트폴리오. url은 호출자가 http/https 검증(PortfolioUrlSchema). */
export async function createPortfolioFromUrl(userId: string, input: NewPortfolioMeta & { url: string }): Promise<PortfolioInfo> {
  const url = cleanUrl(input.url);
  const row = await createRow(userId, {
    id: newId(),
    title: cleanTitle(input.title) || defaultPortfolioTitle({ url }),
    description: cleanDescription(input.description),
    kind: "url",
    url,
  });
  return toPortfolioInfo(row);
}

// ---------------------------------------------------------------------------
// 바꾸기
// ---------------------------------------------------------------------------

/** 이름·설명 고치기. 남의 포트폴리오면 null. 이름을 빈 값으로 보내면 이름은 그대로 둔다. */
export async function updatePortfolio(
  userId: string,
  id: string,
  patch: { title?: string; description?: string | null },
): Promise<PortfolioInfo | null> {
  const data: { updatedAt: Date; title?: string; description?: string | null } = { updatedAt: new Date() };
  if (patch.title !== undefined && cleanTitle(patch.title)) data.title = cleanTitle(patch.title);
  if (patch.description !== undefined) data.description = cleanDescription(patch.description);
  const [row] = await prisma.portfolio.updateManyAndReturn({ where: { id, userId }, data });
  return row ? toPortfolioInfo(row as PortfolioRow) : null;
}

/**
 * 내용을 새 파일 텍스트로 바꾼다(있던 파일·링크는 대체). 남의 포트폴리오면 null.
 * 텍스트는 새 키에 저장하고, DB가 새 키를 가리킨 뒤 이 요청이 읽은 옛 텍스트를 지운다. DB 쓰기가 실패하거나 행이 사라졌으면 새 텍스트를 지운다.
 */
export async function replacePortfolioFile(
  userId: string,
  id: string,
  file: { fileName: string; text: string },
): Promise<{ portfolio: PortfolioInfo; truncated: boolean } | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const { text, truncated } = cleanText(file.text);
  const key = portfolioTextKey(userId, id);
  await putObject(key, text, { contentType: "text/plain; charset=utf-8" });
  let updated: unknown;
  try {
    [updated] = await prisma.portfolio.updateManyAndReturn({
      where: { id, userId },
      data: { kind: "file", fileName: cleanFileName(file.fileName), url: null, textKey: key, chars: text.length, updatedAt: new Date() },
    });
  } catch (err) {
    await dropText(key);
    throw err;
  }
  if (!updated) {
    await dropText(key);
    return null;
  }
  if (row.textKey && row.textKey !== key) await dropText(row.textKey);
  return { portfolio: toPortfolioInfo(updated as PortfolioRow), truncated };
}

/** 내용을 링크로 바꾼다(있던 파일 텍스트는 지운다). 남의 포트폴리오면 null. */
export async function replacePortfolioUrl(userId: string, id: string, url: string): Promise<PortfolioInfo | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const [updated] = await prisma.portfolio.updateManyAndReturn({
    where: { id, userId },
    data: { kind: "url", fileName: null, url: cleanUrl(url), textKey: null, chars: null, updatedAt: new Date() },
  });
  if (!updated) return null;
  await dropText(row.textKey);
  return toPortfolioInfo(updated as PortfolioRow);
}

/**
 * 지우기: 행을 먼저 지우고(첨부한 이력서는 FK SET NULL로 떨어진다) 텍스트와 users/<u>/portfolios/<id>/ 아래 객체를 지운다.
 * 객체 삭제가 실패해도 포트폴리오는 이미 사라졌으므로 로그만 남긴다. 남의 것이면 null, 지웠으면 떨어진 이력서 수.
 */
export async function deletePortfolio(userId: string, id: string): Promise<{ detached: number } | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const detached = await prisma.companyResume.count({ where: { userId, portfolioId: id } });
  const { count } = await prisma.portfolio.deleteMany({ where: { id, userId } });
  if (count === 0) return null;
  try {
    const keys = new Set<string>(row.textKey ? [row.textKey] : []);
    for (const k of await listByPrefix(userPrefix(userId, "portfolios", id))) keys.add(k);
    for (const k of keys) await deleteObject(k);
  } catch (err) {
    console.error("[deletePortfolio] 저장소 객체 삭제 실패", id, err);
  }
  return { detached };
}

/** 저장소 키 중 포트폴리오가 쓰고 있는 것(이력서를 지울 때 남길 키). */
export async function portfolioKeysInUse(userId: string, keys: readonly string[]): Promise<Set<string>> {
  if (keys.length === 0) return new Set();
  const rows = await prisma.portfolio.findMany({ select: { textKey: true }, where: { userId, textKey: { in: [...keys] } } });
  return new Set(rows.map((r) => r.textKey).filter((k): k is string => !!k));
}
