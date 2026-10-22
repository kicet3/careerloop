/**
 * 진단 API 응답 타입. 클라이언트 컴포넌트도 import하므로 server-only 코드를 두지 않는다.
 */
import type { DiagnosisStatus, StageKey, StageStatus } from "@/lib/domain/schemas";
import type { ReportModel } from "@/lib/report/types";

export type DiagnosisListItem = {
  id: string;
  title: string;
  targetRole: string;
  status: DiagnosisStatus;
  /** 7명 중 긍정 판정 수. 심사위원 7명이 모두 끝나지 않았으면 null. */
  positiveCount: number | null;
  /** JD 적합도 점수(fit 단계). 미완료면 null. */
  matchScore: number | null;
  /** 서버에서는 Date, JSON 응답(GET /api/diagnoses)에서는 ISO 문자열. */
  createdAt: Date;
  hasJd: boolean;
};

/** GET /api/diagnoses/[id] 응답 JSON. */
export type DiagnosisStatusResponse = {
  id: string;
  status: DiagnosisStatus;
  error: string | null;
  title: string;
  shareToken: string | null;
  stages: { stage: StageKey; status: StageStatus; error: string | null }[];
  /** status==='done'일 때만. Date 필드는 ISO 문자열로 직렬화되어 온다. */
  report: ReportModel | null;
};

/** POST /api/diagnoses 성공 응답. */
export type CreateDiagnosisResponse = { id: string; warnings: string[] };

/** 모든 진단 API의 오류 응답. */
export type ApiErrorResponse = { error: string };
