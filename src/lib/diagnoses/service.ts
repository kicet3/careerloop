import "server-only";
import { nanoid } from "nanoid";
import { prisma, type Tx } from "@/lib/db/client";
import { stripNul } from "@/lib/db/errors";
import type { Diagnosis, DiagnosisStage } from "@/lib/db/types";
import { REVIEWER_IDS, STAGE_KEYS, type DiagnosisInput, type StageKey } from "@/lib/domain/schemas";
import { isRetiredEngine, RETIRED_ENGINE_MESSAGE, type ProviderId } from "@/lib/domain/providers";
import { defaultProvider, modelNameFor } from "@/lib/llm";
import {
  dailyDiagnosisLimit,
  DEADLINE_STOP_ERROR,
  diagnosisSubtitle,
  diagnosisTitle,
  matchScoreOf,
  MAX_DEADLINE_CONTINUATIONS,
  MAX_RETRIES_PER_DIAGNOSIS,
  positiveCountOf,
  STALE_AFTER_MS,
} from "./summary";
import type { DiagnosisListItem } from "./types";
import type { DiagnosisPortfolio } from "./form";
import { DiagnosisServiceError } from "./errors";

export { DiagnosisServiceError };

export type { DiagnosisListItem, DiagnosisStatusResponse } from "./types";

const STALE_MESSAGE =
  "진단 실행이 중간에 끊겼습니다(서버 시간 제한 또는 재시작). 다시 시도하면 끝난 단계는 건너뛰고 이어서 진행합니다.";
const ACTIVE: ("queued" | "running")[] = ["queued", "running"];
const STAGE_ORDER = new Map<StageKey, number>(STAGE_KEYS.map((k, i) => [k, i]));

function sortStages(stages: DiagnosisStage[]): DiagnosisStage[] {
  return stages.sort((a, b) => (STAGE_ORDER.get(a.stage) ?? 99) - (STAGE_ORDER.get(b.stage) ?? 99));
}

async function loadStages(diagnosisId: string): Promise<DiagnosisStage[]> {
  const rows = await prisma.diagnosisStage.findMany({ where: { diagnosisId } });
  return sortStages(rows as DiagnosisStage[]);
}

/**
 * 사용자 단위 직렬화. SQLite는 쓰기를 한 번에 하나씩 처리해 '진행 중 확인 + 하루 건수 + 삽입'이 사실상 원자적이었지만,
 * Postgres READ COMMITTED에서는 동시 요청 둘이 모두 확인을 통과할 수 있다. 트랜잭션이 끝날 때 풀리는 advisory lock으로
 * 같은 사용자의 생성·재시도를 한 줄로 세운다(트랜잭션 풀러에서도 xact 잠금은 안전하다).
 */
