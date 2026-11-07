/** 테스트용 요청 스코프 만들기(DB 없이 AuthContext를 손으로 만든다). */
import type { AuthContext } from "../auth-context";
import type { SourceExistsElsewhere, SourceReader } from "../chunks/authoritative";
import { EvidenceRegistry } from "../registry";
import { RequestScope } from "../scope";
import { buildOwnedSnapshot } from "../snapshot";
import { memoryGraphs } from "./two-users";

export function fakeCtx(userId: string, requestId = `req_${userId}_${Math.random().toString(36).slice(2, 8)}`): AuthContext {
  return Object.freeze({
    principalUserId: userId,
    tenantId: userId,
    requestId,
    policyVersion: 1,
    dataVersion: BigInt(1),
    sourceVersion: BigInt(1),
    indexedSourceVersion: BigInt(1),
    startedAt: Date.now(),
  });
}

export async function fakeScope(
  userId: string,
  opts: { readSource?: SourceReader; sourceExistsElsewhere?: SourceExistsElsewhere; graphs?: ReturnType<typeof memoryGraphs>; requestId?: string } = {},
): Promise<RequestScope> {
  const graphs = opts.graphs ?? memoryGraphs();
  const ctx = fakeCtx(userId, opts.requestId);
  const snapshot = buildOwnedSnapshot(await graphs.load(userId), userId);
  return new RequestScope(ctx, snapshot, new EvidenceRegistry(ctx), {
    readSource: opts.readSource ?? (async () => null),
    sourceExistsElsewhere: opts.sourceExistsElsewhere ?? (async () => false),
  });
}
