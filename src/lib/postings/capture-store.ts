import "server-only";
/**
 * 공고 원문 캡처 상태 저장(shared_postings.capture_*)과 저장소 키. 찍는 코드는 ./capture.ts(작업 묶음 C).
 *
 * 상태 흐름: (null|failed|멈춘 작업|done+force) --requestCapture--> pending --claimCapture--> running
 *   --recordCaptureSuccess--> done  /  --recordCaptureFailure--> failed
 * 모든 전이는 조건부 UPDATE라 여러 인스턴스가 같은 공고를 동시에 찍지 않는다. 이미지는 공용 공고당 한 장(다시 찍으면 덮어쓴다).
 */
import { prisma } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { SharedPostingRow } from "@/lib/db/types";
import {
  captureExtension,
  POSTING_CAPTURE,
  type PostingCaptureInfo,
  type PostingCaptureMime,
} from "@/lib/domain/posting-capture";
import { sharedPostingKey } from "@/lib/storage";

/** shared-postings/<id>/capture.webp(또는 .jpg). */
export function postingCaptureKey(sharedPostingId: string, mime: PostingCaptureMime = "image/webp"): string {
  return sharedPostingKey(sharedPostingId, `capture.${captureExtension(mime)}`);
}

type CaptureCols = Pick<
  SharedPostingRow,
  | "captureStatus"
  | "captureKey"
  | "captureMime"
  | "captureBytes"
  | "captureWidth"
  | "captureHeight"
  | "capturedAt"
  | "captureError"
  | "captureAttempts"
  | "captureStartedAt"
>;

export const CAPTURE_SELECT = {
  captureStatus: true,
  captureKey: true,
  captureMime: true,
  captureBytes: true,
  captureWidth: true,
  captureHeight: true,
  capturedAt: true,
  captureError: true,
  captureAttempts: true,
  captureStartedAt: true,
} as const;

function isStale(row: Pick<CaptureCols, "captureStatus" | "captureStartedAt">, now: number): boolean {
  return (
    (row.captureStatus === "pending" || row.captureStatus === "running") &&
    (!row.captureStartedAt || now - row.captureStartedAt.getTime() > POSTING_CAPTURE.staleMs)
  );
}

/** 행 → 화면 정보(순수). 멈춘 pending/running은 'failed'로 보여 다시 시도할 수 있게 한다. */
export function toCaptureInfo(row: CaptureCols, now: number = Date.now()): PostingCaptureInfo {
  const stale = isStale(row, now);
  const status = stale ? "failed" : (row.captureStatus ?? "none");
  const done = row.captureStatus === "done" && !!row.captureKey;
  return {
    status: row.captureStatus === "done" && !row.captureKey ? "none" : status,
    capturedAt: done ? (row.capturedAt?.getTime() ?? null) : null,
    mime: done ? row.captureMime : null,
    bytes: done ? row.captureBytes : null,
    width: done ? row.captureWidth : null,
    height: done ? row.captureHeight : null,
    error: stale ? "캡처가 끝나지 않았습니다. 다시 시도해 주세요." : row.captureStatus === "failed" ? row.captureError : null,
    retryable: (stale || row.captureStatus === "failed" || row.captureStatus == null) && row.captureAttempts < POSTING_CAPTURE.maxAttempts,
  };
}

/**
 * 캡처 예약: 요청한 적 없음·실패(시도 상한 전)·멈춘 작업이면 'pending'으로 두고 true. force면 'done'도 다시 찍는다(다시 가져오기).
 * 이미 pending/running(멈추지 않음)이거나 상한에 닿았으면 false. 레이트 리밋은 호출자(라우트·가져오기)가 POSTING_CAPTURE_*_LIMIT로 센다.
 */
export async function requestCapture(sharedPostingId: string, opts: { force?: boolean; now?: number } = {}): Promise<boolean> {
  const now = opts.now ?? Date.now();
  const staleBefore = new Date(now - POSTING_CAPTURE.staleMs);
  const { count } = await prisma.sharedPosting.updateMany({
    where: {
      id: sharedPostingId,
      OR: [
        { captureStatus: null },
        { captureStatus: "failed", captureAttempts: { lt: POSTING_CAPTURE.maxAttempts } },
        { captureStatus: { in: ["pending", "running"] }, OR: [{ captureStartedAt: null }, { captureStartedAt: { lt: staleBefore } }] },
        ...(opts.force ? [{ captureStatus: "done" }] : []),
      ],
    },
    data: { captureStatus: "pending", captureStartedAt: new Date(now), captureError: null, ...(opts.force ? { captureAttempts: 0 } : {}) },
  });
  return count > 0;
}