async function lockUser(tx: Tx, userId: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`diagnosis:${userId}`}))`;
}

export async function getDiagnosisForUser(
  id: string,
  userId: string,
): Promise<{ diagnosis: Diagnosis; stages: DiagnosisStage[] } | null> {
  const diagnosis = await prisma.diagnosis.findFirst({ where: { id, userId } });
  if (!diagnosis) return null;
  return { diagnosis: diagnosis as Diagnosis, stages: await loadStages(id) };
}

export async function getDiagnosisByShareToken(
  token: string,
): Promise<{ diagnosis: Diagnosis; stages: DiagnosisStage[] } | null> {
  if (!token || token.length < 16) return null;
  const diagnosis = await prisma.diagnosis.findUnique({ where: { shareToken: token } });
  if (!diagnosis) return null;
  return { diagnosis: diagnosis as Diagnosis, stages: await loadStages(diagnosis.id) };
}

export async function listDiagnoses(userId: string): Promise<DiagnosisListItem[]> {
  const rows = (await prisma.diagnosis.findMany({
    select: {
      id: true,
      title: true,
      targetRole: true,
      status: true,
      createdAt: true,
      jdText: true,
      resumeFileName: true,
    },
    where: { userId },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
    take: 200,
  })) as Pick<Diagnosis, "id" | "title" | "targetRole" | "status" | "createdAt" | "jdText" | "resumeFileName">[];
  if (rows.length === 0) return [];

  const summaryStages: StageKey[] = [...REVIEWER_IDS, "fit", "jd"];
  const stageRows = (await prisma.diagnosisStage.findMany({
    select: { diagnosisId: true, stage: true, status: true, output: true },
    where: {
      diagnosisId: { in: rows.map((r) => r.id) },
      stage: { in: summaryStages },
      status: "done",
    },
  })) as Pick<DiagnosisStage, "diagnosisId" | "stage" | "status" | "output">[];
  const byDiagnosis = new Map<string, typeof stageRows>();
  for (const s of stageRows) {
    const list = byDiagnosis.get(s.diagnosisId) ?? [];
    list.push(s);
    byDiagnosis.set(s.diagnosisId, list);
  }

  return rows.map((r) => {
    const stages = byDiagnosis.get(r.id) ?? [];
    const hasJd = !!r.jdText;
    return {
      id: r.id,
      title: r.title,
      subtitle: diagnosisSubtitle({
        targetRole: r.targetRole,
        jdOutput: stages.find((s) => s.stage === "jd")?.output,
        resumeFileName: r.resumeFileName,
        hasJd,
      }),
      targetRole: r.targetRole,
      status: r.status,
      positiveCount: positiveCountOf(stages),
      matchScore: matchScoreOf(stages),
      createdAt: r.createdAt,
      hasJd,
    };
  });
}

/**
 * 진단 행 + 13개 단계 행(pending)을 만든다. 실행(runDiagnosis)은 호출자가 after()로 예약한다.
 * 제한: 사용자당 진행 중(queued/running) 1건(409), 최근 24시간 DAILY_DIAGNOSIS_LIMIT건(429).
 * 하루 제한은 실행 원장(diagnosis_runs)으로 센다 — 진단을 지워도 횟수가 돌아오지 않는다.
 * provider는 호출자가 검증한 엔진(providers/options.ts resolveRequestedProvider). 재시도도 이 엔진으로 한다.
 * 포트폴리오(선택)는 이력서와 별개 자료로 portfolio_text / portfolio_file_name에 저장한다.
 * postingId(선택)는 호출자가 소유권을 확인한 보관 공고 id다(진단의 JD 사본은 jdText에 따로 남는다).
 * 텍스트의 NUL(\u0000)은 Postgres가 받지 않으므로 저장 전에 지운다.
 */
export async function createDiagnosis(
  userId: string,
  input: DiagnosisInput & Partial<DiagnosisPortfolio> & { postingId?: string | null },
  provider: ProviderId = defaultProvider(),
): Promise<{ id: string }> {
  await markStaleRunsFailed(userId);
  const id = nanoid();
  const now = new Date();
  const limit = dailyDiagnosisLimit();
  const portfolioText = stripNul(input.portfolioText ?? null);
  const hasPortfolio = !!portfolioText?.trim();

  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const active = await tx.diagnosis.findFirst({
      select: { id: true },
      where: { userId, status: { in: ACTIVE } },
    });
    if (active) {
      throw new DiagnosisServiceError(
        "이미 진행 중인 진단이 있습니다. 끝난 뒤에 새 진단을 시작해 주세요.",
        409,
      );
    }
    const recent = await tx.diagnosisRun.count({
      where: { userId, kind: "create", createdAt: { gte: new Date(now.getTime() - 86_400_000) } },
    });
    if (recent >= limit) {
      throw new DiagnosisServiceError(
        `하루에 진단은 ${limit}건까지 할 수 있습니다(삭제한 진단도 셉니다). 24시간이 지나면 다시 시도해 주세요.`,
        429,
      );
    }

    await tx.diagnosis.create({
      data: {
        id,
        userId,
        title: stripNul(diagnosisTitle(input.targetRole, input.resumeFileName, now)),
        targetRole: stripNul(input.targetRole),
        situation: input.situation,
        notes: stripNul(input.notes ?? null),
        jdText: stripNul(input.jdText ?? null),
        resumeText: stripNul(input.resumeText),
        resumeFileName: stripNul(input.resumeFileName ?? null),
        portfolioText: hasPortfolio ? portfolioText : null,
        portfolioFileName: hasPortfolio ? stripNul(input.portfolioFileName ?? null) : null,
        postingId: input.postingId ?? null,
        status: "queued",
        model: modelNameFor(provider),
        provider,
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.diagnosisStage.createMany({
      data: STAGE_KEYS.map((stage) => ({ diagnosisId: id, stage, status: "pending" })),
    });
    await tx.diagnosisRun.create({ data: { userId, diagnosisId: id, kind: "create", createdAt: now } });
  });

  return { id };
}

/**
 * queued/running인데 updatedAt이 STALE_AFTER_MS 넘게 갱신되지 않은 진단을 failed로 바꾼다.
 * 실행 중에는 runner가 HEARTBEAT_MS마다 updatedAt을 갱신하므로, 이 조건은 실행 프로세스가 죽었다는 뜻이다
 * (함수 시간 초과·서버 재시작).
 * userId를 주면 그 사용자의 진단만 본다. 바꾼 건수를 반환.
 */
export async function markStaleRunsFailed(userId?: string): Promise<number> {
  const cutoff = new Date(Date.now() - STALE_AFTER_MS);
  const where = { status: { in: ACTIVE }, updatedAt: { lt: cutoff }, ...(userId ? { userId } : {}) };

  const stale = await prisma.diagnosis.findMany({ select: { id: true }, where });
  if (stale.length === 0) return 0;
  const ids = stale.map((s) => s.id);
  const now = new Date();

  await prisma.diagnosis.updateMany({
    where: { ...where, id: { in: ids } },
    data: { status: "failed", error: STALE_MESSAGE, updatedAt: now },
  });
  await prisma.diagnosisStage.updateMany({
    where: { diagnosisId: { in: ids }, status: "running" },
    data: { status: "failed", error: "시간 초과로 중단됨", finishedAt: now },
  });
  return ids.length;
}

/**
 * 삭제했으면 true, 없거나 남의 것이면 false. 진행 중(queued/running)인 진단은 409 — 실행 중인 파이프라인은
 * 취소할 수 없으므로, 삭제로 '동시 1건' 제한을 우회하지 못하게 막는다. 하루 제한은 원장(diagnosis_runs)으로 세므로
 * 삭제해도 줄지 않는다.
 * 자식 행은 FK가 정리한다: 단계 행·이 진단의 심사위원 채팅(스레드 → 메시지)은 cascade, 지원 기록의 진단 연결은 set null.
 */
export async function deleteDiagnosis(id: string, userId: string): Promise<boolean> {
  // 상태 확인과 삭제를 한 문장으로 해서, 확인 직후 재시도가 시작되는 경쟁을 막는다.
  const deleted = await prisma.diagnosis.deleteMany({ where: { id, userId, status: { notIn: ACTIVE } } });
  if (deleted.count === 0) {
    const row = await prisma.diagnosis.findFirst({ select: { id: true }, where: { id, userId } });
    if (!row) return false;
    throw new DiagnosisServiceError("진행 중인 진단은 삭제할 수 없습니다. 끝나거나 중단된 뒤에 삭제해 주세요.", 409);
  }
  return true;
}

/** 공유 토큰을 만들거나 이미 있으면 그대로 돌려준다. 완료된 진단만 공유할 수 있다. */
export async function setShareToken(id: string, userId: string): Promise<string> {
  const found = await getDiagnosisRow(id, userId);
  if (found.shareToken) return found.shareToken;
  if (found.status !== "done") {
    throw new DiagnosisServiceError("진단이 끝난 뒤에 공유 링크를 만들 수 있습니다.", 409);
  }
  const token = nanoid(21);
  await prisma.diagnosis.updateMany({ where: { id, userId }, data: { shareToken: token } });
  return token;
}

export async function clearShareToken(id: string, userId: string): Promise<void> {
  await getDiagnosisRow(id, userId);
  await prisma.diagnosis.updateMany({ where: { id, userId }, data: { shareToken: null } });
}

/**
 * 재시도 준비: 실패·중단된 단계를 pending으로 되돌리고 진단을 queued로. done 단계는 그대로 둬서 이어서 실행된다.
 * 한 트랜잭션 안에서 '다른 진행 중 진단 없음'을 확인하고 failed → queued로 조건부 전환한다(생성과 같은 사용자 잠금).
 * 진단 하나당 MAX_RETRIES_PER_DIAGNOSIS회까지(원장으로 센다). 호출자가 이후 after()로 runDiagnosis(id)를 예약한다.
 * 없앤 샘플(mock) 엔진으로 만든 예전 진단은 보기만 되고 재시도는 409로 막는다.
 *
 * continuation: 시간 예산에 걸려 멈춘 진단(DEADLINE_STOP_ERROR)의 자동 이어하기. 사용자 재시도 횟수를 쓰지 않고
 * 원장의 kind='continue'로 따로 MAX_DEADLINE_CONTINUATIONS회까지 센다. 시간 제한 멈춤이 아니면 409.
 */
export async function prepareRetry(id: string, userId: string, opts: { continuation?: boolean } = {}): Promise<void> {
  const kind = opts.continuation ? "continue" : "retry";
  await markStaleRunsFailed(userId);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    await lockUser(tx, userId);
    const found = await tx.diagnosis.findFirst({
      select: { status: true, error: true, provider: true, model: true },
      where: { id, userId },
    });
    if (!found) throw new DiagnosisServiceError("진단을 찾을 수 없습니다.", 404);
    if (isRetiredEngine(found)) throw new DiagnosisServiceError(RETIRED_ENGINE_MESSAGE, 409);
    if (found.status === "done") throw new DiagnosisServiceError("이미 완료된 진단입니다.", 409);
    if (found.status !== "failed") throw new DiagnosisServiceError("진단이 아직 진행 중입니다.", 409);
    if (opts.continuation && found.error !== DEADLINE_STOP_ERROR) {
      throw new DiagnosisServiceError("시간 제한으로 멈춘 진단만 자동으로 이어서 실행할 수 있습니다.", 409);
    }

    const other = await tx.diagnosis.findFirst({ select: { id: true }, where: { userId, status: { in: ACTIVE } } });
    if (other) {
      throw new DiagnosisServiceError("다른 진단이 진행 중입니다. 끝난 뒤에 다시 시도해 주세요.", 409);
    }

    const runs = await tx.diagnosisRun.count({ where: { diagnosisId: id, kind } });
    const cap = opts.continuation ? MAX_DEADLINE_CONTINUATIONS : MAX_RETRIES_PER_DIAGNOSIS;
    if (runs >= cap) {
      throw new DiagnosisServiceError(
        opts.continuation
          ? `시간 제한 뒤 자동 이어하기를 ${cap}번 모두 썼습니다. 재시도 버튼으로 다시 시도해 주세요.`
          : `이 진단은 이미 ${cap}번 재시도했습니다. 새 진단으로 다시 시작해 주세요.`,
        429,
      );
    }

    const switched = await tx.diagnosis.updateMany({
      where: { id, userId, status: "failed" },
      data: { status: "queued", error: null, updatedAt: now, completedAt: null },
    });
    if (switched.count === 0) throw new DiagnosisServiceError("진단 상태가 바뀌었습니다. 새로고침해 주세요.", 409);

    await tx.diagnosisStage.updateMany({
      where: { diagnosisId: id, status: { in: ["failed", "running"] } },
      data: { status: "pending", error: null, startedAt: null, finishedAt: null },
    });
    // 예전 버전에서 빠진 단계 행이 있으면 채운다.
    await tx.diagnosisStage.createMany({
      data: STAGE_KEYS.map((stage) => ({ diagnosisId: id, stage })),
      skipDuplicates: true,
    });
    await tx.diagnosisRun.create({ data: { userId, diagnosisId: id, kind, createdAt: now } });
  });
}

async function getDiagnosisRow(id: string, userId: string): Promise<Diagnosis> {
  const row = await prisma.diagnosis.findFirst({ where: { id, userId } });
  if (!row) throw new DiagnosisServiceError("진단을 찾을 수 없습니다.", 404);
  return row as Diagnosis;
}
