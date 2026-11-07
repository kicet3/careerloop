import "server-only";
/**
 * 이력서 임시 저장(resume_edit_drafts): 새 버전을 만들지 않고 이어서 고칠 작업본을 이력서당 하나 둔다.
 *
 * - 소유자만 읽고 쓴다(모든 쿼리에 userId 조건, 남의 이력서는 null → 라우트 404).
 * - 본문은 버전과 같은 스키마(StoredResumeDocumentSchema)로 검증해 JSONB에 둔다. 예전 모양으로 저장된 작업본도 읽을 때 보정한다.
 * - baseVersionId는 작업을 시작한 버전. 현재 버전과 달라도 받는다(그 사이 AI 다듬기 적용·다른 탭 저장 등) — 응답의
 *   currentVersionId로 화면이 충돌을 알리고, 사용자가 '유지'(최신 버전 위에 저장)나 '버리기'를 고른다. 말없이 덮어쓰지 않는다.
 * - '저장(새 버전)'·복원은 saveVersion(clearEditDraft)이 현재 버전을 옮기는 트랜잭션에서 지운다.
 * - 작업본은 사용자의 개인 작업 사본이다: 미리보기 공유·PDF·지원 제출본은 저장된 버전만 쓴다.
 */
import { FeatureError } from "@/lib/api/errors";
import { prisma, type Prisma } from "@/lib/db/client";
import { isUniqueViolation } from "@/lib/db/errors";
import { parseResumeDocument, ResumeDocumentSchema, ResumeTemplateIdSchema } from "@/lib/domain/resumes";
import type { ResumeEditDraftResponse, ResumeEditDraftView, SaveResumeEditDraft } from "./types";

type DraftRow = { baseVersionId: string | null; templateId: string | null; document: unknown; updatedAt: Date };

function toView(row: DraftRow): ResumeEditDraftView | null {
  const parsed = parseResumeDocument(row.document);
  if (!parsed.success) return null;
  const template = ResumeTemplateIdSchema.safeParse(row.templateId);
  return {
    baseVersionId: row.baseVersionId,
    templateId: template.success ? template.data : null,
    document: parsed.data,
    updatedAt: row.updatedAt.getTime(),
  };
}

async function ownedResume(userId: string, resumeId: string): Promise<{ currentVersionId: string | null } | null> {
  return prisma.companyResume.findFirst({ select: { currentVersionId: true }, where: { id: resumeId, userId } });
}

/** 임시 저장본 + 현재 버전 id. 남의 이력서면 null. 저장본을 읽을 수 없으면(형식 깨짐) 없는 것으로 본다. */
export async function getEditDraft(userId: string, resumeId: string): Promise<ResumeEditDraftResponse | null> {
  const resume = await ownedResume(userId, resumeId);
  if (!resume) return null;
  const row = await prisma.resumeEditDraft.findFirst({ where: { resumeId, userId } });
  return { draft: row ? toView(row) : null, currentVersionId: resume.currentVersionId };
}

/**
 * 임시 저장(있으면 덮어쓴다). 남의 이력서면 null. baseVersionId는 이 이력서의 버전이어야 한다(아니면 400).
 * expectedUpdatedAt을 주면(편집 화면) 서버의 작업본이 그 뒤에 다른 탭·기기에서 바뀌었을 때 덮어쓰지 않고 { clashAt }을 돌려준다(라우트 409).
 * 작업본이 없으면(다른 곳에서 새 버전 저장·버리기) 이 내용으로 새로 만든다 — 화면의 작업을 잃지 않게.
 */
export async function putEditDraft(
  userId: string,
  resumeId: string,
  input: SaveResumeEditDraft,
): Promise<ResumeEditDraftResponse | { clashAt: number } | null> {
  const resume = await ownedResume(userId, resumeId);
  if (!resume) return null;
  if (input.baseVersionId !== null) {
    const base = await prisma.resumeVersion.findFirst({ select: { id: true }, where: { id: input.baseVersionId, resumeId } });
    if (!base) throw new FeatureError("기준 버전을 찾을 수 없습니다. 새로고침한 뒤 다시 시도해 주세요.", 400);
  }
  const document = ResumeDocumentSchema.parse(input.document) as unknown as Prisma.InputJsonValue;
  const data = { baseVersionId: input.baseVersionId, templateId: input.templateId ?? null, document, updatedAt: new Date() };
  const expected = input.expectedUpdatedAt;
  if (expected === undefined) {
    const row = await prisma.resumeEditDraft.upsert({
      where: { resumeId },
      create: { resumeId, userId, ...data },
      // 이력서 행이 userId 소유임을 위에서 확인했다. 그래도 남의 작업본 행은 건드리지 않게 userId도 맞춘다.
      update: { ...data, userId },
    });
    return { draft: toView(row), currentVersionId: resume.currentVersionId };
  }
  const existing = await prisma.resumeEditDraft.findFirst({ select: { updatedAt: true }, where: { resumeId, userId } });
  if (existing) {
    if (existing.updatedAt.getTime() !== expected) return { clashAt: existing.updatedAt.getTime() };
    // 확인과 쓰기 사이에 다른 요청이 끼어들어도 덮어쓰지 않게 updatedAt을 조건으로 건다.
    const { count } = await prisma.resumeEditDraft.updateMany({ where: { resumeId, userId, updatedAt: existing.updatedAt }, data });
    if (count === 0) return clashNow(userId, resumeId);
  } else {
    try {
      await prisma.resumeEditDraft.create({ data: { resumeId, userId, ...data } });
    } catch (err) {
      if (isUniqueViolation(err)) return clashNow(userId, resumeId);
      throw err;
    }
  }
  const row = await prisma.resumeEditDraft.findFirst({ where: { resumeId, userId } });
  return { draft: row ? toView(row) : null, currentVersionId: resume.currentVersionId };
}

async function clashNow(userId: string, resumeId: string): Promise<{ clashAt: number }> {
  const row = await prisma.resumeEditDraft.findFirst({ select: { updatedAt: true }, where: { resumeId, userId } });
  return { clashAt: row?.updatedAt.getTime() ?? 0 };
}

/** 임시 저장본 버리기. 남의 이력서면 false(없던 작업본도 true). */
export async function deleteEditDraft(userId: string, resumeId: string): Promise<boolean> {
  const resume = await ownedResume(userId, resumeId);
  if (!resume) return false;
  await prisma.resumeEditDraft.deleteMany({ where: { resumeId, userId } });
  return true;
}

/** 목록 배지용: 작업본이 있는 이력서 id. */
export async function resumeIdsWithEditDraft(userId: string, resumeIds: readonly string[]): Promise<Set<string>> {
  if (resumeIds.length === 0) return new Set();
  const rows = await prisma.resumeEditDraft.findMany({ select: { resumeId: true }, where: { userId, resumeId: { in: [...resumeIds] } } });
  return new Set(rows.map((r) => r.resumeId));
}
