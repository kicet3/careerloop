import "server-only";
/**
 * 포트폴리오 보관함(portfolios). 사용자마다 개수 제한 없이 보관하고, 이력서는 그중 하나를 첨부한다
 * (company_resumes.portfolio_id, 포트폴리오를 지우면 FK SET NULL로 떨어진다).
 *
 * - 파일은 올린 원본을 users/<u>/portfolios/<id>/original-<꼬리>.<확장자>에 그대로 보관하고(키·MIME·크기는 original_*, 화면에 그대로
 *   보여 준다 — GET /api/portfolios/[id]/original), AI용으로 뽑은 텍스트를 users/<u>/portfolios/<id>/text-<꼬리>.txt에 둔다(키는 portfolios.text_key).
 *   글을 뽑지 못한 파일(이미지 등)은 text_key null·chars 0. 원본 보관 전에 올린 항목은 original_* 가 null(글만 있다).
 *   예전 이력서 첨부에서 옮긴 항목은 users/<u>/resumes/<이력서 id>/portfolio-<꼬리>.txt를 쓴다 —
 *   이력서를 지울 때 그 키는 남기고(resumes/service.ts deleteResume), 포트폴리오를 지우거나 내용을 바꿀 때 지운다.
 * - 링크는 주소만 저장한다(서버가 그 주소를 열지 않는다).
 * - 'graph'는 경험 그래프에서 AI가 쓴 Markdown 본문을 파일 텍스트와 같은 자리(text_key)에 두고, 생성 정보는 graph_source에 둔다
 *   (만들기·다시 만들기는 graph-jobs.ts, 본문 고치기는 updatePortfolioText).
 * - 모든 함수는 userId 소유권을 확인한다. 남의 포트폴리오는 null/false(라우트에서 404).
 * - 상한은 만들 때 사용자별 잠금 안에서 확인한다(createRow). 목록은 상한을 넘는 행(옛 첨부에서 옮긴 것)도 모두 보여 준다.
 * - 파일 읽기·레이트 리밋·업로드 크기 검사는 라우트(src/lib/portfolios/http.ts)가 한다. 여기는 저장만.
 */
import { randomUUID } from "node:crypto";
import { customAlphabet } from "nanoid";
import type { Prisma } from "@/generated/prisma/client";
import { prisma, Prisma as PrismaNs } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { PortfolioRow } from "@/lib/db/types";
import {
  MAX_PORTFOLIO_DESCRIPTION_CHARS,
  MAX_PORTFOLIO_TEXT_CHARS,
  MAX_PORTFOLIO_TITLE_CHARS,
  MAX_PORTFOLIO_URL_CHARS,
  PORTFOLIO_KINDS,
  portfolioHasText,
  portfolioOriginalView,
  type PortfolioInfo,
  type PortfolioListItem,
  type PortfolioResumeRef,
} from "@/lib/domain/portfolios";
import { countPortfolioAddMarkers, parseGraphPortfolioSource, type GraphPortfolioSourceInput } from "@/lib/domain/graph-portfolio";
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

/** 원본 파일 키. 텍스트와 같은 이유로 업로드마다 새 꼬리를 쓴다. */
export function portfolioOriginalKey(userId: string, portfolioId: string, ext: string, nonce: string = newNonce()): string {
  return userKey(userId, "portfolios", portfolioId, `original-${nonce}.${ext}`);
}

/**
 * 보관할 원본. 형식 확인(original.ts detectPortfolioFile)은 호출자가 마쳤다.
 * source.bytes: 서버가 확인한 바로 그 바이트(multipart로 받았거나 R2 임시 키에서 내려받아 확인한 것).
 * source.stagedKey: 브라우저가 R2에 바로 올린 임시 키(uploads/<u>/...) — 원본은 확인한 bytes로 새로 쓰고 임시 키는 지우기만 한다.
 * (임시 키를 서버 쪽 복사로 옮기지 않는다: 서명 주소가 살아 있는 동안 확인과 복사 사이에 다른 바이트로 덮어쓸 수 있다.)
 */
