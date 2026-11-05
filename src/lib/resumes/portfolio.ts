import "server-only";
/**
 * 이력서 첨부 포트폴리오(이력서당 하나). 파일은 원본을 보관하지 않고 ingest(src/lib/ingest/extract.ts)로 뽑은 텍스트만
 * 저장소 users/<userId>/resumes/<resumeId>/portfolio-<업로드마다 다른 꼬리>.txt에 두고(키는 company_resumes.portfolio_text_key), 파일 이름·글자 수는 company_resumes.portfolio_*에 둔다.
 * URL 첨부는 주소만 저장한다(서버가 그 주소를 읽지 않는다). 이력서를 지우면 같은 접두사라 함께 지워진다(deleteResume).
 *
 * 파일 읽기·레이트 리밋(RESUME_PORTFOLIO_UPLOAD_LIMIT)·업로드 크기 검사는 라우트(작업 묶음 B)가 한다. 여기는 저장만.
 */
import { randomUUID } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { CompanyResume } from "@/lib/db/types";
import { MAX_RESUME_PORTFOLIO_CHARS, type ResumePortfolioInfo } from "@/lib/domain/resumes";
import { deleteObject, getObject, putObject, userKey } from "@/lib/storage";
import { toPortfolioInfo, toResumeMeta } from "./service";
import type { ResumeMeta } from "./types";

/**
 * 업로드마다 새 키를 쓴다. 같은 키를 다시 쓰면, 동시에 URL로 바꾸기·떼기가 옛 키를 지울 때 방금 올린 새 텍스트까지
 * 지워 DB는 'file'인데 텍스트가 없는 상태가 된다. 키가 다르면 지우는 쪽은 늘 자기가 읽은 옛 텍스트만 지운다.
 */
export function portfolioTextKey(userId: string, resumeId: string, nonce: string = newNonce()): string {
  return userKey(userId, "resumes", resumeId, `portfolio-${nonce}.txt`);
}

function newNonce(): string {
  return `${Date.now().toString(36)}${randomUUID().replace(/-/g, "").slice(0, 8)}`;
}

async function ownedRow(userId: string, resumeId: string): Promise<CompanyResume | null> {
  return ((await prisma.companyResume.findFirst({ where: { id: resumeId, userId } })) as CompanyResume | null) ?? null;
}

async function dropText(key: string | null): Promise<void> {
  if (!key) return;
  try {
    await deleteObject(key);
  } catch (err) {
    console.error("[portfolio] 텍스트 삭제 실패", key, err);
  }
}

/**
 * 파일에서 뽑은 텍스트로 포트폴리오를 바꾼다(있던 파일·URL은 대체). 텍스트는 MAX_RESUME_PORTFOLIO_CHARS까지 저장한다.
 * 남의 이력서면 null. 텍스트는 새 키에 저장하고, DB가 새 키를 가리킨 뒤 이 요청이 읽은 옛 텍스트를 지운다.
 * DB 쓰기가 실패하거나 행이 사라졌으면 방금 저장한 새 텍스트를 지운다.
 */
export async function setPortfolioFile(
  userId: string,
  resumeId: string,
  file: { fileName: string; text: string },
): Promise<{ resume: ResumeMeta; truncated: boolean } | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  const clean = stripNul(file.text).trim();
  const truncated = clean.length > MAX_RESUME_PORTFOLIO_CHARS;
  const text = truncated ? clean.slice(0, MAX_RESUME_PORTFOLIO_CHARS) : clean;
  const key = portfolioTextKey(userId, resumeId);
  await putObject(key, text, { contentType: "text/plain; charset=utf-8" });
  const now = new Date();
  let updated: unknown;
  try {
    [updated] = await prisma.companyResume.updateManyAndReturn({
      where: { id: resumeId, userId },
      data: {
        portfolioKind: "file",
        portfolioFileName: stripNul(file.fileName.slice(0, 200)),
        portfolioUrl: null,
        portfolioTextKey: key,
        portfolioChars: text.length,
        portfolioUpdatedAt: now,
        updatedAt: now,
      },
    });
  } catch (err) {
    await dropText(key);
    throw err;
  }
  if (!updated) {
    await dropText(key);
    return null;
  }
  if (row.portfolioTextKey && row.portfolioTextKey !== key) await dropText(row.portfolioTextKey);
  return { resume: toResumeMeta(updated as CompanyResume), truncated };
}

/** URL로 포트폴리오를 바꾼다(있던 파일 텍스트는 지운다). url은 호출자가 http/https 검증(ResumePortfolioUrlSchema). 남의 이력서면 null. */
export async function setPortfolioUrl(userId: string, resumeId: string, url: string): Promise<ResumeMeta | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  const now = new Date();
  const [updated] = await prisma.companyResume.updateManyAndReturn({
    where: { id: resumeId, userId },
    data: {
      portfolioKind: "url",
      portfolioFileName: null,
      portfolioUrl: stripNul(url.trim().slice(0, 2048)),
      portfolioTextKey: null,
      portfolioChars: null,
      portfolioUpdatedAt: now,
      updatedAt: now,
    },
  });
  if (!updated) return null;
  await dropText(row.portfolioTextKey);
  return toResumeMeta(updated as CompanyResume);
}

/** 포트폴리오 떼기. 남의 이력서면 null. */
export async function removePortfolio(userId: string, resumeId: string): Promise<ResumeMeta | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  const [updated] = await prisma.companyResume.updateManyAndReturn({
    where: { id: resumeId, userId },
    data: {
      portfolioKind: null,
      portfolioFileName: null,
      portfolioUrl: null,
      portfolioTextKey: null,
      portfolioChars: null,
      portfolioUpdatedAt: null,
      updatedAt: new Date(),
    },
  });
  if (!updated) return null;
  await dropText(row.portfolioTextKey);
  return toResumeMeta(updated as CompanyResume);
}

/**
 * 첨부 정보 + 텍스트(면접 질문 생성·진단 프리필용). 포트폴리오가 없으면 { info: null, text: null }, 남의 이력서면 null.
 * URL 첨부는 text null(주소만 있다). 파일 텍스트가 저장소에서 사라졌으면 text null.
 */
export async function getPortfolioText(
  userId: string,
  resumeId: string,
): Promise<{ info: ResumePortfolioInfo | null; text: string | null } | null> {
  const row = await ownedRow(userId, resumeId);
  if (!row) return null;
  const info = toPortfolioInfo(row);
  if (info?.kind !== "file" || !row.portfolioTextKey) return { info, text: null };
  const buf = await getObject(row.portfolioTextKey);
  return { info, text: buf ? buf.toString("utf8") : null };
}
