import "server-only";
/**
 * GET /api/insights와 내 진단 화면의 인사이트 카드가 쓰는 집계 진입점. DB에서 지원·이벤트·보관 공고·진단 점수를 읽어
 * 순수 함수(insights.ts)에 넘긴다. 공고는 postings 모듈을 거치지 않고 표에서 제안에 필요한 열만 읽는다.
 */
import { and, desc, eq, ne } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobPostings } from "@/lib/db/schema";
import type { InsightsResponse } from "@/lib/domain/applications";
import { buildSuggestions, companyRollup, resumePerformance, responseRate, stageFunnel, type InsightPosting } from "./insights";
import { listApplications, listEvents, matchScoresFor } from "./service";

/** 제안에 쓰는 보관 공고 수 상한(마감 정리 안 된 공고부터 최근 수정순). */
const MAX_POSTINGS_FOR_SUGGESTIONS = 500;

async function openPostings(userId: string): Promise<InsightPosting[]> {
  const rows = await db
    .select({
      id: jobPostings.id,
      company: jobPostings.company,
      roleTitle: jobPostings.roleTitle,
      status: jobPostings.status,
      deadline: jobPostings.deadline,
      deadlineTime: jobPostings.deadlineTime,
      deadlineKind: jobPostings.deadlineKind,
    })
    .from(jobPostings)
    .where(and(eq(jobPostings.userId, userId), ne(jobPostings.status, "closed")))
    .orderBy(desc(jobPostings.updatedAt))
    .limit(MAX_POSTINGS_FOR_SUGGESTIONS);
  return rows.map((r) => ({ ...r, deadline: r.deadline ?? "", deadlineTime: r.deadlineTime ?? "" }));
}

export async function getInsights(userId: string, now: number = Date.now()): Promise<InsightsResponse> {
  const [apps, postings] = await Promise.all([listApplications(userId), openPostings(userId)]);
  const [events, scores] = await Promise.all([listEvents(apps.map((a) => a.id)), matchScoresFor(userId, apps)]);
  return {
    responseRate: responseRate(apps, events),
    funnel: stageFunnel(apps, events),
    resumePerformance: resumePerformance(apps, events),
    companies: companyRollup(apps, scores),
    suggestions: buildSuggestions({ applications: apps, postings, events, now }),
  };
}
