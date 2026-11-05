import "server-only";
/**
 * 지원 폼의 선택지(내 보관 공고·이력서·완료 진단). 지원 현황 화면(서버 컴포넌트)이 한 번 읽어 클라이언트 폼에 넘긴다.
 * 공고는 postings 모듈을 거치지 않고 표에서 필요한 열만 읽는다(교차 지점 계약 — docs/CONTRACTS-career.md §7-0).
 */
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db/client";
import { jobPostings } from "@/lib/db/schema";
import { listDiagnoses } from "@/lib/diagnoses/service";
import type { PostingStatus } from "@/lib/domain/postings";
import { listResumes } from "@/lib/resumes/service";

export interface PostingOption {
  id: string;
  company: string;
  roleTitle: string;
  status: PostingStatus;
}
export interface ResumeOption {
  id: string;
  title: string;
  company: string;
  currentVersionNo: number | null;
}
export interface DiagnosisOption {
  id: string;
  title: string;
  matchScore: number | null;
}
export interface ApplicationFormOptions {
  postings: PostingOption[];
  resumes: ResumeOption[];
  diagnoses: DiagnosisOption[];
}

export async function listApplicationFormOptions(userId: string): Promise<ApplicationFormOptions> {
  const [postings, resumes, diagnoses] = await Promise.all([
    db
      .select({ id: jobPostings.id, company: jobPostings.company, roleTitle: jobPostings.roleTitle, status: jobPostings.status })
      .from(jobPostings)
      .where(eq(jobPostings.userId, userId))
      .orderBy(desc(jobPostings.updatedAt))
      .limit(500),
    listResumes(userId),
    listDiagnoses(userId),
  ]);
  return {
    postings,
    resumes: resumes.map((r) => ({ id: r.id, title: r.title, company: r.company, currentVersionNo: r.currentVersionNo })),
    diagnoses: diagnoses.filter((d) => d.status === "done").map((d) => ({ id: d.id, title: d.title, matchScore: d.matchScore ?? null })),
  };
}
