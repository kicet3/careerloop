import "server-only";
/**
 * 공고 ↔ 경력 그래프 대조 서비스. 공고·진단은 SQLite에서 userId 조건으로 읽고, 그래프는 getCareerGraph(userId)로 한 번 읽어
 * 순수 함수(match.ts)로 대조한다. Neo4j에 공고·요구 관계를 쓰지 않는다.
 * 요구 기술은 그 공고에 연결된 진단 중 JD 분석(jd 단계)이 끝난 가장 최근 것을 우선 쓴다(진단 전체가 실패했어도 jd 단계가 끝났으면 쓴다).
 */
import { and, desc, eq, inArray, ne } from "drizzle-orm";
import { FeatureError } from "@/lib/api/errors";
import { db } from "@/lib/db/client";
import { diagnoses, diagnosisStages, jobPostings } from "@/lib/db/schema";
import { type JdAnalysis, JdAnalysisSchema } from "@/lib/domain/schemas";
import { graphEnabled } from "./client";
import { GraphUnavailableError } from "./errors";
import {
  aggregateSkillGap,
  matchGraphToRequirements,
  type PostingMatchResponse,
  requirementsFromJd,
  type SkillGapResponse,
} from "./match";
import { getCareerGraph } from "./service";

/** 스킬 갭 집계에 넣는 공고 수 상한(마감 제외, 최근 갱신 순). */
export const SKILL_GAP_POSTING_LIMIT = 50;
export const SKILL_GAP_TOP = 20;

function assertGraph(): void {
  if (!graphEnabled()) throw new GraphUnavailableError();
}

/** 공고별 가장 최근 JD 분석. 사용자 소유 진단만 본다. */
async function latestJdAnalyses(userId: string, postingIds: string[]): Promise<Map<string, { diagnosisId: string; jd: JdAnalysis }>> {
  const out = new Map<string, { diagnosisId: string; jd: JdAnalysis }>();
  if (postingIds.length === 0) return out;
  const rows = await db
    .select({ postingId: diagnoses.postingId, diagnosisId: diagnoses.id, output: diagnosisStages.output })
    .from(diagnoses)
    .innerJoin(diagnosisStages, eq(diagnosisStages.diagnosisId, diagnoses.id))
    .where(
      and(
        eq(diagnoses.userId, userId),
        inArray(diagnoses.postingId, postingIds),
        eq(diagnosisStages.stage, "jd"),
        eq(diagnosisStages.status, "done"),
      ),
    )
    .orderBy(desc(diagnosisStages.finishedAt), desc(diagnoses.createdAt));
  for (const r of rows) {
    if (!r.postingId || out.has(r.postingId)) continue;
    // 예전 형식이거나 깨진 출력은 건너뛰고 다음(더 오래된) 진단을 본다.
    const parsed = JdAnalysisSchema.safeParse(r.output);
    if (parsed.success) out.set(r.postingId, { diagnosisId: r.diagnosisId, jd: parsed.data });
  }
  return out;
}

/** 공고 하나를 내 경력 그래프와 대조한다. 남의 공고·없는 공고는 404. */
export async function matchPosting(userId: string, postingId: string): Promise<PostingMatchResponse> {
  assertGraph();
  const [posting] = await db
    .select({ id: jobPostings.id, company: jobPostings.company, roleTitle: jobPostings.roleTitle, jdText: jobPostings.jdText })
    .from(jobPostings)
    .where(and(eq(jobPostings.id, postingId), eq(jobPostings.userId, userId)))
    .limit(1);
  if (!posting) throw new FeatureError("공고를 찾을 수 없습니다.", 404);

  const [analyses, graph] = await Promise.all([latestJdAnalyses(userId, [posting.id]), getCareerGraph(userId)]);
  const analysis = analyses.get(posting.id) ?? null;
  const { source, requirements } = requirementsFromJd(analysis?.jd ?? null, posting.jdText);
  return {
    postingId: posting.id,
    company: posting.company,
    roleTitle: posting.roleTitle,
    source,
    diagnosisId: source === "diagnosis" ? (analysis?.diagnosisId ?? null) : null,
    graphEmpty: graph.nodes.length === 0,
    ...matchGraphToRequirements(graph, requirements),
  };
}

/** 마감 아닌 보관 공고(최근 갱신 50개)들이 요구하지만 내 그래프에 없는 기술 Top N. */
export async function skillGapAcrossPostings(userId: string, { limit = SKILL_GAP_TOP }: { limit?: number } = {}): Promise<SkillGapResponse> {
  assertGraph();
  const postings = await db
    .select({ id: jobPostings.id, company: jobPostings.company, roleTitle: jobPostings.roleTitle, jdText: jobPostings.jdText })
    .from(jobPostings)
    .where(and(eq(jobPostings.userId, userId), ne(jobPostings.status, "closed")))
    .orderBy(desc(jobPostings.updatedAt))
    .limit(SKILL_GAP_POSTING_LIMIT);

  const [analyses, graph] = await Promise.all([
    latestJdAnalyses(
      userId,
      postings.map((p) => p.id),
    ),
    getCareerGraph(userId),
  ]);

  const rows = postings.flatMap((p) => {
    const { requirements } = requirementsFromJd(analyses.get(p.id)?.jd ?? null, p.jdText);
    if (requirements.length === 0) return [];
    return [{ postingId: p.id, company: p.company, roleTitle: p.roleTitle, items: matchGraphToRequirements(graph, requirements).items }];
  });
  return { items: aggregateSkillGap(rows, limit), postingsConsidered: rows.length, graphEmpty: graph.nodes.length === 0 };
}
