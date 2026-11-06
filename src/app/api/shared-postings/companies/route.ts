import { requireApiUser } from "@/lib/auth/session";
import { clampCompanyLimit, parseCompanyParam } from "@/lib/domain/company";
import { postingErrorResponse } from "@/lib/postings/http";
import { listSharedCompanyOptions } from "@/lib/postings/shared";

export const runtime = "nodejs";

/**
 * 공고 찾기 '회사' 필터의 회사 목록(숨기지 않은 공용 공고만 — 관리자도 같다). ?q=회사 이름 검색 &limit=개수(기본 20, 최대 50)
 * &include=고른 회사 키(여러 번·쉼표 목록). 응답 { options: { key, label, count }[] } — 공고 수 많은 순.
 */
export async function GET(req: Request) {
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  const sp = new URL(req.url).searchParams;
  try {
    const options = await listSharedCompanyOptions({
      q: (sp.get("q") ?? "").trim().slice(0, 100),
      limit: clampCompanyLimit(sp.get("limit")),
      include: parseCompanyParam(sp.getAll("include")),
    });
    return Response.json({ options }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return postingErrorResponse(err, "GET /api/shared-postings/companies");
  }
}
