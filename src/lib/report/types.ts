/**
 * 보고서 모델: 웹 보고서(components/report/*)와 PDF(report/pdf.tsx), Markdown 내보내기(report/markdown.ts)가
 * 공통으로 소비하는 "렌더링 직전" 데이터. report/model.ts의 buildReportModel()이 DB 행에서 만든다.
 *
 * 렌더러는 이 타입만 보고 그리며, 판정 라벨·톤·인용 검증 같은 계산은 모두 빌더에서 끝낸다.
 */
import type { VerdictTone } from "@/lib/domain/reviewers";
import type {
  AtsResult,
  FitItem,
  GatekeeperResult,
  ImprovementPlan,
  JdAnalysis,
  Mistake,
  ReaderResult,
  Requirement,
  ReviewerId,
  RewriteResult,
  Situation,
} from "@/lib/domain/schemas";

/** 인용문 + 원문 존재 여부(검증 실패 시 보고서에 '원문 확인 필요' 표시). */
export interface CheckedQuote {
  text: string;
  verified: boolean;
}

export interface VerdictView {
  raw: string;
  label: string;
  tone: VerdictTone;
}

export interface ReviewerCard {
  id: ReviewerId;
  name: string;
  role: string;
  verdict: VerdictView;
  oneLiner: string;
  /** 리뷰어별 상세. kind로 구분해 렌더링한다. */
  detail:
    | { kind: "ats"; result: AtsResult; reasons: { quote: CheckedQuote; issue: string }[] }
    | {
        kind: "gatekeeper";
        result: GatekeeperResult;
        weakestLines: { quote: CheckedQuote; issue: string }[];
      }
    | {
        kind: "reader";
        result: ReaderResult;
        worstLine: { quote: CheckedQuote; issue: string };
      };
}

export interface FitRow {
  requirement: Requirement;
  /** requirement.jdQuote를 JD 원문과 대조한 결과(원문 그대로가 아니면 verified=false). 추정 요건이면 null. */
  jdQuote: CheckedQuote | null;
  priority: "must" | "nice";
  item: FitItem | null;
  evidence: CheckedQuote | null;
}

export interface MistakeView extends Omit<Mistake, "quote" | "flaggedBy"> {
  quote: CheckedQuote | null;
  flaggedBy: { id: ReviewerId; name: string }[];
}

export interface ReportModel {
  meta: {
    diagnosisId: string;
    title: string;
    targetRole: string;
    situation: Situation;
    situationLabel: string;
    hasJd: boolean;
    resumeFileName: string | null;
    /** 포트폴리오를 함께 심사했는지(이력서와 별개 자료). 이전 진단·고정 예시는 없을 수 있다. */
    hasPortfolio?: boolean;
    portfolioFileName?: string | null;
    createdAt: Date;
    completedAt: Date | null;
    model: string;
  };
  summary: {
    headline: string;
    /** 7명 중 긍정 판정 수 */
    positiveCount: number;
    totalReviewers: number;
    matchScore: number | null;
    atsBefore: VerdictView;
    atsAfter: VerdictView | null;
    strengths: string[];
    closestToReject: { reviewerName: string; why: string } | null;
  };
  reviewers: ReviewerCard[];
  jd: {
    analysis: JdAnalysis;
    rows: FitRow[];
    fitSummary: string;
    untappedStrengths: string[];
    counts: { met: number; partial: number; missing: number };
  } | null;
  mistakes: MistakeView[];
  plan: ImprovementPlan | null;
  rewrite:
    | (RewriteResult & {
        rescreen: AtsResult | null;
        /** 재심사 판정 근거. 인용은 재작성본(resumeMarkdown)과 대조한다. */
        rescreenReasons: { quote: CheckedQuote; issue: string }[];
      })
    | null;
  /** 원문(보고서 부록용) */
  originalResume: string;
}
