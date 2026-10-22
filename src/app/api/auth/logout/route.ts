import { assertSameOrigin, destroySession } from "@/lib/auth/session";

// POST만 받는다(GET 등은 Next가 405로 응답).
export async function POST(req: Request) {
  const bad = assertSameOrigin(req);
  if (bad) return bad;

  await destroySession();

  // <form method="post"> 제출이면 홈으로 보내고, fetch면 JSON으로 답한다.
  const contentType = req.headers.get("content-type") ?? "";
  if (contentType.includes("application/x-www-form-urlencoded") || contentType.includes("multipart/form-data")) {
    return new Response(null, { status: 303, headers: { Location: "/" } });
  }
  return Response.json({ ok: true });
}
