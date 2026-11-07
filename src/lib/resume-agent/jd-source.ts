import "server-only";
/**
 * "유저가 선택한 JD 분석"을 다시 쓴다(v2 r0.jd, 지원 동기 추천 버튼 — docs/RESUME-SECTION-AGENTS.md §2.1).
 *   1) 같은 공고의 저장된 진단 JD 분석(diagnosis_stages stage='jd' done, 진단 userId = 이 사용자, 진단 postingId = 공고) 중 최신.
 *   2) 같은 이력서의 이전(완료) 에이전트 작업의 r0.jd 출력('다시 생성').
 * 어느 쪽이든 JD 원문이 지금 JD와 같을 때만(공백 정리 후 sha256) 쓴다 — 사용자가 JD를 고쳤으면 다시 분석한다.
 * 모든 조회는 userId 조건이다(다른 사용자의 진단·작업은 보지 않는다). 출력은 JdAnalysisSchema로 다시 검증한다.
 */
import { prisma } from "@/lib/db/client";
import { JdAnalysisSchema, type JdAnalysis } from "@/lib/domain/schemas";
import { jdHash } from "./jd-hash";
import type { JdReuse } from "./schemas";

/** 진단 JD는 자르지 않고 저장되지만 에이전트 JD는 작업 시작 때 이만큼 자른다(jobs.ts AGENT_JD_MAX_CHARS와 같다). */
const AGENT_JD_MAX_CHARS = 12_000;

export interface ReusableJd {
  jd: JdAnalysis;
  reusedFrom: JdReuse;
}

export async function findReusableJdAnalysis(input: {
  userId: string;
  jdText: string;
  postingId?: string | null;
  /** 같은 이력서('다시 생성' 대상 또는 버튼을 누른 이력서). */
  resumeId?: string | null;
}): Promise<ReusableJd | null> {
  const want = jdHash(input.jdText);
  if (!input.jdText.trim()) return null;
  if (input.postingId) {
    const rows = await prisma.diagnosisStage.findMany({
      where: { stage: "jd", status: "done", diagnosis: { userId: input.userId, postingId: input.postingId } },
      // match-service.ts latestJdAnalyses와 같은 순서(NULLS LAST).
      orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { diagnosis: { createdAt: "desc" } }, { id: "desc" }],
      select: { output: true, finishedAt: true, diagnosis: { select: { id: true, jdText: true, userId: true } } },
      take: 10,
    });
    for (const r of rows) {
      if (r.diagnosis.userId !== input.userId) continue;
      if (jdHash((r.diagnosis.jdText ?? "").slice(0, AGENT_JD_MAX_CHARS)) !== want && jdHash(r.diagnosis.jdText) !== want) continue;
      const parsed = JdAnalysisSchema.safeParse(r.output);
      if (parsed.success) return { jd: parsed.data, reusedFrom: { kind: "diagnosis", id: r.diagnosis.id, at: r.finishedAt?.toISOString() ?? null } };
    }
  }
  if (input.resumeId) {
    const rows = await prisma.resumeAgentStep.findMany({
      where: {
        key: "r0.jd",
        status: "done",
        job: { userId: input.userId, status: "completed", OR: [{ resumeId: input.resumeId }, { targetResumeId: input.resumeId }] },
      },
      orderBy: [{ finishedAt: { sort: "desc", nulls: "last" } }, { id: "desc" }],
      select: { output: true, finishedAt: true, job: { select: { id: true, userId: true } } },
      take: 10,
    });
    for (const r of rows) {
      if (r.job.userId !== input.userId) continue;
      const out = r.output as { jd?: unknown; jdHash?: unknown } | null;
      if (!out || out.jdHash !== want) continue;
      const parsed = JdAnalysisSchema.safeParse(out.jd);
      if (parsed.success) return { jd: parsed.data, reusedFrom: { kind: "agent_job", id: r.job.id, at: r.finishedAt?.toISOString() ?? null } };
    }
  }
  return null;
}