export interface PortfolioOriginalInput {
  ext: string;
  mime: string;
  size: number;
  source: { bytes: Uint8Array; stagedKey?: string };
}

async function storeOriginal(userId: string, portfolioId: string, original: PortfolioOriginalInput): Promise<string> {
  const key = portfolioOriginalKey(userId, portfolioId, original.ext);
  const { bytes, stagedKey } = original.source;
  // 임시 키는 호출자가 세션 사용자 id로 만든 uploads/<userId>/... 뿐이다(남의 임시 파일을 건드리지 않는다).
  if (stagedKey !== undefined && !stagedKey.startsWith(`uploads/${userId}/`)) throw new Error("임시 업로드 키가 이 사용자의 것이 아닙니다.");
  await putObject(key, bytes, { contentType: original.mime });
  if (stagedKey) await dropText(stagedKey);
  return key;
}

/** 텍스트(있으면)와 원본(있으면)을 저장한다. 뽑은 글이 비었으면 텍스트는 저장하지 않는다(키 null). */
async function storeFileContent(
  userId: string,
  portfolioId: string,
  text: string,
  original: PortfolioOriginalInput | undefined,
): Promise<{ textKey: string | null; originalKey: string | null }> {
  const textKey = text ? portfolioTextKey(userId, portfolioId) : null;
  if (textKey) await putObject(textKey, text, { contentType: "text/plain; charset=utf-8" });
  let originalKey: string | null = null;
  try {
    if (original) originalKey = await storeOriginal(userId, portfolioId, original);
  } catch (err) {
    await dropText(textKey);
    throw err;
  }
  return { textKey, originalKey };
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
    chars: portfolioHasText(kind) ? (row.chars ?? null) : null,
    original:
      kind === "file" && row.originalKey && row.originalMime
        ? { mime: row.originalMime, size: row.originalSize ?? 0, view: portfolioOriginalView(row.originalMime) }
        : null,
    graphSource: kind === "graph" ? parseGraphPortfolioSource(row.graphSource) : null,
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

async function createRow(userId: string, data: Omit<Prisma.PortfolioUncheckedCreateInput, "userId">): Promise<PortfolioRow> {
  return (await prisma.portfolio.create({ data: { ...data, userId } })) as PortfolioRow;
}

// ---------------------------------------------------------------------------
// 조회
// ---------------------------------------------------------------------------

/** 내 포트폴리오(최근 수정 순) + 각각을 첨부한 이력서. */
export async function listPortfolios(userId: string): Promise<PortfolioListItem[]> {
  const rows = await prisma.portfolio.findMany({
    where: { userId },
    // 개수 상한이 없으므로 자르지 않는다 — 보이지 않는 항목은 지울 수도 없다.
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

/** 저장해 둔 텍스트(kind 'file' | 'graph'). 링크거나 저장소에서 사라졌으면 null. */
export async function readPortfolioText(row: Pick<PortfolioRow, "kind" | "textKey">): Promise<string | null> {
  if (!portfolioHasText(row.kind) || !row.textKey) return null;
  const buf = await getObject(row.textKey);
  return buf ? buf.toString("utf8") : null;
}

/** 보관한 원본의 위치·형식(소유자만, 내용은 읽지 않는다). 남의 것·없는 것·원본이 없는 항목(링크·그래프·예전 파일)이면 null. */
export interface PortfolioOriginalRef {
  key: string;
  mime: string;
  size: number;
  fileName: string;
  portfolio: PortfolioInfo;
}

export async function getPortfolioOriginalRef(userId: string, id: string): Promise<PortfolioOriginalRef | null> {
  const row = await ownedRow(userId, id);
  if (!row || row.kind !== "file" || !row.originalKey || !row.originalMime) return null;
  // 키가 이 사용자 접두사인지 한 번 더 본다(행의 user_id와 키가 어긋나는 일은 없어야 하지만 남의 객체를 내주지 않게).
  if (!row.originalKey.startsWith(`users/${userId}/`)) return null;
  return {
    key: row.originalKey,
    mime: row.originalMime,
    size: row.originalSize ?? 0,
    fileName: row.fileName ?? "portfolio",
    portfolio: toPortfolioInfo(row),
  };
}

/**
 * 보관한 원본 파일(소유자만). 남의 것·없는 것·원본이 없는 항목(링크·그래프·예전 파일)·저장소에서 사라졌으면 null.
 */
export async function getPortfolioOriginal(
  userId: string,
  id: string,
): Promise<{ bytes: Buffer; mime: string; fileName: string; portfolio: PortfolioInfo } | null> {
  const ref = await getPortfolioOriginalRef(userId, id);
  if (!ref) return null;
  const bytes = await getObject(ref.key);
  if (!bytes) return null;
  return { bytes, mime: ref.mime, fileName: ref.fileName, portfolio: ref.portfolio };
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
 * 파일로 새 포트폴리오: 원본(있으면)과 뽑은 텍스트를 저장하고 행을 만든다. 텍스트는 MAX_PORTFOLIO_TEXT_CHARS까지(넘으면 truncated),
 * 글을 뽑지 못했으면(text "") 텍스트 없이 원본만. 행을 못 만들면 방금 저장한 객체를 지운다.
 */
export async function createPortfolioFromFile(
  userId: string,
  input: NewPortfolioMeta & { fileName: string; text: string; original?: PortfolioOriginalInput },
): Promise<{ portfolio: PortfolioInfo; truncated: boolean }> {
  const id = newId();
  const fileName = cleanFileName(input.fileName);
  const { text, truncated } = cleanText(input.text);
  const stored = await storeFileContent(userId, id, text, input.original);
  try {
    const row = await createRow(userId, {
      id,
      title: cleanTitle(input.title) || defaultPortfolioTitle({ fileName }),
      description: cleanDescription(input.description),
      kind: "file",
      fileName,
      textKey: stored.textKey,
      chars: text.length,
      originalKey: stored.originalKey,
      originalMime: stored.originalKey ? input.original!.mime : null,
      originalSize: stored.originalKey ? input.original!.size : null,
    });
    return { portfolio: toPortfolioInfo(row), truncated };
  } catch (err) {
    await dropText(stored.textKey);
    await dropText(stored.originalKey);
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
 * 내용을 새 파일로 바꾼다(있던 파일·링크는 대체). 남의 포트폴리오면 null.
 * 텍스트·원본은 새 키에 저장하고, DB가 새 키를 가리킨 뒤 이 요청이 읽은 옛 텍스트·원본을 지운다.
 * DB 쓰기가 실패하거나 행이 사라졌으면 새로 저장한 객체를 지운다.
 * 읽은 뒤 다른 요청(다른 탭·재시도)이 먼저 내용을 바꿨으면(textKey·originalKey가 달라짐) 새로 저장한 객체를 지우고 "conflict" —
 * 그러지 않으면 먼저 쓴 요청의 새 원본·텍스트를 아무 행도 가리키지 않은 채 저장소에 남긴다.
 */
export async function replacePortfolioFile(
  userId: string,
  id: string,
  file: { fileName: string; text: string; original?: PortfolioOriginalInput },
): Promise<{ portfolio: PortfolioInfo; truncated: boolean } | "conflict" | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const { text, truncated } = cleanText(file.text);
  const stored = await storeFileContent(userId, id, text, file.original);
  const dropNew = async () => {
    await dropText(stored.textKey);
    await dropText(stored.originalKey);
  };
  let updated: unknown;
  try {
    [updated] = await prisma.portfolio.updateManyAndReturn({
      where: { id, userId, textKey: row.textKey, originalKey: row.originalKey },
      data: {
        kind: "file",
        fileName: cleanFileName(file.fileName),
        url: null,
        textKey: stored.textKey,
        chars: text.length,
        originalKey: stored.originalKey,
        originalMime: stored.originalKey ? file.original!.mime : null,
        originalSize: stored.originalKey ? file.original!.size : null,
        graphSource: PrismaNs.DbNull,
        updatedAt: new Date(),
      },
    });
  } catch (err) {
    await dropNew();
    throw err;
  }
  if (!updated) {
    await dropNew();
    return (await ownedRow(userId, id)) ? "conflict" : null;
  }
  if (row.textKey && row.textKey !== stored.textKey) await dropText(row.textKey);
  if (row.originalKey && row.originalKey !== stored.originalKey) await dropText(row.originalKey);
  return { portfolio: toPortfolioInfo(updated as PortfolioRow), truncated };
}

/** 내용을 링크로 바꾼다(있던 파일 텍스트·원본은 지운다). 남의 포트폴리오면 null. */
export async function replacePortfolioUrl(userId: string, id: string, url: string): Promise<PortfolioInfo | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const [updated] = await prisma.portfolio.updateManyAndReturn({
    where: { id, userId },
    data: {
      kind: "url",
      fileName: null,
      url: cleanUrl(url),
      textKey: null,
      chars: null,
      originalKey: null,
      originalMime: null,
      originalSize: null,
      graphSource: PrismaNs.DbNull,
      updatedAt: new Date(),
    },
  });
  if (!updated) return null;
  await dropText(row.textKey);
  await dropText(row.originalKey);
  return toPortfolioInfo(updated as PortfolioRow);
}

// ---------------------------------------------------------------------------
// 경험 그래프 포트폴리오(kind 'graph')
// ---------------------------------------------------------------------------

function sourceJson(source: GraphPortfolioSourceInput, text: string): PrismaNs.InputJsonValue {
  return {
    projectIds: source.projectIds.slice(0, 50),
    postingId: source.postingId,
    notes: stripNul(source.notes).slice(0, 2000),
    missingInfo: source.missingInfo.map((m) => stripNul(m).slice(0, 500)).slice(0, 50),
    generatedAt: source.generatedAt,
    addMarkers: countPortfolioAddMarkers(text),
    templateId: source.templateId ?? null,
  };
}

/**
 * AI가 쓴 본문으로 새 'graph' 포트폴리오. 본문을 먼저 저장하고 행을 만든다(실패하면 본문을 지운다).
 * 호출자(graph-jobs.ts)가 그래프 소유·프로젝트 확인을 마친 뒤 부른다.
 */
export async function createGraphPortfolio(
  userId: string,
  input: { title: string; description?: string | null; text: string; source: GraphPortfolioSourceInput },
): Promise<{ portfolio: PortfolioInfo; truncated: boolean }> {
  const id = newId();
  const { text, truncated } = cleanText(input.text);
  const key = portfolioTextKey(userId, id);
  await putObject(key, text, { contentType: "text/markdown; charset=utf-8" });
  try {
    const row = await createRow(userId, {
      id,
      title: cleanTitle(input.title) || "경험 그래프 포트폴리오",
      description: cleanDescription(input.description),
      kind: "graph",
      textKey: key,
      chars: text.length,
      graphSource: sourceJson(input.source, text),
    });
    return { portfolio: toPortfolioInfo(row), truncated };
  } catch (err) {
    await dropText(key);
    throw err;
  }
}

/** commit 확인이 거절해 본문 바꾸기를 되돌렸다. */
class ReplaceAborted extends Error {}

export type ReplacePortfolioTextResult =
  | { portfolio: PortfolioInfo; truncated: boolean }
  /** 남의 것·없는 것 */
  | null
  /** 그래프 포트폴리오가 아니다 */
  | "not_graph"
  /** 읽은 뒤 다른 저장이 먼저 본문을 바꿨다(새 본문은 지웠다) */
  | "conflict"
  /** commit 확인이 false — 아무것도 바꾸지 않았다 */
  | "aborted";

/**
 * 본문 바꾸기: 새 키에 저장 → 한 트랜잭션에서 행이 '읽은 옛 키'를 그대로 가리킬 때만(compare-and-swap) 새 키로 바꾸고 → 옛 본문을 지운다.
 * 동시에 두 쪽이 쓰면 늦은 쪽은 'conflict'(새 본문을 지운다) — 한쪽 본문이 고아로 남거나 말없이 덮이지 않는다.
 * - source를 주면(다시 만들기) 생성 정보를 바꾼다. 주지 않으면(직접 고치기) 생성 정보는 두고 [ADD] 자리 수만 다시 세며,
 *   자리가 하나도 남지 않으면 AI가 남긴 '채워야 할 정보' 목록도 비운다.
 * - commit(tx)은 같은 트랜잭션 안에서 행을 바꾼 뒤 부른다. false면 되돌리고 'aborted'(작업 완료 기록·실행 중 작업 확인용).
 */
export async function replacePortfolioText(
  userId: string,
  id: string,
  rawText: string,
  opts: { source?: GraphPortfolioSourceInput; commit?: (tx: Prisma.TransactionClient) => Promise<boolean> } = {},
): Promise<ReplacePortfolioTextResult> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  if (row.kind !== "graph") return "not_graph";
  const { text, truncated } = cleanText(rawText);
  let graphSource: PrismaNs.InputJsonValue | undefined;
  if (opts.source) graphSource = sourceJson(opts.source, text);
  else {
    const prev = parseGraphPortfolioSource(row.graphSource);
    if (prev) {
      const addMarkers = countPortfolioAddMarkers(text);
      graphSource = sourceJson({ ...prev, missingInfo: addMarkers === 0 ? [] : prev.missingInfo }, text);
    }
  }
  const key = portfolioTextKey(userId, id);
  await putObject(key, text, { contentType: "text/markdown; charset=utf-8" });
  let updated: PortfolioRow | undefined;
  try {
    updated = await prisma.$transaction(async (tx) => {
      const [next] = await tx.portfolio.updateManyAndReturn({
        where: { id, userId, kind: "graph", textKey: row.textKey },
        data: { textKey: key, chars: text.length, updatedAt: new Date(), ...(graphSource ? { graphSource } : {}) },
      });
      if (!next) return undefined;
      if (opts.commit && !(await opts.commit(tx))) throw new ReplaceAborted();
      return next as PortfolioRow;
    });
  } catch (err) {
    await dropText(key);
    if (err instanceof ReplaceAborted) return "aborted";
    throw err;
  }
  if (!updated) {
    await dropText(key);
    const current = await ownedRow(userId, id);
    if (!current) return null;
    return current.kind === "graph" ? "conflict" : "not_graph";
  }
  if (row.textKey && row.textKey !== key) await dropText(row.textKey);
  return { portfolio: toPortfolioInfo(updated), truncated };
}

/**
 * 지우기: 행을 먼저 지우고(첨부한 이력서는 FK SET NULL로 떨어진다) 텍스트·원본과 users/<u>/portfolios/<id>/ 아래 객체를 지운다.
 * 객체 삭제가 실패해도 포트폴리오는 이미 사라졌으므로 로그만 남긴다. 남의 것이면 null, 지웠으면 떨어진 이력서 수.
 */
export async function deletePortfolio(userId: string, id: string): Promise<{ detached: number } | null> {
  const row = await ownedRow(userId, id);
  if (!row) return null;
  const detached = await prisma.companyResume.count({ where: { userId, portfolioId: id } });
  const { count } = await prisma.portfolio.deleteMany({ where: { id, userId } });
  if (count === 0) return null;
  try {
    const keys = new Set<string>([row.textKey, row.originalKey].filter((k): k is string => !!k));
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
