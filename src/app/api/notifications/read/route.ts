import { z } from "zod";
import { featureErrorResponse } from "@/lib/api/errors";
import { assertSameOrigin, requireApiUser } from "@/lib/auth/session";
import { markNotificationsRead } from "@/lib/notifications/service";
import { readJsonInput } from "@/lib/resumes/http";

export const runtime = "nodejs";

const ReadInputSchema = z.union([
  z.object({ all: z.literal(true) }),
  z.object({ ids: z.array(z.string().trim().min(1).max(64)).min(1).max(100) }),
]);

/** 읽음 처리: { ids: [...] }(내 알림만) 또는 { all: true }. 응답은 바꾼 수와 남은 읽지 않은 수. */
export async function POST(req: Request) {
  const forbidden = assertSameOrigin(req);
  if (forbidden) return forbidden;
  const user = await requireApiUser();
  if (user instanceof Response) return user;
  try {
    const input = await readJsonInput(req, ReadInputSchema, 16 * 1024);
    const updated = await markNotificationsRead(user.id, "all" in input ? "all" : { ids: input.ids });
    return Response.json({ updated }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    return featureErrorResponse(err, "POST /api/notifications/read");
  }
}
