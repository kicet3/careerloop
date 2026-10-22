import type { FieldErrors } from "./validation";

/** 인증 API 실패 응답 형식: { error, fieldErrors? } */
export function authError(status: number, error: string, fieldErrors?: FieldErrors, headers?: HeadersInit) {
  return Response.json(fieldErrors ? { error, fieldErrors } : { error }, { status, headers });
}

export async function readJson(req: Request): Promise<unknown> {
  try {
    return await req.json();
  } catch {
    return null;
  }
}
