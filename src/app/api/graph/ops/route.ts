import { z } from "zod";
import type { ApplyOpsResponse } from "@/components/graph/api";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { ensureDatabase } from "@/lib/db/migrate";
import { BodyTooLargeError, readBodyLimited } from "@/lib/diagnoses/body";
import { jsonError } from "@/lib/diagnoses/http";
import { GraphOpSchema, MAX_OPS_PER_BATCH } from "@/lib/domain/graph";
import { applyGraphOps, getCareerGraph, graphEnabled } from "@/lib/graph/service";

export const runtime = "nodejs";

/** 연산 60개 × 긴 설명 몇 개를 넉넉히 담는 크기. 이보다 크면 읽지 않는다. */
const MAX_BODY_BYTES = 256 * 1024;

const BodySchema = z.object({ ops: z.array(GraphOpSchema).min(1).max(MAX_OPS_PER_BATCH) });

/** zod 오류를 "변경 #n: 경로 메시지" 한 줄로. 화면에 그대로 보인다. */
function describeIssues(err: z.ZodError): string {
  const issue = err.issues[0];
  if (!issue) return "변경 내용이 올바르지 않습니다.";
  const [root, index, ...rest] = issue.path;
  if (root === "ops" && typeof index === "number") {
    const where = rest.length ? ` (${rest.join(".")})` : "";
    return `변경 #${index + 1}${where}: 형식이 올바르지 않습니다.`;
  }
  if (issue.code === "too_big") return `한 번에 적용할 수 있는 변경은 ${MAX_OPS_PER_BATCH}개까지입니다.`;
  if (issue.code === "too_small") return "적용할 변경이 없습니다.";
  return "변경 내용이 올바르지 않습니다.";
}

/**
 * 변경 연산(GraphOp[])을 한 트랜잭션으로 적용하고 갱신된 그래프를 돌려준다.
 * 형식은 엄격한 GraphOpSchema로, 존재·소유권·관계 방향은 applyGraphOps가 검사한다(하나라도 틀리면 400, 아무것도 안 씀).
 */
export async function POST(req: Request) {
  await ensureDatabase();
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  if (!graphEnabled()) return jsonError("경력 그래프 저장소(Neo4j)가 설정되지 않았습니다.", 503);

  let raw: unknown;
  try {
    // Content-Length 없는 chunked 본문도 바이트를 세며 읽다가 한도를 넘으면 끊는다.
    const bytes = await readBodyLimited(req, MAX_BODY_BYTES);
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch (err) {
    if (err instanceof BodyTooLargeError) return jsonError("요청이 너무 큽니다.", 413);
    return jsonError("요청 형식이 올바르지 않습니다. JSON으로 보내 주세요.", 400);
  }
  const parsed = BodySchema.safeParse(raw);
  if (!parsed.success) return jsonError(describeIssues(parsed.error), 400);

  try {
    const result = await applyGraphOps(user.id, parsed.data.ops);
    const graph = await getCareerGraph(user.id, { personName: user.name });
    const body: ApplyOpsResponse = { ...result, graph };
    return Response.json(body, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/graph/ops");
  }
}