/** 찍기 시작: 'pending'(또는 멈춘 running)을 'running'으로 맡고 시도 수를 올린다. 맡았으면 url을, 아니면 null. */
export async function claimCapture(sharedPostingId: string, now: number = Date.now()): Promise<{ url: string; attempt: number } | null> {
  const staleBefore = new Date(now - POSTING_CAPTURE.staleMs);
  const [row] = await prisma.sharedPosting.updateManyAndReturn({
    where: {
      id: sharedPostingId,
      OR: [{ captureStatus: "pending" }, { captureStatus: "running", captureStartedAt: { lt: staleBefore } }],
    },
    data: { captureStatus: "running", captureStartedAt: new Date(now), captureAttempts: { increment: 1 } },
    select: { url: true, captureAttempts: true },
  });
  return row ? { url: row.url, attempt: row.captureAttempts } : null;
}

export interface CaptureResult {
  key: string;
  mime: PostingCaptureMime;
  bytes: number;
  width: number;
  height: number;
}

/** 성공 기록('running'일 때만). 시도 수는 0으로. */
export async function recordCaptureSuccess(sharedPostingId: string, r: CaptureResult, now: number = Date.now()): Promise<boolean> {
  const { count } = await prisma.sharedPosting.updateMany({
    where: { id: sharedPostingId, captureStatus: "running" },
    data: {
      captureStatus: "done",
      captureKey: r.key,
      captureMime: r.mime,
      captureBytes: r.bytes,
      captureWidth: r.width,
      captureHeight: r.height,
      capturedAt: new Date(now),
      captureError: null,
      captureAttempts: 0,
      captureStartedAt: null,
    },
  });
  return count > 0;
}

/** 실패 기록('running'일 때만). 이전에 성공한 이미지(captureKey·capturedAt)는 지우지 않는다 — 화면은 status로 판단. */
export async function recordCaptureFailure(sharedPostingId: string, error: string): Promise<boolean> {
  const { count } = await prisma.sharedPosting.updateMany({
    where: { id: sharedPostingId, captureStatus: "running" },
    data: { captureStatus: "failed", captureError: stripNul(error.slice(0, 300)), captureStartedAt: null },
  });
  return count > 0;
}

/** 캡처 정보(공용 공고가 없으면 null). 접근 권한은 canViewCapture로 따로 확인한다. */
export async function getCaptureInfo(sharedPostingId: string, now: number = Date.now()): Promise<PostingCaptureInfo | null> {
  const row = await prisma.sharedPosting.findUnique({ where: { id: sharedPostingId }, select: CAPTURE_SELECT });
  return row ? toCaptureInfo(row as CaptureCols, now) : null;
}

/** 이미지 라우트용: 저장소 키·형식. 캡처가 없으면 null. */
export async function getCaptureObject(sharedPostingId: string): Promise<{ key: string; mime: PostingCaptureMime; capturedAt: number | null } | null> {
  const row = (await prisma.sharedPosting.findUnique({ where: { id: sharedPostingId }, select: CAPTURE_SELECT })) as CaptureCols | null;
  if (!row?.captureKey || !row.captureMime) return null;
  return { key: row.captureKey, mime: row.captureMime, capturedAt: row.capturedAt?.getTime() ?? null };
}

/**
 * 캡처를 볼 수 있는지: 관리자, 공고 찾기에 보이는(숨기지 않은) 공고, 또는 이 공용 공고를 보관함에 담은 사용자.
 * (승인·동의 확인은 requireApiUser가 이미 했다.)
 */
export async function canViewCapture(userId: string, sharedPostingId: string, opts: { isAdmin?: boolean } = {}): Promise<boolean> {
  const row = await prisma.sharedPosting.findUnique({ where: { id: sharedPostingId }, select: { hiddenAt: true } });
  if (!row) return false;
  if (opts.isAdmin || !row.hiddenAt) return true;
  return (await prisma.jobPosting.count({ where: { userId, sharedPostingId } })) > 0;
}

/** 내 보관 공고 → 공용 공고 id(캡처 대상). 직접 입력 공고·남의 공고면 null. */
export async function sharedIdForPosting(userId: string, postingId: string): Promise<string | null> {
  const p = await prisma.jobPosting.findFirst({ where: { id: postingId, userId }, select: { sharedPostingId: true } });
  return p?.sharedPostingId ?? null;
}
