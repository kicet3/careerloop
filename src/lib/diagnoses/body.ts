/**
 * 요청 본문을 최대 maxBytes까지만 읽는다. Content-Length가 없는 chunked 요청도 바이트를 세다가 넘으면 즉시 끊는다
 * (req.formData()는 크기 제한 없이 본문 전체를 메모리에 올리므로 직접 부르지 않는다).
 */
export class BodyTooLargeError extends Error {
  constructor() {
    super("요청 본문이 너무 큽니다.");
    this.name = "BodyTooLargeError";
  }
}

export async function readBodyLimited(req: Request, maxBytes: number): Promise<Uint8Array<ArrayBuffer>> {
  const declared = req.headers.get("content-length");
  if (declared !== null && Number(declared) > maxBytes) throw new BodyTooLargeError();
  if (!req.body) return new Uint8Array();

  const reader = req.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new BodyTooLargeError();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

/** 크기 제한을 지키며 multipart/form-data를 읽는다. 넘으면 BodyTooLargeError, 형식이 틀리면 TypeError. */
export async function readFormDataLimited(req: Request, maxBytes: number): Promise<FormData> {
  const bytes = await readBodyLimited(req, maxBytes);
  const contentType = req.headers.get("content-type") ?? "";
  return new Response(bytes, { headers: { "content-type": contentType } }).formData();
}
