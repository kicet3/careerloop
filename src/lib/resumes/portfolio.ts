import "server-only";
/**
 * 이력서 첨부 포트폴리오(이력서당 하나): 포트폴리오 보관함(src/lib/portfolios/service.ts)의 항목을 company_resumes.portfolio_id로
 * 가리킨다. 붙이기·떼기는 연결만 바꾼다 — 떼도 보관함의 포트폴리오와 저장한 글은 그대로 남는다. 포트폴리오를 지우면 FK SET NULL로 떨어진다.
 */
import { prisma } from "@/lib/db/client";
import { isForeignKeyViolation } from "@/lib/db/errors";
import type { ResumePortfolioInfo } from "@/lib/domain/resumes";
import { readPortfolioText } from "@/lib/portfolios/service";
import { RESUME_INCLUDE, resumePortfolioInfo, toResumeMeta, type ResumeRow } from "./service";
import type { ResumeMeta } from "./types";

export type AttachPortfolioResult = { ok: true; resume: ResumeMeta } | { ok: false; reason: "resume_not_found" | "portfolio_not_found" };

/** 내 보관함의 포트폴리오를 이력서에 붙인다(있던 첨부는 대체 — 보관함 항목은 남는다). */
export async function attachPortfolio(userId: string, resumeId: string, portfolioId: string): Promise<AttachPortfolioResult> {
  const owned = await prisma.portfolio.findFirst({ select: { id: true }, where: { id: portfolioId, userId } });
  if (!owned) {
    const resume = await prisma.companyResume.findFirst({ select: { id: true }, where: { id: resumeId, userId } });
    return { ok: false, reason: resume ? "portfolio_not_found" : "resume_not_found" };
  }
  let row: unknown;
  try {
    [row] = await prisma.companyResume.updateManyAndReturn({
      where: { id: resumeId, userId },
      data: { portfolioId, updatedAt: new Date() },
      include: RESUME_INCLUDE,
    });
  } catch (err) {
    // 확인한 뒤 그 사이 포트폴리오가 지워졌다.
    if (isForeignKeyViolation(err)) return { ok: false, reason: "portfolio_not_found" };
    throw err;
  }
  if (!row) return { ok: false, reason: "resume_not_found" };
  return { ok: true, resume: toResumeMeta(row as ResumeRow) };
}

/** 첨부 떼기(보관함의 포트폴리오는 지우지 않는다). 남의 이력서면 null. */
export async function detachPortfolio(userId: string, resumeId: string): Promise<ResumeMeta | null> {
  const [row] = await prisma.companyResume.updateManyAndReturn({
    where: { id: resumeId, userId },
    data: { portfolioId: null, updatedAt: new Date() },
    include: RESUME_INCLUDE,
  });
  return row ? toResumeMeta(row as ResumeRow) : null;
}

/**
 * 첨부 정보 + 텍스트(면접 질문 생성·진단 프리필용). 첨부가 없으면 { info: null, text: null }, 남의 이력서면 null.
 * 링크 첨부는 text null(주소만 있다). 파일 텍스트가 저장소에서 사라졌으면 text null. 사용자가 적은 설명은 info.description.
 */
export async function getResumePortfolioText(
  userId: string,
  resumeId: string,
): Promise<{ info: ResumePortfolioInfo | null; text: string | null } | null> {
  const row = (await prisma.companyResume.findFirst({ where: { id: resumeId, userId }, include: RESUME_INCLUDE })) as ResumeRow | null;
  if (!row) return null;
  const info = resumePortfolioInfo(row);
  if (!row.portfolio || !info) return { info: null, text: null };
  return { info, text: await readPortfolioText(row.portfolio) };
}
